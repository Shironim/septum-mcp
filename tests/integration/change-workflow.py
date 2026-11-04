"""Disposable TypeScript plan/verify and Laravel pattern probes, source + compiled.

Records raw calls/bytes/latency; does not measure coding-agent effectiveness or
execute a Laravel application. Expected bindings/policy below precede tool calls.
"""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
from mcp_fixture import McpSession

PROJECT = Path(__file__).resolve().parents[2]


class RecordedSession(McpSession):
    def __init__(self, command, root, ledger):
        self.ledger = ledger
        super().__init__(command, root)

    def request(self, method, params):
        start = time.perf_counter()
        result = super().request(method, params)
        self.ledger.append({'method': method, 'params': params, 'result': result,
                            'duration_ms': (time.perf_counter() - start) * 1000,
                            'process_id': self.server.pid,
                            'request_params_bytes': len(json.dumps(params, ensure_ascii=False, separators=(',', ':')).encode()),
                            'result_bytes': len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode())})
        return result


def put(root, file, text):
    path = root / file
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def git(root, *args):
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=root, check=True,
                          capture_output=True, text=True, timeout=15).stdout


def snapshot(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob('*')) if path.is_file() and '.git' not in path.parts and '.septum' not in path.parts}


def register(client, name, root, **kwargs):
    return client.tool('septum_domain', {'action': 'register', 'domain': name, 'root': root, **kwargs})


def typescript(command, root):
    put(root, '.gitignore', '.septum/\n')
    put(root, 'package.json', '{"type":"module"}\n')
    put(root, 'src/orders/submit.ts', 'export function submit() { return 1; }\n')
    put(root, 'src/orders/import-only.ts', 'import { submit } from "./submit";\nexport const unused = true;\n')
    put(root, 'src/shared/validate.ts', 'export function validate() { return true; }\n')
    put(root, 'src/billing/invoice.ts', 'export const invoice = 1;\n')
    git(root, 'init', '-q'); git(root, 'add', '.')
    git(root, '-c', 'user.name=Septum Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline')
    record = {'fixture': snapshot(root), 'requests': [], 'agent_effectiveness': 'NOT_MEASURED'}
    with RecordedSession(command, root, record['requests']) as client:
        listing = client.request('tools/list', {})
        assert len(listing['tools']) == 5
        schema = next(item for item in listing['tools'] if item['name'] == 'septum_boundary')['inputSchema']
        assert schema['properties']['action']['enum'] == ['check', 'plan', 'verify']
        register(client, 'orders', 'src/orders', allowed_dependencies=['shared'], forbidden_dependencies=['billing'])
        register(client, 'shared', 'src/shared')
        register(client, 'billing', 'src/billing', ingest_now=True)
        for supplied in (False, True):
            proposal = {'scope': 'file', 'file_path': 'src/orders/submit.ts'}
            if supplied:
                proposal['proposed_imports'] = []
            checked = client.tool('septum_boundary', proposal)
            assert checked['evaluated_scope']['proposed_imports_supplied'] is supplied, checked
        located = client.tool('septum_symbol', {'action': 'locate', 'query': 'submit'})
        assert located['symbol_ref']['file_path'] == 'src/orders/submit.ts'
        context = client.tool('septum_symbol', {'action': 'context', 'symbol_ref': located['symbol_ref']})
        assert [item['name'] for item in context['items'] if item['kind'] == 'source'] == ['submit']
        impact = client.tool('septum_symbol', {'action': 'impact', 'symbol_ref': located['symbol_ref']})
        assert [item['source']['file'] for item in impact['import_dependents']] == ['src/orders/import-only.ts']
        assert impact['inbound_callers_complete'] is False
        client.tool('septum_feature', {'action': 'lock', 'feature_key': 'submit', 'domain': 'orders',
                                     'allowed_touchpoints': ['src/orders/submit.ts']})
        denied = client.tool('septum_boundary', {'action': 'plan', 'changes': [
            {'file_path': 'src/orders/submit.ts', 'proposed_imports': ['../billing/invoice']}]})
        assert denied['status'] == 'rejected' and 'plan_ref' not in denied
        saved = client.tool('septum_boundary', {'action': 'plan', 'changes': [
            {'file_path': 'src/orders/submit.ts', 'proposed_imports': ['../shared/validate']}]})
        assert saved['status'] == 'approved' and saved['saved']
        reference = saved['plan_ref']
        legal = 'import { validate } from "../shared/validate";\nexport function submit() { return validate(); }\n'
        put(root, 'src/orders/submit.ts', legal)
        result = client.tool('septum_boundary', {'action': 'verify', 'plan_ref': reference})
        assert result['status'] == 'approved', result
        assert result['changed_files'] == [{'file_path': 'src/orders/submit.ts', 'change': 'modified'}]
        put(root, 'src/orders/submit.ts', 'import { invoice } from "../billing/invoice";\nexport const submit = invoice;\n')
        git(root, 'add', 'src/orders/submit.ts')
        put(root, 'src/orders/submit.ts', legal)
        result = client.tool('septum_boundary', {'action': 'verify', 'plan_ref': reference})
        assert result['status'] == 'approved' and not result['basis']['staged_policy_checked']
        assert 'src/orders/submit.ts' in result['worktree_index_differences']
        staged = client.tool('septum_boundary', {'scope': 'staged'})
        assert staged['status'] == 'rejected' and any(v['rule'] == 'forbidden_dependency' for v in staged['violations'])
        put(root, 'NOTES.md', 'outside plan\n')
        result = client.tool('septum_boundary', {'action': 'verify', 'plan_ref': reference})
        assert result['status'] == 'rejected' and result['outside_plan'] == ['NOTES.md']
        (root / 'NOTES.md').unlink()
        record['first_process'] = client.metrics()
    with RecordedSession(command, root, record['requests']) as client:
        result = client.tool('septum_boundary', {'action': 'verify', 'plan_ref': reference})
        assert result['status'] == 'approved', result
        register(client, 'orders', 'src/orders', allowed_dependencies=['shared'], forbidden_dependencies=['billing', 'shared'])
        assert client.tool('septum_boundary', {'action': 'verify', 'plan_ref': reference})['status'] == 'stale_plan'
        released = client.request('tools/call', {'name': 'septum_feature', 'arguments': {
            'action': 'release', 'force': True, 'workspace_path': str(root)}})
        assert not released.get('isError') and 'released' in released['content'][0]['text']
        record['restart_process'] = client.metrics()
    return record


def laravel(command, root):
    put(root, '.gitignore', '.septum/\n')
    put(root, 'artisan', '<?php\n')
    put(root, 'composer.json', json.dumps({'require': {'laravel/framework': '11.0.0'}, 'autoload': {'psr-4': {'App\\': 'app/'}}}))
    route = ('<?php\nuse Illuminate\\Support\\Facades\\Route;\n'
             '// use App\\Http\\Controllers\\GhostController as Checkout;\n'
             'use App\\Http\\Controllers\\OrderController as Checkout;\n'
             '// Route::resource("ghost", GhostController::class);\n'
             'Route::post("/orders", [Checkout::class, "store"]);\n')
    put(root, 'routes/web.php', route)
    controller = ('<?php\nnamespace App\\Http\\Controllers;\n'
                  'class OrderController {\n public function store() { return 1; }\n}\n')
    put(root, 'app/Http/Controllers/OrderController.php', controller)
    git(root, 'init', '-q'); git(root, 'add', '.')
    record = {'fixture': snapshot(root), 'requests': [], 'runtime_application': 'NOT_TESTED',
              'version_scope': 'declared Laravel 11.0.0 source-pattern fixture; dependencies not installed'}
    with RecordedSession(command, root, record['requests']) as client:
        # Declare the specific controller owner; bootstrap discovery can already
        # contain http=app/Http, which takes precedence over a parent app root.
        register(client, 'http', 'app/Http')
        register(client, 'routes', 'routes', allowed_dependencies=['http'], ingest_now=True)
        catalog = client.tool('septum_domain', {'action': 'catalog', 'detail_level': 'full'})
        record['catalog'] = catalog
        located = client.tool('septum_symbol', {'action': 'locate', 'query': 'OrderController::store'})
        assert located['symbol_ref']['file_path'] == 'app/Http/Controllers/OrderController.php'
        inspected = client.tool('septum_symbol', {'action': 'inspect', 'symbol_ref': located['symbol_ref'], 'include_source': True})
        assert 'return 1' in inspected['source_slice']['text']
        sliced = client.tool('septum_slice', {'query': 'POST /orders'})
        assert sliced['found'], sliced
        assert any(node.get('file') == 'app/Http/Controllers/OrderController.php' for node in sliced['chain']), sliced
        ghost = client.tool('septum_slice', {'query': 'GET /ghost'})
        assert not ghost['found'], ghost
        allowed = client.tool('septum_boundary', {'scope': 'file', 'file_path': 'routes/web.php',
                                                'proposed_imports': ['App\\Http\\Controllers\\OrderController']})
        assert allowed['status'] == 'approved', allowed
        register(client, 'routes', 'routes', allowed_dependencies=[], forbidden_dependencies=['http'])
        denied = client.tool('septum_boundary', {'scope': 'file', 'file_path': 'routes/web.php',
                                               'proposed_imports': ['App\\Http\\Controllers\\OrderController']})
        assert denied['status'] == 'rejected', denied
        register(client, 'routes', 'routes', allowed_dependencies=['http'], forbidden_dependencies=[])
        put(root, 'routes/web.php', route.replace('"/orders"', '"/renamed"'))
        assert client.tool('septum_slice', {'query': 'POST /renamed'})['found']
        assert not client.tool('septum_slice', {'query': 'POST /orders'})['found']
        record['first_process'] = client.metrics()
    with RecordedSession(command, root, record['requests']) as client:
        assert client.tool('septum_slice', {'query': 'POST /renamed'})['found']
        record['restart_process'] = client.metrics()
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--output', default='/tmp/septum-change-workflow.json')
    args = parser.parse_args()
    commands = {'source': ['bun', 'run', str(PROJECT / 'bin/septum.ts')], 'compiled': [str(Path(args.binary).resolve())]}
    report = {'agent_effectiveness': 'NOT_MEASURED; awaits user-supplied real-project task and expected behavior',
              'platform': platform.platform(), 'python': sys.version,
              'bun': subprocess.run(['bun', '--version'], capture_output=True, text=True, check=True).stdout.strip(),
              'binary_sha256': hashlib.sha256(Path(args.binary).read_bytes()).hexdigest(),
              'source_sha256': {str(p.relative_to(PROJECT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in sorted((PROJECT / 'src').rglob('*.ts'))}, 'runs': {}}
    with tempfile.TemporaryDirectory(prefix='septum-workflow-mcp-') as temp:
        for mode, command in commands.items():
            report['runs'][mode] = {}
            for name, fn in [('typescript', typescript), ('laravel', laravel)]:
                root = Path(temp) / mode / name
                root.mkdir(parents=True)
                report['runs'][mode][name] = fn(command, root)
                print(mode, name, 'PASS', flush=True)
    Path(args.output).write_text(json.dumps(report, indent=2))
    print('Raw ledger:', args.output)


if __name__ == '__main__':
    main()
