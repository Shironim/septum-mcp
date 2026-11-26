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
    with tempfile.TemporaryFile(mode='w+') as log:
        p = subprocess.Popen(CLI, cwd=root, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            p.stdin.write(INITIALIZE)
            p.stdin.flush()
            sel = selectors.DefaultSelector()
            sel.register(p.stdout, selectors.EVENT_READ)
            assert sel.select(10), 'initialize timeout in unmarked cwd'
            init_resp = json.loads(p.stdout.readline())
            assert 'result' in init_resp, init_resp

            # Calling a tool without workspace_path must return an MCP tool error, not crash the server.
            call_without_ws = json.dumps(dict(
                jsonrpc='2.0', id=2, method='tools/call',
                params=dict(name='septum_map', arguments=dict(action='catalog')),
            )) + '\n'
            p.stdin.write(call_without_ws)
            p.stdin.flush()
            assert sel.select(10), 'tools/call timeout in unmarked cwd'
            tool_resp = json.loads(p.stdout.readline())
            assert tool_resp.get('result', {}).get('isError') is True, tool_resp
            assert 'No project marker in CWD' in tool_resp['result']['content'][0]['text'], tool_resp
            sel.close()

            p.stdin.close()
            p.stdin = None
            p.wait(timeout=5)
            assert p.returncode == 0, f'EOF exit code {p.returncode}'
            print('PASS: unmarked initial root starts lazily, rejects unscoped tool calls cleanly, and exits on EOF')
        finally:
            if p.poll() is None:
                p.terminate()
            p.wait(timeout=6)

# Global/home directory startup must also succeed initialize without crashing.
with tempfile.TemporaryFile(mode='w+') as log:
    p = subprocess.Popen(CLI, cwd=str(pathlib.Path.home()), env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
    try:
        p.stdin.write(INITIALIZE)
        p.stdin.flush()
        sel = selectors.DefaultSelector()
        sel.register(p.stdout, selectors.EVENT_READ)
        assert sel.select(10), 'initialize timeout in home dir'
        init_resp = json.loads(p.stdout.readline())
        assert 'result' in init_resp, init_resp
        sel.close()
        p.stdin.close()
        p.stdin = None
        p.wait(timeout=5)
        assert p.returncode == 0, f'EOF exit code in home dir: {p.returncode}'
        print('PASS: home directory startup succeeds initialize and exits cleanly on EOF')
    finally:
        if p.poll() is None:
            p.terminate()
        p.wait(timeout=6)

with tempfile.TemporaryDirectory(prefix='septum-lifecycle-') as temp:
    root = pathlib.Path(temp)
    (root / 'src').mkdir()
    (root / 'package.json').write_text('{"name":"lifecycle"}')
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
