"""Exercise policy ownership, first registration and shared membership over real stdio."""
import argparse
import json
from pathlib import Path
import tempfile
from mcp_fixture import McpSession

PROJECT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--binary')
args = parser.parse_args()
command = [str(Path(args.binary).resolve())] if args.binary else ['bun', 'run', str(PROJECT / 'bin/septum.ts')]

with tempfile.TemporaryDirectory(prefix='septum-first-registration-') as temporary:
    root = Path(temporary)
    (root / 'src').mkdir()
    (root / 'src/first.ts').write_text('export function first() { return 1; }\n')
    (root / 'package.json').write_text('{}')
    with McpSession(command, root) as client:
        registered = client.tool('septum_map', {'action': 'register', 'name': 'chosen', 'root': 'src', 'ingest_now': False})
        assert registered['policy_owner'] == 'database', registered
        catalog = client.tool('septum_map', {'action': 'catalog'})
        assert [domain['name'] for domain in catalog['domains']] == ['chosen'], catalog

with tempfile.TemporaryDirectory(prefix='septum-consistency-') as temporary:
    root = Path(temporary)
    for directory in ['src/orders', 'src/orders/ignored', 'src/billing', '.septum']:
        (root / directory).mkdir(parents=True, exist_ok=True)
    policy = {
        'settings': {'db_path': 'state/index.db', 'enforcement': 'warn', 'ignore_patterns': ['src/orders/ignored/**']},
        'domains': {'orders': {'root': 'src/orders', 'forbidden_dependencies': ['billing']},
                    'billing': {'root': 'src/billing'}}}
    policy_file = root / 'septum.config.json'
    policy_file.write_text(json.dumps(policy))
    (root / 'package.json').write_text('{"dependencies":{"express":"4"}}')
    (root / 'src/orders/submit.ts').write_text('export function submit() { return "PRIVATE_SOURCE_MARKER"; }\n')
    (root / 'src/orders/server.ts').write_text("import express from 'express'; const app=express(); app.get('/live', (req,res)=>res.send('ok'));\n")
    (root / 'src/orders/ignored/old.ts').write_text("import express from 'express'; const app=express(); app.get('/ghost', (req,res)=>res.send('old'));\n")
    (root / 'src/billing/invoice.ts').write_text('export const invoice = 1;\n')
    proposal = {'scope': 'file', 'file_path': 'src/orders/submit.ts', 'proposed_imports': ['../billing/invoice']}
    with McpSession(command, root) as client:
        assert client.tool('septum_boundary', proposal)['status'] == 'rejected'
        registered = client.tool('septum_map', {'action': 'register', 'name': 'orders', 'root': 'src/orders', 'forbidden_dependencies': []})
        assert registered['policy_owner'] == 'file', registered
        assert json.loads(policy_file.read_text())['domains']['orders']['forbidden_dependencies'] == []
        assert client.tool('septum_boundary', proposal)['status'] == 'approved'
        assert client.tool('septum_slice', {'query': 'GET /live'})['found'] is True
        assert client.tool('septum_slice', {'query': 'GET /ghost'})['found'] is False
        catalog = client.tool('septum_map', {'action': 'catalog', 'domain': 'orders', 'detail_level': 'full'})
        assert all('ignored' not in file['path'] for file in catalog['files']), catalog
        for mode in ['deep', 'source']:
            selected = client.tool('septum_symbol', {'action': 'context', 'query': 'submit', 'context_mode': mode})
            assert selected['context_mode'] == mode, selected
        assert not (root / '.septum/septum.db').exists()
    with McpSession(command, root) as reconnected:
        assert reconnected.tool('septum_boundary', proposal)['status'] == 'approved'
    telemetry = (root / '.septum/septum.log').read_text()
    assert 'PRIVATE_SOURCE_MARKER' not in telemetry
    assert 'src/orders/submit.ts' not in telemetry
    assert 'proposed_imports' not in telemetry

print('PASS: first registration, custom database, file policy reload/reconnect, shared ignores, explicit context modes and telemetry redaction')
