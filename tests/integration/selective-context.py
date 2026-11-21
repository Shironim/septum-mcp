"""Disposable source/compiled stdio probes with raw requests, responses and a byte ledger.

python3 tests/integration/selective-context.py --binary dist/septum --output /tmp/septum-selective-runtime.json
This measures tool behavior, not model tokens, application correctness or skill efficacy.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("contract_probe", PROJECT / "scripts/audit-mcp-cli-contracts.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def serialized_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


def setup(root, command):
    (root / 'src').mkdir(parents=True)
    (root / 'package.json').write_text('{"type":"module"}\n')
    (root / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'paths': {'@rules/*': ['src/*']}}}))
    (root / 'src/target.ts').write_text(
        'import { validate } from "@rules/validator";\n'
        'import type { Order } from "./contract";\n'
        'export function submit(order: Order) {\n  return validate(order);\n}\n')
    (root / 'src/validator.ts').write_text('export function validate(order: { subtotal: number }) {\n  return order.subtotal;\n}\n')
    (root / 'src/contract.ts').write_text('export interface Order { subtotal: number }\n')
    (root / 'src/caller.ts').write_text('import {submit} from "./target";\nexport function run() { return submit({subtotal: 2}); }\n')
    (root / 'src/import-only.ts').write_text('import {submit} from "./target";\nexport const unused = 1;\n')
    (root / 'src/decoy.ts').write_text('export function unrelated() { return "submit validate"; }\n')
    (root / 'src/order.ts').write_text(
        'import { tax as computeTax } from "./rates";\n'
        'import { campaign } from "./marketing";\n'
        'const surcharge = 7;\n'
        'function validateLocal(x: number) { return Math.max(0, x); }\n'
        'export function total(x: number) { return validateLocal(x) + surcharge + computeTax(x); }\n'
        'export function unusedCampaign() { return campaign(); }\n')
    (root / 'src/rates.ts').write_text('import { percentage } from "./policy";\nexport function tax(x: number) { return x * percentage; }\nexport function decoyRate() { return 99; }\n')
    (root / 'src/policy.ts').write_text('export const percentage = 0.11;\n')
    (root / 'src/marketing.ts').write_text('export function campaign() { return "marketing"; }\n')
    probe.bun_eval(root, """const db=new SeptumDatabase(); const repo=new SeptumRepository(db.raw);
      repo.upsertDomain('app',{root:'src'}); db.close();""")
    sync = subprocess.run(command + ['sync', '--json'], cwd=root, capture_output=True, text=True, timeout=30)
    assert sync.returncode == 0, sync.stderr
    warm = subprocess.run(command + ['sync', '--json'], cwd=root, capture_output=True, text=True, timeout=30)
    assert warm.returncode == 0, warm.stderr
    assert json.loads(sync.stdout)['parser_invocations'] == 10
    assert json.loads(warm.stdout)['parser_invocations'] == 0
    return {'cold_index_sync': json.loads(sync.stdout), 'warm_index_sync': json.loads(warm.stdout), 'os_cache': 'unknown',
        'tsconfig_sha256': hashlib.sha256((root / 'tsconfig.json').read_bytes()).hexdigest(), 'files': {
        str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in sorted((root / 'src').glob('*.ts'))}}


def run(command, root):
    record = {'command': command, 'fixture': setup(root, command), 'requests': []}
    client = probe.MCP(command, root)

    def request(method, params):
        started = time.perf_counter()
        result = client.request(method, params)
        record['requests'].append({'method': method, 'params': params, 'result': result,
            'duration_ms': (time.perf_counter() - started) * 1000,
            'request_params_bytes': serialized_bytes(params), 'result_bytes': serialized_bytes(result)})
        assert 'rpc_error' not in result, result
        return result

    def tool(args, expected_error=False):
        result = request('tools/call', {'name': 'septum_symbol', 'arguments': {'format': 'json', **args, 'workspace_path': str(root)}})
        assert bool(result.get('isError')) == expected_error, result
        if expected_error:
            return result
        payload = json.loads(result['content'][0]['text'])
        if 'output_bytes' in payload:
            assert payload['output_bytes'] == serialized_bytes(result), (payload['output_bytes'], serialized_bytes(result))
            assert payload['output_bytes'] <= payload['budget_bytes']
        return payload

    try:
        listing = request('tools/list', {})
        assert {tool['name'] for tool in listing['tools']} == {
            'septum_map', 'septum_symbol', 'septum_slice', 'septum_boundary'}
        for retired in ['septum_domain', 'septum_feature']:
            rejected = request('tools/call', {'name': retired, 'arguments': {'workspace_path': str(root)}})
            assert rejected.get('isError'), rejected
        symbol_schema = next(tool for tool in listing['tools'] if tool['name'] == 'septum_symbol')['inputSchema']
        assert 'context' in symbol_schema['properties']['action']['enum']
        assert symbol_schema['properties']['budget_bytes']['minimum'] == 2048
        assert symbol_schema['properties']['budget_bytes']['default'] == 16384
        assert 'default' not in symbol_schema['properties']['source_line_limit']
        # Assert analytical payloads through real MCP transport for every tool.
        # A not_found slice is a deliberate negative contract.
        probes = [
            ('septum_map', {'action': 'catalog', 'detail_level': 'full'}, {'domains', 'index_status'}),
            ('septum_slice', {'query': 'GET /absent'}, {'chain', 'found', 'relationship_limits'}),
            ('septum_boundary', {'scope': 'all'}, {'violations', 'total_violations'}),
        ]
        for name, arguments, required in probes:
            result = request('tools/call', {'name': name, 'arguments': {'format': 'json', **arguments, 'workspace_path': str(root)}})
            assert not result.get('isError'), result
            assert len(result.get('content', [])) > 0, result
            analytical = json.loads(result['content'][0]['text'])
            assert required.issubset(analytical), (name, analytical)
        located = tool({'action': 'locate', 'query': 'submit', 'file_path': 'src/target.ts'})
        reference = located['symbol_ref']
        inspected = tool({'action': 'inspect', 'symbol_ref': reference, 'include_source': True})
        assert inspected['source_slice']['text'] == 'export function submit(order: Order) {\n  return validate(order);\n}'
        impact = tool({'action': 'impact', 'symbol_ref': reference})
        assert [edge['source']['file'] for edge in impact['import_dependents']] == ['src/caller.ts', 'src/import-only.ts']
        assert impact['inbound_callers_complete'] is False
        full = tool({'action': 'context', 'symbol_ref': reference})
        assert tool({'action': 'inspect', 'symbol_ref': reference}) == full
        bounded = tool({'action': 'context', 'symbol_ref': reference, 'source_line_limit': 1})
        assert bounded['source_slice']['text'] == 'export function submit(order: Order) {'
        for payload in [located, inspected, impact]:
            evidence = payload['retrieval']
            assert evidence['target_id'] == full['target_id']
            assert evidence['freshness'] == 'current'
            assert evidence['freshness_scope'] == 'selected_declaration_source_only'
            assert evidence['source_version']['observed_hash'] == reference['indexed_content_hash']
            assert evidence['completeness'] == 'partial' and evidence['analysis_freshness'] == 'unavailable'
        assert [(item['name'], item['source']['file_path']) for item in full['items'] if item['kind'] == 'source'] == [
        ('submit', 'src/target.ts'), ('validate', 'src/validator.ts'), ('Order', 'src/contract.ts')]
        assert full['freshness'] == 'current' and full['completeness'] == 'complete'
        arithmetic = tool({'action': 'context', 'query': 'total', 'file_path': 'src/order.ts'})
        assert arithmetic['policy'] == 'referenced-typescript-declarations/v4'
        assert arithmetic['task_sufficiency'] == 'unknown'
        assert sorted(item['name'] for item in arithmetic['items'] if item['kind'] == 'source') == [
            'percentage', 'surcharge', 'tax', 'total', 'validateLocal']
        for _ in range(3):
            assert tool({'action': 'context', 'symbol_ref': reference}) == full
        assert not (root / '.septum/session.json').exists()
        base = {'action': 'context', 'symbol_ref': reference, 'budget_bytes': 3500}
        first = tool(base)
        assert first.get('continuation'), first
        page = first
        items = list(page['items'])
        pages = 1
        while page.get('continuation'):
            page = tool({**base, 'continuation': page['continuation']})
            assert page['snapshot_id'] == first['snapshot_id']
            items.extend(page['items'])
            pages += 1
            assert pages <= 16
        assert items == full['items']
        for action in ['inspect', 'context']:
            details = tool({'action': action, 'symbol_ref': reference, 'include_source': False})
            assert 'source_slice' not in details and 'items' not in details, details
        # The nearest config shadows the root alias without changing any source file.
        nested = root / 'src/tsconfig.json'
        nested.write_text('{}\n')
        assert tool({**base, 'continuation': first['continuation']})['status'] == 'stale_continuation'
        partial = tool({'action': 'context', 'symbol_ref': reference})
        assert partial['freshness'] == 'current' and partial['completeness'] == 'partial'
        alias_edges = [item['relationship'] for item in partial['items']
                       if item['kind'] == 'relationship'
                       and item['relationship']['resolution']['source']['target'] == '@rules/validator']
        assert len(alias_edges) == 1, partial
        resolution = alias_edges[0]['resolution']
        assert (alias_edges[0]['freshness'], resolution['status'], resolution['reason'], resolution['targets']) == (
            'current', 'unresolved', 'package_not_declared', []), alias_edges[0]
        assert any(item['kind'] == 'diagnostic' and item['reason'] == 'referenced_import_not_expanded'
                   and item['file_path'] == 'src/target.ts' and '@rules/validator' in item['detail']
                   for item in partial['items']), partial
        assert not any(item.get('name') == 'validate' for item in partial['items'])
        nested.unlink()
        assert tool({'action': 'context', 'symbol_ref': reference})['items'] == full['items']
        (root / 'src/validator.ts').write_text('export function validate(order: { subtotal: number }) {\n  return order.subtotal * 2;\n}\n')
        stale = tool({**base, 'continuation': first['continuation']})
        assert stale['status'] == 'stale_continuation', stale
        fresh = tool({'action': 'context', 'symbol_ref': reference})
        assert any('order.subtotal * 2' in item.get('source', {}).get('text', '') for item in fresh['items'])
        assert fresh['snapshot_id'] != full['snapshot_id']
        (root / 'src/target.ts').write_text('// moved declaration\n' + (root / 'src/target.ts').read_text())
        assert tool({'action': 'context', 'symbol_ref': reference})['status'] == 'stale_reference'
        for action in ['locate', 'impact']:
            stale_reference = tool({'action': action, 'symbol_ref': reference})
            assert stale_reference['status'] == 'stale_reference'
            assert stale_reference['retrieval']['target_id'] is None
            assert stale_reference['retrieval']['requested_target_id'] == full['target_id']
        tool({'action': 'context', 'query': 'submit', 'budget_bytes': 1}, expected_error=True)
        record['pagination_pages'] = pages
    finally:
        record['server_exit_code'] = client.close()
    assert record['server_exit_code'] == 0, record['server_exit_code']

    # Reopen the actual server and compare current source after watcher-driven mutations.
    client = probe.MCP(command, root)
    try:
        current = tool({'action': 'context', 'query': 'submit', 'file_path': 'src/target.ts'})
        assert current['freshness'] == 'current'
        assert current['target']['start_line'] == 4
        assert any('order.subtotal * 2' in item.get('source', {}).get('text', '') for item in current['items'])
    finally:
        record['restart_exit_code'] = client.close()
    assert record['restart_exit_code'] == 0
    record['ledger'] = {'calls_recorded': len(record['requests']),
        'request_params_bytes': sum(item['request_params_bytes'] for item in record['requests']),
        'result_bytes': sum(item['result_bytes'] for item in record['requests']),
        'initialize_and_transport_envelope_bytes': 'NOT_MEASURED', 'model_tokens': 'NOT_MEASURED',
        'comparative_agent_baseline': 'NOT_MEASURED', 'skill_efficacy': 'NOT_MEASURED'}
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    evidence = {'platform': platform.platform(), 'machine': platform.machine(), 'processor': platform.processor(),
        'cpu_count': os.cpu_count(),
        'bun': subprocess.check_output(['bun', '--version'], text=True).strip(),
        'scope': 'TypeScript bound-reference context and four-tool analytical payload smoke; isolated local stdio processes, not the user client connection',
        'runtimes': {}}
    evidence['source_hashes'] = {str(file.relative_to(PROJECT)): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in sorted((PROJECT / 'src').rglob('*.ts'))}
    commands = {'source': ['bun', 'run', str(PROJECT / 'bin/septum.ts')]}
    if args.binary:
        binary = args.binary.resolve()
        commands['compiled'] = [str(binary)]
        evidence['binary'] = {'path': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
    with tempfile.TemporaryDirectory(prefix='septum-selective-mcp-') as temporary:
        for name, command in commands.items():
            evidence['runtimes'][name] = run(command, Path(temporary) / name)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': 'PASS', 'runtimes': list(commands), 'evidence': str(args.output)}))


if __name__ == '__main__':
    main()
