"""Disposable root-ownership rejection and legacy recovery across static framework fixtures."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from importlib.util import module_from_spec, spec_from_file_location

sys.dont_write_bytecode = True
PROJECT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location('slice_integrity', PROJECT / 'tests/integration/slice-integrity.py')
integrity = module_from_spec(spec)
spec.loader.exec_module(integrity)
RecordedSession = integrity.RecordedSession


def state(root):
    with sqlite3.connect(root / '.septum/septum.db') as db:
        return {'domains': db.execute('SELECT id,name,root_path,forbidden_deps_json FROM domains ORDER BY id').fetchall(),
                'files': db.execute('SELECT id,path,domain_id,content_hash FROM files ORDER BY id').fetchall()}


def rejected(client, tool, arguments):
    result = client.request('tools/call', {'name': tool, 'arguments': {**arguments, 'workspace_path': str(client.root)}})
    assert result.get('isError'), result
    assert 'Domain root conflict' in result['content'][0]['text'], result
    return result


def run(command, fixture, root):
    for file, source in {**integrity.manifests(fixture), **fixture['files']}.items():
        target = root / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source)
    record = {'framework': fixture['framework'], 'requests': [], 'fixture': integrity.workflow.snapshot(root)}
    with RecordedSession(command, root, record['requests']) as client:
        client.tool('septum_domain', {'action': 'register', 'domain': 'root', 'root': '.',
                    'forbidden_dependencies': ['blocked'], 'ingest_now': True})
        before = state(root)
        rejected(client, 'septum_domain', {'action': 'register', 'domain': 'alias', 'root': './'})
        assert state(root) == before
        warm = client.tool('septum_domain', {'action': 'register', 'domain': 'ROOT', 'root': '.', 'ingest_now': True})
        assert warm['domain'] == 'root' and warm['ingestion_metrics']['parser_invocations'] == 0, warm
        assert state(root) == before
        # Legacy rows bypass the new registration guard to test an existing database.
        with sqlite3.connect(root / '.septum/septum.db') as db:
            db.execute("INSERT INTO domains(name,root_path) VALUES ('legacy','./')")
        conflicted = state(root)
        rejected(client, 'septum_symbol', {'action': 'locate', 'query': 'run'})
        assert state(root) == conflicted
        record['first_process'] = client.metrics()
    # Restart while conflict persists: initialization must retain an explicit repair
    # route without allowing indexed reads or deleting either domain's policy.
    with RecordedSession(command, root, record['requests']) as client:
        rejected(client, 'septum_domain', {'action': 'catalog'})
        rejected(client, 'septum_domain', {'action': 'register', 'domain': 'another_alias', 'root': '.'})
        assert state(root) == conflicted
        isolated = root / 'isolated'
        isolated.mkdir()
        (isolated / 'owner.ts').write_text('export const repairedOwner = 1;\n')
        repaired = client.tool('septum_domain', {'action': 'register', 'domain': 'legacy', 'root': 'isolated', 'ingest_now': True})
        assert repaired['status'] == 'success', repaired
        recovered = state(root)
        assert next(row for row in recovered['domains'] if row[1] == 'root')[3] == '["blocked"]'
        owner = next(row[0] for row in recovered['domains'] if row[1] == 'legacy')
        assert next(row for row in recovered['files'] if row[1] == 'isolated/owner.ts')[2] == owner
        stable = client.tool('septum_domain', {'action': 'register', 'domain': 'legacy', 'root': './isolated/', 'ingest_now': True})
        assert stable['ingestion_metrics']['parser_invocations'] == 0, stable
        located = client.tool('septum_symbol', {'action': 'locate', 'query': 'repairedOwner'})
        assert located['found'], located
        record['recovered_process'] = client.metrics()
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--output', default='/tmp/septum-domain-ownership-runtime.json')
    args = parser.parse_args()
    fixtures = json.loads(subprocess.run(['bun', '--eval',
        "import {sliceIntegrityCases} from './tests/fixtures/slice-integrity-cases.ts'; console.log(JSON.stringify(sliceIntegrityCases));"],
        cwd=PROJECT, check=True, capture_output=True, text=True).stdout)
    binary = Path(args.binary).resolve()
    report = {'agent_effectiveness': 'NOT_MEASURED', 'framework_application_runtime': 'NOT_TESTED',
              'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'source_sha256': {str(p.relative_to(PROJECT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in sorted((PROJECT / 'src').rglob('*.ts'))}, 'runs': {}}
    with tempfile.TemporaryDirectory(prefix='septum-owner-mcp-') as temp:
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
