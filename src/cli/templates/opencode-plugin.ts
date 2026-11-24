/**
 * OpenCode v2 uses in-process plugins (`export default { id, setup(ctx) }`).
 * Adapts `ctx.tool.hook("execute.before")` to `septum hook pre-write --opencode`
 * (exit 2 + stderr reason, empty stdout).
 */
export const SEPTUM_OPENCODE_PLUGIN_MARKER = "// septum-managed: opencode boundary guard";

export const SEPTUM_OPENCODE_PLUGIN = `${SEPTUM_OPENCODE_PLUGIN_MARKER}
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const WRITE_TOOLS = new Set(["edit", "write", "patch", "morph_edit", "apply_patch"]);

class SeptumGuardError extends Error {}

function runSeptumPreWrite(directory: string, payload: string) {
  const opts = {
    cwd: directory,
    input: payload,
    encoding: "utf-8" as const,
    windowsHide: true,
    env: { ...process.env, SEPTUM_HOOK_ROOT: directory },
  };
  const localTs = path.join(directory, "bin", "septum.ts");
  if (fs.existsSync(localTs)) {
    const bunRes = spawnSync("bun", ["run", localTs, "hook", "pre-write", "--opencode"], opts);
    if (!bunRes.error) return bunRes;
  }
  const localBin = path.join(directory, "node_modules", ".bin", "septum");
  if (fs.existsSync(localBin)) {
    const binRes = spawnSync(localBin, ["hook", "pre-write", "--opencode"], opts);
    if (!binRes.error) return binRes;
  }
  return spawnSync("septum", ["hook", "pre-write", "--opencode"], opts);
}

export default {
  id: "septum-boundary-guard",
  setup: (ctx: any) => {
    const directory: string =
      ctx?.location?.directory ?? ctx?.location?.path ?? ctx?.directory ?? process.cwd();

    ctx.tool.hook("execute.before", (s: any) => {
      try {
        const tool = String(s?.tool ?? "");
        if (!WRITE_TOOLS.has(tool)) return;

        const input = (s?.input ?? {}) as Record<string, unknown>;
        const toolInput: Record<string, unknown> = {
          file_path: input.filePath ?? input.path ?? input.file ?? input.TargetFile,
        };
        if (typeof input.content === "string") toolInput.content = input.content;
        if (typeof input.command === "string") toolInput.command = input.command;
        const newStr = input.newString ?? input.new_string;
        const oldStr = input.oldString ?? input.old_string;
        if (typeof newStr === "string") {
          toolInput.new_string = newStr;
          if (typeof oldStr === "string") toolInput.old_string = oldStr;
          if (input.replaceAll === true || input.replace_all === true) {
            toolInput.replace_all = true;
          }
        }

        const res = runSeptumPreWrite(
          directory,
          JSON.stringify({ tool_name: tool, tool_input: toolInput })
        );
        if (res.error) return; // septum not installed: fail open
        if (res.status !== 0) {
          throw new SeptumGuardError((res.stderr || "Septum boundary check failed").trim());
        }
      } catch (err) {
        if (err instanceof SeptumGuardError) throw err;
      }
    });
  },
};
`;
