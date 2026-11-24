import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configureHarness } from "../../src/cli/scaffold/harness-config.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";

const BIN_PATH = path.resolve(import.meta.dir, "../../bin/septum.ts");

function createHookWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-audit-reg-"));
  fs.mkdirSync(path.join(dir, ".septum"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src/billing"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src/shared"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/shared/money.ts"), "export const money = 1;\n");
  fs.writeFileSync(path.join(dir, "src/billing/invoice.ts"), "export const inv = 1;\n");

  const db = new SeptumDatabase(path.join(dir, ".septum/septum.db"));
  const repo = new SeptumRepository(db.raw);
  repo.setMeta("settings_json", JSON.stringify({ enforcement: "strict", db_path: ".septum/septum.db", ignore_patterns: [] }));
  repo.upsertDomain("billing", { root: "src/billing", allowed_dependencies: ["shared"], forbidden_dependencies: [] }, dir);
  repo.upsertDomain("shared", { root: "src/shared", allowed_dependencies: [], forbidden_dependencies: [] }, dir);
  db.close();
  return dir;
}

describe("Multi-harness audit fixes", () => {
  it("emits protojson-safe {decision:'ask'} without extra fields in Antigravity mode and logs telemetry", () => {
    const root = createHookWorkspace();
    try {
      const res = spawnSync(
        "bun",
        ["run", BIN_PATH, "hook", "pre-write"],
        {
          cwd: root,
          input: JSON.stringify({
            tool_input: {
              file_path: "src/billing/invoice.ts",
              content: 'import { money } from "../shared/money";\nexport const x = money;\n',
            },
          }),
          encoding: "utf-8",
          env: { ...process.env, SEPTUM_HOOK_ROOT: root },
        }
      );
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual({ decision: "ask" });

      const logContent = fs.readFileSync(path.join(root, ".septum/septum.log"), "utf-8");
      expect(logContent).toContain('"response_decision":"ask"');
      expect(logContent).toContain('"coverage":"complete_candidate"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows Antigravity brain artifact writes while still blocking /tmp escapes", () => {
    const root = createHookWorkspace();
    try {
      const brainTarget = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain", "test-conv", "scratch", "probe.py");
      const brainRes = spawnSync(
        "bun",
        ["run", BIN_PATH, "hook", "pre-write"],
        {
          cwd: root,
          input: JSON.stringify({ tool_input: { file_path: brainTarget, content: "print(1)\n" } }),
          encoding: "utf-8",
          env: { ...process.env, SEPTUM_HOOK_ROOT: root },
        }
      );
      expect(brainRes.status).toBe(0);
      expect(JSON.parse(brainRes.stdout.trim())).toEqual({ decision: "ask" });

      const escapeRes = spawnSync(
        "bun",
        ["run", BIN_PATH, "hook", "pre-write"],
        {
          cwd: root,
          input: JSON.stringify({ tool_input: { file_path: "/tmp/outside.ts", content: "export const x = 1;\n" } }),
          encoding: "utf-8",
          env: { ...process.env, SEPTUM_HOOK_ROOT: root },
        }
      );
      expect(escapeRes.status).toBe(1);
      expect(JSON.parse(escapeRes.stdout.trim()).decision).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not generate .claude/hooks.json and migrates legacy Septum .claude/hooks.json while preserving user hooks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-claude-clean-"));
    try {
      configureHarness("claude", dir, false);
      expect(fs.existsSync(path.join(dir, ".claude/hooks.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, ".claude/settings.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".claude/hooks/septum-pre-write.sh"))).toBe(true);

      // Legacy .claude/hooks.json with only Septum is removed
      fs.writeFileSync(path.join(dir, ".claude/hooks.json"), JSON.stringify({ "septum-boundary-guard": { PreToolUse: [] } }));
      configureHarness("claude", dir, false);
      expect(fs.existsSync(path.join(dir, ".claude/hooks.json"))).toBe(false);

      // Legacy .claude/hooks.json with user keys preserves user keys
      fs.writeFileSync(path.join(dir, ".claude/hooks.json"), JSON.stringify({ "septum-boundary-guard": { PreToolUse: [] }, "user-hook": { Stop: [] } }));
      configureHarness("claude", dir, false);
      const remaining = JSON.parse(fs.readFileSync(path.join(dir, ".claude/hooks.json"), "utf-8"));
      expect(remaining["septum-boundary-guard"]).toBeUndefined();
      expect(remaining["user-hook"]).toEqual({ Stop: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes Claude and Codex wrappers safely even when cwd is a harness subdirectory", () => {
    const root = createHookWorkspace();
    try {
      configureHarness("claude", root, false);
      configureHarness("codex", root, false);

      const claudeCmd = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf-8")).hooks.PreToolUse[0].hooks[0].command;
      const codexHook = JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8")).hooks.PreToolUse[0];
      expect(codexHook.matcher).toBe("Write|Edit|apply_patch");

      const escapePayload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/outside.ts", content: "x" } });
      const claudeSubRes = spawnSync("sh", ["-c", claudeCmd], {
        cwd: path.join(root, ".claude"),
        input: escapePayload,
        encoding: "utf-8",
      });
      expect(claudeSubRes.status).toBe(2);
      expect(claudeSubRes.stderr).toContain("escapes workspace boundary");

      const codexSubRes = spawnSync("sh", ["-c", codexHook.hooks[0].command], {
        cwd: path.join(root, ".codex"),
        input: escapePayload,
        encoding: "utf-8",
      });
      expect(codexSubRes.status).toBe(2);
      expect(codexSubRes.stderr).toContain("escapes workspace boundary");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports non-interactive septum init --yes --harness codex and rejects invalid harness IDs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-init-cli-"));
    try {
      fs.mkdirSync(path.join(dir, "src/core"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src/core/a.ts"), "export const a = 1;\n");

      const okRes = spawnSync("bun", ["run", BIN_PATH, "init", "--yes", "--harness", "codex"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(okRes.status).toBe(0);
      expect(fs.existsSync(path.join(dir, ".codex/hooks.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);

      const badRes = spawnSync("bun", ["run", BIN_PATH, "init", "--yes", "--harness", "nonexistent"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(badRes.status).toBe(1);
      expect(badRes.stderr).toContain("Unknown harness ID(s): nonexistent");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
