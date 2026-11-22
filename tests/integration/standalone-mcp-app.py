"""Check that the release executable serves its embedded MCP App over stdio."""

import json
import os
import selectors
import subprocess
import sys
import tempfile
from pathlib import Path


def smoke_test(binary: Path) -> None:
    env = os.environ.copy()
    for key in ("SEPTUM_APP_HTML", "SEPTUM_WORKSPACE_ROOT", "WORKSPACE_ROOT"):
        env.pop(key, None)

    with tempfile.TemporaryDirectory(prefix="septum-release-smoke-") as workspace:
        env["SEPTUM_WORKSPACE_ROOT"] = workspace
        with subprocess.Popen(
            [str(binary), "serve"],
            cwd=workspace,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        ) as server, selectors.DefaultSelector() as selector:
            selector.register(server.stdout, selectors.EVENT_READ)

            def send(method, params=None, request_id=None):
                message = {"jsonrpc": "2.0", "method": method}
                if params is not None:
                    message["params"] = params
                if request_id is not None:
                    message["id"] = request_id
                server.stdin.write(json.dumps(message) + "\n")
                server.stdin.flush()

            def request(request_id, method, params):
                send(method, params, request_id)
                if not selector.select(10):
                    raise AssertionError(f"MCP request timed out: {method}")
                line = server.stdout.readline()
                if not line:
                    raise AssertionError(f"Server closed stdout during {method}")
                response = json.loads(line)
                assert response.get("id") == request_id and "result" in response, response
                return response["result"]

            try:
                initialized = request(1, "initialize", {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "septum-release-smoke", "version": "1"},
                })
                assert "resources" in initialized["capabilities"], initialized
                send("notifications/initialized")

                uri = "ui://septum/app.html"
                result = request(2, "resources/read", {"uri": uri})
                item, = result["contents"]
                assert item["uri"] == uri, item["uri"]
                assert item["mimeType"] == "text/html;profile=mcp-app", item["mimeType"]
                html = item["text"]
                assert "<title>Septum Architecture</title>" in html
                assert '<script type="module">' in html
            finally:
                server.kill()


if __name__ == "__main__":
    smoke_test(Path(sys.argv[1]).resolve(strict=True))
    print("Standalone executable served the Septum Architecture MCP App.")
