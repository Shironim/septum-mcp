import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configureHarness } from "../../src/cli/scaffold/harness-config.ts";

describe("Antigravity .agents hooks.json migration", () => {
  it("replaces stale pwd-based Septum hook (never matched in .agents/) and keeps user hooks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-ag-mig-"));
    try {
      fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
      const user = { matcher: "run_command", hooks: [{ command: "echo USER" }] };
      const stale = { matcher: "Write", hooks: [{ type: "command", command: "sh -c 'ROOT=\"$(pwd -P)\"; exec \"$ROOT/.agents/hooks/septum-pre-write.sh\"'" }] };
      const p = path.join(dir, ".agents/hooks.json");
      fs.writeFileSync(p, JSON.stringify({ "septum-boundary-guard": { PreToolUse: [user, stale] } }));
      configureHarness("antigravity", dir, false);
      const pre = JSON.parse(fs.readFileSync(p, "utf-8"))["septum-boundary-guard"].PreToolUse;
      expect(pre).toHaveLength(2);
      expect(pre[0]).toEqual(user);
      expect(pre[1].hooks[0].command).toBe("./hooks/septum-pre-write.sh");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("auto-migrates stale Claude --exit-code-2 hook to --claude and OpenCode v1 plugin to v2 without --force", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-mig-multi-"));
    try {
      // Claude stale --exit-code-2
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      const claudeUser = { matcher: "Bash", hooks: [{ type: "command", command: "echo CLAUDE_USER" }] };
      const claudeStale = { matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: "x/septum-pre-write.sh --exit-code-2" }] };
      const claudePath = path.join(dir, ".claude/settings.json");
      fs.writeFileSync(claudePath, JSON.stringify({ hooks: { PreToolUse: [claudeUser, claudeStale] } }));
      configureHarness("claude", dir, false);
      const claudeAfter = JSON.parse(fs.readFileSync(claudePath, "utf-8")).hooks.PreToolUse;
      expect(claudeAfter).toHaveLength(2);
      expect(claudeAfter[0]).toEqual(claudeUser);
      expect(claudeAfter[1].hooks[0].command).toContain("--claude");
      expect(claudeAfter[1].hooks[0].command).not.toContain("--exit-code-2");

      // OpenCode v1 -> v2
      const { SEPTUM_OPENCODE_PLUGIN_MARKER } = await import("../../src/cli/templates/opencode-plugin.ts");
      const ocPath = path.join(dir, ".opencode/plugins/septum.ts");
      fs.mkdirSync(path.dirname(ocPath), { recursive: true });
      fs.writeFileSync(ocPath, `${SEPTUM_OPENCODE_PLUGIN_MARKER}\nexport const SeptumBoundaryGuard = async () => ({ "tool.execute.before": async () => {} });\n`);
      configureHarness("opencode", dir, false);
      const ocAfter = fs.readFileSync(ocPath, "utf-8");
      expect(ocAfter).toContain("export default {");
      expect(ocAfter).toContain('ctx.tool.hook("execute.before"');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
