"""Validate scaffold/migration with the installed Codex hook parser, without model turns.

python3 tests/integration/codex-hooks.py --existing /path/to/hooks.json --output /tmp/codex-hooks.json
All configuration, ephemeral threads and processes live in disposable CODEX_HOME directories.
"""
import argparse
import json
import os
import pty
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[2]


def run_init(command, root):
    master, slave = pty.openpty()
    process = subprocess.Popen(command, cwd=root, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ)
    output = b''
    selected = False
    deadline = time.monotonic() + 30
    try:
        while process.poll() is None:
            assert time.monotonic() < deadline, output.decode(errors='replace')
            if not selector.select(.1):
                continue
            try:
                output += os.read(master, 65536)
            except OSError:
                break
            if not selected and b'Select AI Agent Harnesses' in output:
                # Exercise the real interactive CLI: select all, including Codex (not a CI default).
                time.sleep(.05)
                os.write(master, b'a\r')
                selected = True
        process.wait(timeout=5)
        assert process.returncode == 0 and selected, output.decode(errors='replace')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        selector.close()
        os.close(master)


def inspect(config, root):
    root.mkdir()
    (root / 'hooks.json').write_text(json.dumps(config))
    with (root / 'stderr.log').open('w+') as log:
        process = subprocess.Popen(['codex', 'app-server', '--listen', 'stdio://'], cwd=root,
            env={**os.environ, 'CODEX_HOME': str(root)}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=log, text=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)

        def request(serial, method, params):
            process.stdin.write(json.dumps({'id': serial, 'method': method, 'params': params}) + '\n')
            process.stdin.flush()
            deadline = time.monotonic() + 15
            while selector.select(max(0, deadline - time.monotonic())):
                line = process.stdout.readline()
                assert line, f'Codex exited while waiting for {method}'
                result = json.loads(line)
                if result.get('id') == serial:
                    assert 'error' not in result, result
                    return result['result']
            raise AssertionError(f'Timeout: {method}')

        try:
            request(1, 'initialize', {'clientInfo': {'name': 'septum-hook-regression', 'version': '1'}})
            process.stdin.write('{"method":"initialized"}\n')
            process.stdin.flush()
            request(2, 'thread/start', {'cwd': str(root), 'ephemeral': True,
                                       'approvalPolicy': 'never', 'sandbox': 'read-only'})
            return request(3, 'hooks/list', {'cwd': str(root)})['data'][0]
        finally:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
            selector.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--existing', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert shutil.which('codex'), 'Installed Codex required for real parser validation'
    with tempfile.TemporaryDirectory(prefix='septum-codex-hooks-') as temp:
        root = Path(temp)
        fixture = root / 'project'
        (fixture / '.codex').mkdir(parents=True)
        (fixture / 'src').mkdir()
        (fixture / 'src/main.ts').write_text('export function main() { return 1; }\n')
        (fixture / 'package.json').write_text('{"name":"codex-init-regression"}')
        user = {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'echo USER'}]}
        original = json.loads(args.existing.read_text()) if args.existing else {
            'description': 'User hooks',
            'septum-boundary-guard': {'PreToolUse': [{'matcher': 'Write', 'hooks': [
                {'type': 'command', 'command': 'old septum-pre-write.sh'}]}]},
            'hooks': {'PreToolUse': [user], 'PostToolUse': [
                {'type': 'command', 'matcher': 'write|edit', 'command': '.codex/hooks/strata-post-write.sh'}]}}
        hook_path = fixture / '.codex/hooks.json'
        hook_path.write_text(json.dumps(original))
        original_result = inspect(original, root / 'before')
        assert any('unknown field `septum-boundary-guard`' in warning for warning in original_result['warnings']), original_result
        command = ['bun', 'run', str(PROJECT / 'bin/septum.ts'), 'init']
        run_init(command, fixture)
        generated = json.loads(hook_path.read_text())
        repaired = inspect(generated, root / 'after')
        assert not repaired['warnings'] and not repaired['errors'], repaired
        assert repaired['hooks'], repaired
        commands = [hook['command'] for hook in repaired['hooks']]
        assert sum('septum-pre-write' in command for command in commands) == 1, commands
        assert '.codex/hooks/strata-post-write.sh' in commands, commands
        if not args.existing:
            assert 'echo USER' in commands
        repeated_results = {}
        for flags in [[], ['--force']]:
            run_init(command + flags, fixture)
            repeated = json.loads(hook_path.read_text())
            assert 'septum-boundary-guard' not in repeated, repeated
            assert '.codex/hooks/strata-post-write.sh' in json.dumps(repeated)
            label = 'force' if flags else 'repeat'
            repeated_results[label] = inspect(repeated, root / f'{label}-parser')
            assert not repeated_results[label]['warnings'] and not repeated_results[label]['errors'], repeated_results[label]
        fresh = root / 'fresh-project'
        (fresh / 'src').mkdir(parents=True)
        (fresh / 'package.json').write_text('{"name":"codex-fresh-init-regression"}')
        (fresh / 'src/main.ts').write_text('export function main() { return 1; }\n')
        run_init(command, fresh)
        fresh_config = json.loads((fresh / '.codex/hooks.json').read_text())
        assert set(fresh_config).issubset({'description', 'hooks'}), fresh_config
        fresh_parsed = inspect(fresh_config, root / 'fresh-parser')
        assert not fresh_parsed['warnings'] and not fresh_parsed['errors'], fresh_parsed
        assert len(fresh_parsed['hooks']) == 1, fresh_parsed
        record = {'codex_version': subprocess.check_output(['codex', '--version'], text=True).strip(),
                  'before': original_result, 'after': repaired, 'generated': generated,
                  'fresh_init': fresh_parsed, 'init_runs': ['migration', 'repeat', 'force', 'fresh'],
                  'repeat_and_force': repeated_results,
                  'scope': 'Isolated real parser/hooks-list; no model turn, tool execution, hook approval or active client reload.'}
        args.output.write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'status': 'PASS', 'parsed_hooks': len(repaired['hooks']), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
