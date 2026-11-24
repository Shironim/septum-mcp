import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";

const BIN_PATH = path.resolve(import.meta.dir, "../../bin/septum.ts");

function createHookWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-uat-"));
  fs.mkdirSync(path.join(root, "src/billing"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/orders"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/shared"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/orders/order.ts"), "export const order = 1;\n");
  fs.writeFileSync(path.join(root, "src/shared/money.ts"), "export const money = 1;\n");
  const db = new SeptumDatabase(path.join(root, ".septum/septum.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    repo.setMeta("settings_json", JSON.stringify({ enforcement: "strict", db_path: ".septum/septum.db", ignore_patterns: [] }));
    repo.upsertDomain("billing", { root: "src/billing", allowed_dependencies: ["shared"], forbidden_dependencies: ["orders"] }, root);
    repo.upsertDomain("orders", { root: "src/orders", allowed_dependencies: ["shared"], forbidden_dependencies: [] }, root);
    repo.upsertDomain("shared", { root: "src/shared", allowed_dependencies: [], forbidden_dependencies: ["billing", "orders"] }, root);
  } finally {
    db.close();
  }
  return root;
}

function runPreWriteCli(cwd: string, payload: string, extraArgs: string[] = []) {
  return spawnSync("bun", ["run", BIN_PATH, "hook", "pre-write", ...extraArgs], {
    cwd,
    input: payload,
    encoding: "utf-8",
    env: { ...process.env, SEPTUM_HOOK_ROOT: cwd },
  });
}

describe("UAT: septum hook pre-write (Real CLI Seam & SQLite SSOT)", () => {
  it("allows valid import using SQLite SSOT", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(
        root,
        JSON.stringify({
          tool_input: {
            file_path: "src/billing/invoice.ts",
            content: 'import { money } from "../shared/money";\nexport const ok = money;\n',
          },
        })
      );

      expect(res.status).toBe(0);
      const decision = JSON.parse(res.stdout.trim());
      expect(decision).toEqual({ decision: "ask" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks forbidden cross-domain import with exit code 1 (default) and 2 (--claude)", () => {
    const root = createHookWorkspace();
    try {
      const payload = JSON.stringify({
        tool_input: {
          file_path: "src/billing/invoice.ts",
          content: 'import { order } from "../orders/order";\nexport const bad = order;\n',
        },
      });

      const defaultRes = runPreWriteCli(root, payload);
      expect(defaultRes.status).toBe(1);
      expect(JSON.parse(defaultRes.stdout.trim()).decision).toBe("deny");
      expect(defaultRes.stderr).toContain("OFFENDING IMPORT");

      const claudeRes = runPreWriteCli(root, payload, ["--claude"]);
      expect(claudeRes.status).toBe(2);
      expect(claudeRes.stdout).toBe("");
      expect(claudeRes.stderr).toContain("OFFENDING IMPORT");

      const claudeAllow = runPreWriteCli(
        root,
        JSON.stringify({
          tool_input: {
            file_path: "src/billing/invoice.ts",
            content: 'import { money } from "../shared/money";\nexport const ok = money;\n',
          },
        }),
        ["--claude"]
      );
      expect(claudeAllow.status).toBe(0);
      expect(claudeAllow.stdout).toBe("");

      const claudeSkip = runPreWriteCli(root, JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), ["--claude"]);
      expect(claudeSkip.status).toBe(0);
      expect(claudeSkip.stdout).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks path traversal outside workspace root before reading or evaluating", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(
        root,
        JSON.stringify({
          tool_input: {
            file_path: "../../etc/passwd",
            content: "root:x:0:0",
          },
        })
      );

      expect(res.status).toBe(1);
      expect(JSON.parse(res.stdout.trim()).decision).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes through malformed JSON or unsupported payloads safely without crashing", () => {
    const root = createHookWorkspace();
    try {
      const malformed = runPreWriteCli(root, "{not-valid-json");
      expect(malformed.status).toBe(0);

      const unsupported = runPreWriteCli(root, JSON.stringify({ tool_name: "read_file", tool_input: { query: "x" } }));
      expect(unsupported.status).toBe(0);
      const decision = JSON.parse(unsupported.stdout.trim());
      expect(decision).toEqual({ decision: "ask" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("UAT: septum hook pre-write Codex contract (--codex)", () => {
  const patch = (body: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } });

  it("skips Bash payload with empty stdout and exit 0", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(root, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pwd" } }), ["--codex"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("allows a compliant apply_patch with empty stdout", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(root, patch('*** Add File: src/billing/ok.ts\n+import { money } from "../shared/money";\n+export const ok = money;'), ["--codex"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks a violating apply_patch with exit 2, stderr reason, empty stdout", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(root, patch('*** Update File: src/billing/invoice.ts\n@@\n+import { order } from "../orders/order";'), ["--codex"]);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("BOUNDARY VIOLATION");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks invalid JSON-contained path escape with empty stdout", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(root, patch('*** Add File: ../outside.ts\n+export const x = 1;'), ["--codex"]);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("UAT: septum hook pre-write OpenCode contract (--opencode)", () => {
  it("blocks via exit 2 + stderr with empty stdout; allows silently", () => {
    const root = createHookWorkspace();
    try {
      const bad = runPreWriteCli(root, JSON.stringify({ tool_name: "edit", tool_input: { file_path: "src/billing/a.ts", content: 'import { order } from "../orders/order";\n' } }), ["--opencode"]);
      expect(bad.status).toBe(2);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toContain("BOUNDARY VIOLATION");
      const ok = runPreWriteCli(root, JSON.stringify({ tool_name: "write", tool_input: { file_path: "src/billing/a.ts", content: 'import { money } from "../shared/money";\n' } }), ["--opencode"]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toBe("");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("resolves relative targets against workspaceRoot even when cwd is .agents/", () => {
    const root = createHookWorkspace();
    const agentsDir = path.join(root, ".agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    try {
      const res = spawnSync("bun", ["run", BIN_PATH, "hook", "pre-write"], {
        cwd: agentsDir,
        input: JSON.stringify({
          toolCall: {
            name: "write_file",
            args: {
              TargetFile: "src/billing/invoice.ts",
              CodeContent: 'import { order } from "../orders/order";\n',
            },
          },
        }),
        encoding: "utf-8",
        env: { ...process.env, SEPTUM_HOOK_ROOT: root },
      });
      expect(res.status).toBe(1);
      expect(JSON.parse(res.stdout.trim()).decision).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("OpenCode v2 plugin template registers execute.before and blocks/allows via septum CLI", async () => {
    const root = createHookWorkspace();
    const pluginPath = path.join(root, ".opencode/plugins/septum.ts");
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    // Point local bin/septum.ts to the repo's bin/septum.ts via a thin wrapper
    fs.writeFileSync(path.join(root, "bin/septum.ts"), `import ${JSON.stringify(BIN_PATH)};\n`, "utf-8");
    const { SEPTUM_OPENCODE_PLUGIN } = await import("../../src/cli/templates/opencode-plugin.ts");
    fs.writeFileSync(pluginPath, SEPTUM_OPENCODE_PLUGIN, "utf-8");

    try {
      const mod = await import(`${pluginPath}?t=${Date.now()}`);
      const plugin = mod.default;
      expect(plugin.id).toBe("septum-boundary-guard");
      expect(typeof plugin.setup).toBe("function");

      const handlers: Record<string, (s: any) => void> = {};
      plugin.setup({
        location: { directory: root },
        tool: {
          hook: (event: string, fn: (s: any) => void) => {
            handlers[event] = fn;
          },
        },
      });
      expect(typeof handlers["execute.before"]).toBe("function");

      // Should allow valid import
      expect(() =>
        handlers["execute.before"]({
          tool: "write",
          input: { filePath: "src/billing/ok.ts", content: 'import { money } from "../shared/money";\n' },
        })
      ).not.toThrow();

      // Should block forbidden import
      expect(() =>
        handlers["execute.before"]({
          tool: "edit",
          input: { filePath: "src/billing/bad.ts", content: 'import { order } from "../orders/order";\n' },
        })
      ).toThrow(/BOUNDARY VIOLATION/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
