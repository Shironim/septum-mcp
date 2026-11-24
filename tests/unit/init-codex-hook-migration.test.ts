import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configureHarness } from "../../src/cli/scaffold/harness-config.ts";

describe("Codex PreToolUse hook migration", () => {
  it("rewrites legacy --exit-code-2 Septum hook without --force and keeps user hooks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-codex-mig-"));
    try {
      fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
      const user = { matcher: "Bash", hooks: [{ type: "command", command: "echo USER" }] };
      const legacy = { matcher: "Write|Edit|Bash", hooks: [{ type: "command", command: "x/septum-pre-write.sh --exit-code-2" }] };
      const p = path.join(dir, ".codex/hooks.json");
      fs.writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [user, legacy] } }));
      configureHarness("codex", dir, false);
      const after = JSON.parse(fs.readFileSync(p, "utf-8")).hooks.PreToolUse;
      expect(after[0]).toEqual(user);
      expect(after).toHaveLength(2);
      expect(after[1].matcher).toContain("apply_patch");
      expect(after[1].hooks[0].command).toContain("--codex");
      expect(after[1].hooks[0].command).not.toContain("--exit-code-2");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
