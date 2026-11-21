"""Check exact persisted routes and their MCP bindings, with optional native router oracles."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from framework_ast_cases import CASES
from mcp_fixture import McpSession


def read_catalog(root, case):
    database = root / '.septum/septum.db'
    with sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True) as db:
        raw = db.execute("SELECT value FROM repo_meta WHERE key = 'semantic_adapter_results'").fetchone()
        adapters = {item['id']: item['slices'] for item in json.loads(raw[0])}
        assert adapters.get(case.adapter, 0) > 0, adapters
        return sorted(db.execute('''
            SELECT http_method, route_uri, controller_file, controller_line, action_name
            FROM vertical_slices
            WHERE entry_kind != 'inferred_http_route'
            ORDER BY http_method, route_uri, controller_file, controller_line, action_name
        ''').fetchall())


def assert_routes(client, case, expected, negative=True):
    catalog = read_catalog(client.root, case)
    assert catalog == sorted(expected), (case.adapter, catalog, sorted(expected))
    responses = {}
    for method, uri, file, line, action in catalog:
        query = f'{method} {uri}'
        response = client.tool('septum_slice', {'query': query})
        assert response['status'] == 'success', (query, response)
        entry = response['entrypoint']
        assert (entry['method'], entry['uri'], entry['file'], entry['line'], entry['action']) == (
            method, uri, file, line, action,
        ), (query, response)
        bound = next(node for node in response['chain'] if node['stage'] == 'controller')
        assert (bound['file'], bound['line']) == (file, line), (query, bound)
        responses[query] = entry
    if negative:
        for query in case.negative_queries:
            response = client.tool('septum_slice', {'query': query})
            assert response['status'] == 'not_found', (query, response)
            responses[query] = response['status']
    return {'catalog': catalog, 'responses': responses}


def change_prefix(routes, old, new):
    return tuple((method, new + uri[len(old):] if uri.startswith(old) else uri, *rest)
                 for method, uri, *rest in routes)


def oracle(root, case, expected, extra, commands):
    command = commands.get(case.oracle_command)
    if not command:
        return {'status': 'not_run'}
    result = subprocess.run([*command, case.oracle_code], cwd=root, capture_output=True,
                            text=True, check=False, timeout=25)
    assert result.returncode == 0, (case.adapter, result.stdout, result.stderr)
    observed = sorted(tuple(row) for row in json.loads(result.stdout))
    comparison = sorted([(method, uri, action) for method, uri, _, _, action in expected] + list(extra))
    assert observed == comparison, (case.adapter, observed, comparison)
    return {'status': 'pass', 'routes': observed, 'runtime_only': extra}


def run_case(command, root, case, commands, js_modules):
    for file, source in case.files.items():
        destination = root / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(source)
    if case.oracle_command == 'javascript' and js_modules:
        (root / 'node_modules').symlink_to(js_modules, target_is_directory=True)

    file, before, after, old, new = case.edit
    changed = change_prefix(case.routes, old, new)
    assert changed != case.routes
    with McpSession(command, root) as client:
        client.tool('septum_map', {'action': 'register', 'domain': 'root', 'root': '.', 'ingest_now': True})
        initial = assert_routes(client, case, case.routes)
        initial['oracle'] = oracle(root, case, case.routes, case.runtime_only_routes, commands)
        target = root / file
        metadata = target.stat()
        source = target.read_text()
        assert source.count(before) == 1 and len(before.encode()) == len(after.encode()), case.adapter
        target.write_text(source.replace(before, after))
        os.utime(target, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))

        method, uri, *_ = next(row for row in changed if row not in case.routes)
        trigger = client.tool('septum_slice', {'query': f'{method} {uri}'})
        assert trigger['status'] == 'success' and trigger['entrypoint']['uri'] == uri, trigger
        refreshed = assert_routes(client, case, changed, negative=False)
        refreshed['oracle'] = oracle(root, case, changed, change_prefix(case.runtime_only_routes, old, new), commands)
    with McpSession(command, root) as client:
        reconnected = assert_routes(client, case, changed, negative=False)
    return {'initial': initial, 'refreshed': refreshed, 'reconnected': reconnected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--oracle-python', type=Path)
    parser.add_argument('--oracle-js-modules', type=Path)
    parser.add_argument('frameworks', nargs='*')
    args = parser.parse_args()
    unknown = set(args.frameworks) - CASES.keys()
    if unknown:
        parser.error(f'unknown frameworks {sorted(unknown)}')
    root = Path(__file__).resolve().parents[2]
    binary = args.binary.resolve()
    runtimes = {'source': ['bun', 'run', str(root / 'bin/septum.ts')], 'compiled': [str(binary)]}
    commands = {}
    if args.oracle_python:
        commands['python'] = [str(args.oracle_python.absolute()), '-B', '-c']
    js_modules = args.oracle_js_modules.resolve() if args.oracle_js_modules else None
    if js_modules:
        if not js_modules.is_dir():
            parser.error(f'JavaScript oracle modules directory not found: {js_modules}')
        commands['javascript'] = ['bun', '--no-install', '-e']
    report = {'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'runs': {}}
    try:
        with tempfile.TemporaryDirectory(prefix='septum-framework-ast-') as tmp:
            for runtime, command in runtimes.items():
                report['runs'][runtime] = {}
                for name in args.frameworks or CASES:
                    case = CASES[name]
                    result = run_case(command, Path(tmp) / runtime / name, case, commands, js_modules)
                    report['runs'][runtime][name] = result
                    print(runtime, name, 'PASS', 'oracle', result['initial']['oracle']['status'], flush=True)
    finally:
        args.output.write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
