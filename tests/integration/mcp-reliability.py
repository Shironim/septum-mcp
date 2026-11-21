"""Exercise a real stdio server; fixtures and subprocesses are always cleaned up."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[2]
CLI = PROJECT / 'bin/septum.ts'

def bun_eval(code, root):
    subprocess.run(['bun', '-e', code], cwd=root, check=True, capture_output=True, text=True)

def setup(base, name):
    root = base / name
    (root / 'src/orders').mkdir(parents=True)
    (root / 'src/billing').mkdir(parents=True)
    (root / 'package.json').write_text('{}')
    (root / 'src/orders/Order.ts').write_text('export function oldOrder() {}\n')
    (root / 'src/orders/Other.ts').write_text('export function oldOther() {}\n')
    (root / 'src/billing/Invoice.ts').write_text('export function invoice() {}\n')
    bun_eval(f'''import {{SeptumDatabase}} from {json.dumps(str(PROJECT / 'src/core/database/client.ts'))};
      import {{SeptumRepository}} from {json.dumps(str(PROJECT / 'src/core/database/repository.ts'))};
      const db=new SeptumDatabase('.septum/septum.db'); const repo=new SeptumRepository(db.raw);
      repo.upsertDomain('orders',{{root:'src/orders',allowed_dependencies:['billing']}});
      repo.upsertDomain('billing',{{root:'src/billing'}}); db.close();''', root)
    subprocess.run(['bun', 'run', str(CLI), 'sync'], cwd=root, check=True, capture_output=True)
    return root

with tempfile.TemporaryDirectory(prefix='septum-mcp-regression-') as temporary:
    a = setup(Path(temporary), 'a')
    b = setup(Path(temporary), 'b')
    env = {key: value for key, value in os.environ.items()
           if key not in {'SEPTUM_WORKSPACE_ROOT', 'WORKSPACE_ROOT'}}
    server = subprocess.Popen(['bun', 'run', str(CLI), 'serve'], cwd=a,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, env=env)
    selector = selectors.DefaultSelector()
    selector.register(server.stdout, selectors.EVENT_READ)
    serial = 0

    def request(method, params, expected_error=None, progress=None):
        global serial
        serial += 1
        server.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': serial, 'method': method, 'params': params}) + '\n')
        server.stdin.flush()
        if not selector.select(5):
            raise AssertionError(f'RPC timeout: {method}')
        response = json.loads(server.stdout.readline())
        while response.get('method') == 'notifications/progress':
            assert progress is not None, response
            progress.append(response['params'])
            response = json.loads(server.stdout.readline())
        assert response.get('jsonrpc') == '2.0' and response.get('id') == serial, response
        if expected_error is not None:
            assert response.get('error', {}).get('code') == expected_error, response
            return response['error']
        assert 'error' not in response, response
        return response['result']

    def tool(name, args):
        result = request('tools/call', {'name': name, 'arguments': {'format': 'json', **args}})
        assert not result.get('isError'), result
        return json.loads(result['content'][0]['text'])

    def wait_symbols(root, expected):
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_map', {'action': 'catalog', 'detail_level': 'full', 'domain': 'orders', 'workspace_path': str(root)})
            names = set()
            for file in catalog['files']:
                for symbol in expected:
                    located = tool('septum_symbol', {'action': 'locate', 'query': symbol, 'file_path': file['path'], 'workspace_path': str(root)})
                    if located.get('found') and located.get('exact_symbol', {}).get('name') == symbol:
                        names.add(symbol)
            if set(expected) <= names:
                return
            assert time.monotonic() < deadline, (expected, names)
            time.sleep(.075)

    try:
        initialized = request('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                              'clientInfo': {'name': 'septum-regressions', 'version': '1'}})
        assert initialized['protocolVersion'] == '2024-11-05', initialized
        assert {'tools', 'resources', 'prompts'} <= initialized['capabilities'].keys(), initialized
        server.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        server.stdin.flush()
        resources = request('resources/list', {})['resources']
        assert {item['uri'] for item in resources} == {
            'septum://domains', 'septum://health', 'septum://boundaries',
        }, resources
        assert [entry['uriTemplate'] for entry in request('resources/templates/list', {})['resourceTemplates']] == ['septum://domain/{name}']
        domain_resource = request('resources/read', {'uri': 'septum://domain/orders'})
        assert json.loads(domain_resource['contents'][0]['text'])['status'] == 'success'
        progress = []
        bounded = request('tools/call', {
            'name': 'septum_boundary',
            'arguments': {'scope': 'all', 'max_bytes': 512, 'format': 'json'},
            '_meta': {'progressToken': 'boundary-test'},
        }, progress=progress)
        assert len(json.dumps(bounded, ensure_ascii=False, separators=(',', ':')).encode()) <= 512
        assert [item['progress'] for item in progress] == [1, 2, 3], progress
        assert all(item['progressToken'] == 'boundary-test' for item in progress)
        status = json.loads(bounded['content'][0]['text'])
        if bounded.get('isError'):
            assert status['code'] == 'BUDGET_RESPONSE_TOO_LARGE' and status['required_bytes'] > 512
        else:
            assert status['status'] == 'approved'
        missing_uri = 'septum://missing'
        error = request('resources/read', {'uri': missing_uri}, expected_error=-32002)
        assert error['data']['uri'] == missing_uri, error

        pre_edit_name = 'septum-pre-edit-check'
        pre_edit = next(item for item in request('prompts/list', {})['prompts']
                        if item['name'] == pre_edit_name)
        assert any(arg['name'] == 'target' and arg['required'] for arg in pre_edit['arguments']), pre_edit
        request('prompts/get', {'name': pre_edit_name}, expected_error=-32602)
        request('prompts/get', {'name': pre_edit_name, 'arguments': {'target': '   '}}, expected_error=-32602)
        prompt = request('prompts/get', {'name': pre_edit_name, 'arguments': {'target': 'oldOrder'}})
        message = prompt['messages'][0]
        assert message['role'] == 'user' and message['content']['type'] == 'text', message
        assert 'oldOrder' in message['content']['text'], message
        print('PASS: MCP capability negotiation, resource discovery and missing URI, pre-edit prompt validation')

        (a / 'requirements.txt').write_text('fastapi==0.115.0\n')
        (a / 'main.py').write_text('from fastapi import FastAPI\napp = FastAPI()\n@app.get("/before")\ndef before():\n    return 1\n')
        before = tool('septum_slice', {'query': 'GET /before'})
        assert before['status'] == 'success', before
        (a / 'new_routes.py').write_text('from fastapi import FastAPI\napp = FastAPI()\n@app.get("/after")\ndef after():\n    return 2\n')
        after = tool('septum_slice', {'query': 'GET /after'})
        assert after['status'] == 'success', after
        invalid_boundary_inputs = [
            {'scope': scope, 'file_path': 'src/orders/Order.ts',
             **({'domain': 'orders'} if scope == 'domain' else {})}
            for scope in ['staged', 'all', 'domain']
        ] + [
            {'scope': scope, 'file_paths': ['src/orders/Order.ts'],
             **({'domain': 'orders'} if scope == 'domain' else {})}
            for scope in ['staged', 'all', 'domain']
        ] + [
            {'scope': 'file'}, {'scope': 'file', 'file_paths': []},
            {'scope': 'file', 'domain': 'orders'}, {'scope': 'domain'},
            {'scope': 'domain', 'domain': 'missing'},
            {'scope': 'staged', 'domain': 'missing'},
            {'staged': True, 'file_path': 'src/orders/Order.ts'},
            {'scope': 'all', 'staged': True},
            {'scope': 'all', 'domain': 'orders'},
            {'scope': 'staged', 'proposed_imports': ['../billing/Invoice']},
        ]
        for invalid_args in invalid_boundary_inputs:
            result = request('tools/call', {'name': 'septum_boundary',
                             'arguments': {**invalid_args, 'workspace_path': str(a)}})
            assert result.get('isError') is True, (invalid_args, result)
        args = {'file_path': 'src/orders/Order.ts', 'proposed_imports': ['../billing/Invoice'], 'workspace_path': str(a)}
        assert tool('septum_boundary', args)['status'] == 'approved'
        bun_eval('''import {Database} from 'bun:sqlite'; const db=new Database('.septum/septum.db');
          db.query('UPDATE domains SET forbidden_deps_json=? WHERE name=?').run('["billing"]','orders'); db.close();''', a)
        assert tool('septum_boundary', args)['status'] == 'rejected', 'MCP must refresh externally updated rules'
        subprocess.run(['git', 'init', '-q'], cwd=a, check=True)
        (a / 'src/orders/Order.ts').write_text("import {invoice} from '../billing/Invoice';\nexport const order=invoice;\n")
        subprocess.run(['git', 'add', 'src'], cwd=a, check=True)
        (a / 'src/orders/Order.ts').write_text('export function oldOrder() {}\n')
        staged = tool('septum_boundary', {'scope': 'staged', 'workspace_path': str(a)})
        assert staged['status'] == 'rejected', 'MCP staged audit must inspect Git index blobs'
        filtered_staged = tool('septum_boundary', {'scope': 'staged', 'domain': 'orders', 'workspace_path': str(a)})
        assert filtered_staged['scope'] == 'staged' and filtered_staged['status'] == 'rejected', \
            'Domain filter must not turn a staged audit into a working-tree audit'
        tool('septum_map', {'action': 'catalog', 'detail_level': 'full', 'domain': 'orders', 'workspace_path': str(b)})
        (b / 'src/orders/Order.ts').write_text('export function newOrder() {}\n')
        time.sleep(.04)
        (b / 'src/orders/Other.ts').write_text('export function newOther() {}\n')
        wait_symbols(b, ['newOrder', 'newOther'])
        (b / 'src/orders/Other.ts').unlink()
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_map', {'action': 'catalog', 'detail_level': 'full', 'domain': 'orders', 'workspace_path': str(b)})
            if not any(file['path'].endswith('Other.ts') for file in catalog['files']):
                break
            assert time.monotonic() < deadline, 'Deleted file remained indexed'
            time.sleep(.075)
        unsupported = b / 'src/orders/hello.kt'
        unsupported.write_text('class Hello')
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_map', {'action': 'catalog', 'detail_level': 'full', 'domain': 'orders', 'workspace_path': str(b)})
            if catalog['health']['unsupported_files'] > 0:
                break
            assert time.monotonic() < deadline, 'Unsupported source file was not recorded'
            time.sleep(.075)
        result = tool('septum_boundary', {'file_path': 'src/orders/hello.kt', 'workspace_path': str(b)})
        assert result['status'] == 'unknown', 'Unsupported target must not receive approval'
        unsupported.unlink()
        deadline = time.monotonic() + 5
        while True:
            result = tool('septum_boundary', {'scope': 'all', 'workspace_path': str(b)})
            if result['status'] != 'unknown':
                break
            assert time.monotonic() < deadline, 'Deleted unsupported file left stale diagnostics'
            time.sleep(.075)
        (b / 'src/orders').rename(b / 'src/renamed-orders')
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_map', {'action': 'catalog', 'detail_level': 'full', 'domain': 'orders', 'workspace_path': str(b)})
            if not catalog['files']:
                break
            assert time.monotonic() < deadline, 'Renamed directory left stale catalog files'
            time.sleep(.075)
        subprocess.run(['git', '-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', 'commit', '-qm', 'fixture'], cwd=a, check=True, capture_output=True)
        subprocess.run(['git', 'rm', '-q', 'src/orders/Other.ts'], cwd=a, check=True)
        deletion = tool('septum_boundary', {'scope': 'staged', 'workspace_path': str(a)})
        assert deletion['status'] == 'approved', deletion
        assert not (a / '.septum/session.json').exists()
        assert not (a / '.septum/catalog_access.json').exists()
        print('PASS: boundary scope validation, live rules, staged blobs with domain filters, multi-workspace edits, file/directory reconciliation, unsupported diagnostics, deletion-only audit without feature sessions')

        discovered = Path(temporary) / ('go "discovery"' if os.name != 'nt' else 'go discovery')
        (discovered / 'pkg').mkdir(parents=True)
        (discovered / 'internal/auth').mkdir(parents=True)
        (discovered / 'go.mod').write_text('module example.com/fixture\n\ngo 1.22\n')
        (discovered / 'pkg/service.go').write_text(
            'package pkg\nimport "example.com/fixture/internal/auth"\nfunc Service() string { return auth.Value() }\n')
        (discovered / 'internal/auth/auth.go').write_text('package auth\nfunc Value() string { return "ok" }\n')
        policy = discovered / 'septum.config.json'
        policy.write_text('{}')

        prompt_name = 'septum-architecture-audit'
        listed = request('prompts/list', {})['prompts']
        prompt = next(entry for entry in listed if entry['name'] == prompt_name)
        assert {arg['name'] for arg in prompt['arguments']} == {'domain', 'workspace_path'}
        request('prompts/get', {'name': prompt_name, 'arguments': {'domain': '   '}}, expected_error=-32602)
        for domain in (None, 'pkg'):
            args = {'workspace_path': str(discovered)}
            if domain:
                args['domain'] = domain
            prompt = request('prompts/get', {'name': prompt_name, 'arguments': args})
            instruction = prompt['messages'][0]['content']['text']
            map_args, audit_args = (json.loads(line) for line in instruction.splitlines() if line.startswith('{'))
            assert map_args == {'action': 'catalog', 'detail_level': 'compact', **args}
            assert audit_args == {'scope': 'domain' if domain else 'all', **args}
            catalog = tool('septum_map', map_args)
            assert any(item['name'] == 'pkg' and 'auth' in item['forbidden_dependencies']
                       for item in catalog['domains']), catalog
            verdict = tool('septum_boundary', audit_args)
            assert verdict['status'] == 'rejected' and verdict['total_domains_checked'] == 2, verdict
            assert any(item['rule'] == 'forbidden_dependency' and item['file'] == 'pkg/service.go'
                       for item in verdict['violations']), verdict

        health_item = request('resources/read', {'uri': 'septum://health'})['contents'][0]
        assert health_item['mimeType'] == 'application/json', health_item
        health = json.loads(health_item['text'])
        assert health['workspace_root'] == str(a.resolve()), health
        assert health['domains_count'] == 2 and health['last_sync'], health

        def read_resource(name):
            item = request('resources/read', {'uri': f'septum://{name}'})['contents'][0]
            return json.loads(item['text'])

        catalog = read_resource('domains')
        assert {domain['name'] for domain in catalog['domains']} == {'orders', 'billing'}, catalog
        (a / 'src/orders/Order.ts').write_text(
            "import {invoice} from '../billing/Invoice';\nexport const order=invoice;\n")
        primary_policy = {
            'settings': {'enforcement': 'strict'},
            'domains': {
                'orders': {'root': 'src/orders', 'allowed_dependencies': ['billing']},
                'billing': {'root': 'src/billing'},
            },
        }
        primary_config = a / 'septum.config.json'
        primary_config.write_text(json.dumps(primary_policy))
        audit = read_resource('boundaries')
        assert audit['status'] == 'approved', audit

        primary_policy['domains']['orders'] = {'root': 'src/orders', 'forbidden_dependencies': ['billing']}
        primary_config.write_text(json.dumps(primary_policy))
        audit = read_resource('boundaries')
        assert audit['status'] == 'rejected', audit
        assert any(item['rule'] == 'forbidden_dependency' and item['file'] == 'src/orders/Order.ts'
                   for item in audit['violations']), audit
        assert audit == tool('septum_boundary', {'scope': 'all'})

        primary_config.write_text('{')
        request('resources/read', {'uri': 'septum://boundaries'}, expected_error=-32603)
        primary_config.write_text(json.dumps(primary_policy))
        assert read_resource('boundaries')['status'] == 'rejected'

        policy.write_text(json.dumps({'settings': {'enforcement': 'strict'}}))
        verdict = tool('septum_boundary', {'scope': 'all', 'workspace_path': str(discovered)})
        assert verdict['status'] == 'rejected' and verdict['enforcement_mode'] == 'strict', verdict

        policy.write_text(json.dumps({'settings': {'enforcement': 'strict'}, 'domains': {
            'pkg': {'root': 'pkg', 'allowed_dependencies': ['auth']},
            'auth': {'root': 'internal/auth'},
        }}))
        verdict = tool('septum_boundary', {'scope': 'all', 'workspace_path': str(discovered)})
        assert verdict['status'] == 'approved' and verdict['enforcement_mode'] == 'strict', verdict
        print('PASS: audit prompt arguments, discovered domains, explicit policy precedence, resource workspace identity, policy refresh and recovery')
    finally:
        server.terminate()
        _, stderr = server.communicate(timeout=5)
        selector.close()
        assert server.returncode == 0, stderr
