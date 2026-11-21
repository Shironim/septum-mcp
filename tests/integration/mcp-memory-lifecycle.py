"""Actual stdio EOF must dispose server resources without a client kill signal."""
import json, os, pathlib, selectors, subprocess, tempfile
REPO=pathlib.Path(__file__).resolve().parents[2]
CLI = ['bun', 'run', str(REPO / 'bin/septum.ts'), 'serve']
ENV = {key: value for key, value in os.environ.items()
       if key not in {'SEPTUM_WORKSPACE_ROOT', 'WORKSPACE_ROOT'}}
INITIALIZE = json.dumps(dict(
    jsonrpc='2.0', id=1, method='initialize',
    params=dict(protocolVersion='2024-11-05', capabilities={},
                clientInfo=dict(name='lifecycle', version='1')),
)) + '\n'

with tempfile.TemporaryDirectory(prefix='septum-invalid-root-') as root:
    rejected = subprocess.run(CLI, cwd=root, env=ENV, input=INITIALIZE,
                              capture_output=True, text=True, timeout=8)
    assert rejected.returncode != 0, rejected
    assert not rejected.stdout, rejected.stdout
    assert 'No project marker in CWD' in rejected.stderr, rejected.stderr
    print('PASS: invalid initial root exits before serving requests')

with tempfile.TemporaryDirectory(prefix='septum-lifecycle-') as temp:
    root = pathlib.Path(temp)
    (root / 'src').mkdir()
    (root / 'package.json').write_text('{"name":"lifecycle"}')
    (root / 'septum.config.json').write_text(json.dumps({'domains': {'core': {'root': 'src'}}}))
    (root / 'src/a.ts').write_text('export function a() {}')
    with tempfile.TemporaryFile(mode='w+') as log:
        p = subprocess.Popen(CLI, cwd=root, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            p.stdin.write(INITIALIZE)
            p.stdin.flush()
            sel = selectors.DefaultSelector()
            sel.register(p.stdout, selectors.EVENT_READ)
            assert sel.select(10), 'initialize timeout'
            assert 'result' in json.loads(p.stdout.readline())
            sel.close()
            p.stdin.close()
            p.stdin = None
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise AssertionError('server survived client EOF with resources still live')
            assert p.returncode == 0, f'EOF exit code {p.returncode}'
            print('PASS: stdin EOF exits cleanly')
        finally:
            if p.poll() is None:
                p.terminate()
            p.wait(timeout=6)
