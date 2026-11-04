"""Static-pattern MCP checks across registered adapters; no application execution.

A competing/corrupt catalog record is deliberately injected into each disposable
database to exercise recovery independently of framework extraction correctness.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from mcp_fixture import McpSession
from importlib.util import module_from_spec, spec_from_file_location

PROJECT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location('workflow', PROJECT / 'tests/integration/change-workflow.py')
workflow = module_from_spec(spec)
spec.loader.exec_module(workflow)
RecordedSession = workflow.RecordedSession


def manifests(fixture):
    framework = fixture['framework']
    if framework in ('nestjs', 'express', 'fastify', 'hono', 'elysia'):
        package = '@nestjs/core' if framework == 'nestjs' else framework
        return {'package.json': json.dumps({'dependencies': {package: '*'}})}
    if framework in ('fastapi', 'django', 'flask'):
        return {'requirements.txt': framework + '\n'}
    if fixture['adapter'] == 'golang':
        return {'go.mod': 'module fixture\n\ngo 1.22\n'}
    if framework == 'laravel':
        return {'artisan': '<?php\n', 'composer.json': json.dumps({'require': {'laravel/framework': '*'}, 'autoload': {'psr-4': {'App\\': 'app/'}}})}
    if framework == 'symfony':
        return {'composer.json': json.dumps({'require': {'symfony/framework-bundle': '*'}})}
    return {}


def run(command, fixture, root):
    for file, source in {**manifests(fixture), **fixture['files']}.items():
        path = root / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
    record = {'framework': fixture['framework'], 'requests': [],
              'scope': 'static adapter patterns plus injected catalog faults; versions not certified',
              'fixture': workflow.snapshot(root)}
    with RecordedSession(command, root, record['requests']) as client:
        listing = client.request('tools/list', {})
        schema = next(tool for tool in listing['tools'] if tool['name'] == 'septum_slice')['inputSchema']
        assert 'controller_file' in schema['properties']
        client.tool('septum_domain', {'action': 'register', 'domain': 'root', 'root': '.', 'ingest_now': True})
        invalid = client.request('tools/call', {'name': 'septum_slice', 'arguments': {
            'controller_file': 'orders.ts', 'workspace_path': str(root)}})
        assert invalid.get('isError'), invalid
        # One minimal route per fixture; CLI has a named command instead of HTTP.
        query = 'orders' if fixture['framework'] in ('cli', 'mcp-server') else 'GET /orders'
        first = client.tool('septum_slice', {'query': query})
        assert first['status'] == 'success', first
        # Registration may change observed config/directory inputs after its initial
        # ingestion. Complete the warm refresh before injecting catalog-only faults.
        for _ in range(2):
            first = client.tool('septum_slice', {'query': query})
            assert first['status'] == 'success', first
        target = first['entrypoint']
        query = f"{target['method']} {target['uri']}"
        db_path = root / '.septum/septum.db'
        with sqlite3.connect(db_path) as db:
            db.execute('''INSERT INTO vertical_slices
                (domain_id,feature_key,http_method,route_uri,route_name,controller_class,action_name,
                 controller_file,controller_line,architecture_style,entry_kind,execution_chain_json)
                SELECT domain_id,feature_key,http_method,route_uri,route_name,controller_class,action_name,
                'competing/handler',controller_line,architecture_style,entry_kind,execution_chain_json
                FROM vertical_slices WHERE http_method=? AND route_uri=? AND controller_file=?''',
                (target['method'], target['uri'], target['file']))
        ambiguous = client.tool('septum_slice', {'query': query})
        assert ambiguous['status'] == 'ambiguous' and not ambiguous['found'], ambiguous
        assert ambiguous['entrypoint'] is None and ambiguous['chain'] == [], ambiguous
        assert len(ambiguous['alternatives']) == 2, ambiguous
        args = {'query': query, 'controller_file': target['file']}
        selected = client.tool('septum_slice', args)
        assert selected['status'] == 'success' and selected['entrypoint']['file'] == target['file'], selected
        with sqlite3.connect(db_path) as db:
            db.execute("UPDATE vertical_slices SET execution_chain_json='[null]' WHERE controller_file=?", (target['file'],))
        corrupt = client.tool('septum_slice', args)
        assert corrupt['status'] == 'unknown' and 'invalid_execution_chain' in corrupt['diagnostics'], corrupt
        assert corrupt['chain'] == [] and corrupt['next'], corrupt
        record['metrics'] = client.metrics()
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--output', default='/tmp/septum-slice-integrity-runtime.json')
    args = parser.parse_args()
    fixtures = json.loads(subprocess.run(['bun', '--eval',
        "import {sliceIntegrityCases} from './tests/fixtures/slice-integrity-cases.ts'; console.log(JSON.stringify(sliceIntegrityCases));"],
        cwd=PROJECT, check=True, capture_output=True, text=True).stdout)
    binary = Path(args.binary).resolve()
    report = {'agent_effectiveness': 'NOT_MEASURED', 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'source_sha256': {str(p.relative_to(PROJECT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in sorted((PROJECT / 'src').rglob('*.ts'))}, 'runs': {}}
    with tempfile.TemporaryDirectory(prefix='septum-slice-mcp-') as temp:
        for mode, command in {'source': ['bun', 'run', str(PROJECT / 'bin/septum.ts')], 'compiled': [str(binary)]}.items():
            report['runs'][mode] = []
            for index, fixture in enumerate(fixtures):
                root = Path(temp) / mode / str(index)
                root.mkdir(parents=True)
                report['runs'][mode].append(run(command, fixture, root))
                print(mode, fixture['framework'], 'PASS', flush=True)
    Path(args.output).write_text(json.dumps(report, indent=2))
    print('Raw ledger:', args.output)


if __name__ == '__main__':
    main()
