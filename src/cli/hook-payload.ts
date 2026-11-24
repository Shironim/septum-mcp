export interface HookEdit {
  target: string;
  content: string;
  coverage: "complete_candidate" | "replacement_fragment";
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof input[key] === "string") return input[key] as string;
}
function replace(source: string, old: string, replacement: string, all = false): string {
  if (!old || !source.includes(old)) throw new Error("Hook edit does not match current source; refresh the file before editing.");
  if (!all && source.indexOf(old) !== source.lastIndexOf(old)) throw new Error("Hook edit is ambiguous; provide a unique old_string or replace_all.");
  return all ? source.split(old).join(replacement) : source.replace(old, () => replacement);
}

/** Normalize supported harness payloads; reconstruct replacements before parsing imports. */
export function normalizeHookEdit(payload: unknown, readCurrent: (target: string) => string): HookEdit | undefined {
  const outer = record(payload);
  const input = record(outer.tool_input ?? outer.arguments ?? record(outer.toolCall).args ?? outer);
  const target = firstString(input, ["TargetFile", "targetFile", "file_path", "filePath", "file", "path", "Path"]) ?? firstString(outer, ["TargetFile", "targetFile", "file_path", "filePath", "file", "path", "Path"]);
  if (!target) return;
  const full = firstString(input, ["CodeContent", "content", "Content"]) ?? firstString(outer, ["CodeContent", "content", "Content"]);
  if (full !== undefined) return { target, content: full, coverage: "complete_candidate" };
  const edits = Array.isArray(input.edits) ? input.edits : Array.isArray(input.ReplacementChunks) ? input.ReplacementChunks : undefined;
  if (edits) {
    let content = readCurrent(target);
    for (const value of edits) {
      const edit = record(value);
      const old = firstString(edit, ["old_string", "oldString", "TargetContent"]);
      const next = firstString(edit, ["new_string", "newString", "ReplacementContent"]);
      if (old === undefined || next === undefined) return { target, content: edits.map(value => firstString(record(value), ["new_string", "newString", "ReplacementContent"]) ?? "").join("\n"), coverage: "replacement_fragment" };
      content = replace(content, old, next, edit.replace_all === true || edit.replaceAll === true);
    }
    return { target, content, coverage: "complete_candidate" };
  }
  const replacement = firstString(input, ["ReplacementContent", "new_string", "newString", "Replacement"]) ?? firstString(outer, ["ReplacementContent", "new_string", "newString", "Replacement"]);
  if (replacement === undefined) return;
  const old = firstString(input, ["old_string", "oldString", "TargetContent"]) ?? firstString(outer, ["old_string", "oldString", "TargetContent"]);
  const replaceAll = input.replace_all === true || input.replaceAll === true || outer.replace_all === true || outer.replaceAll === true;
  return { target, content: old === undefined ? replacement : replace(readCurrent(target), old, replacement, replaceAll),
    coverage: old === undefined ? "replacement_fragment" : "complete_candidate" };
}

/** Codex `apply_patch` sends the patch text as `command`; return one candidate per touched file. */
export function normalizeApplyPatchEdits(payload: unknown): HookEdit[] {
  const outer = record(payload);
  const input = record(outer.tool_input ?? outer.arguments ?? record(outer.toolCall).args ?? outer);
  const command = firstString(input, ["command"]) ?? firstString(outer, ["command"]);
  if (typeof command !== "string" || !command.includes("*** Begin Patch")) return [];
  const edits: HookEdit[] = [];
  let current: { target: string; lines: string[]; add: boolean } | undefined;
  const flush = () => {
    if (current) edits.push({ target: current.target, content: current.lines.join("\n"), coverage: current.add ? "complete_candidate" : "replacement_fragment" });
    current = undefined;
  };
  for (const line of command.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update) File: (.+)$/.exec(line);
    if (header) { flush(); current = { target: header[2].trim(), lines: [], add: header[1] === "Add" }; continue; }
    if (line.startsWith("*** Delete File:") || line.startsWith("*** End Patch")) { flush(); continue; }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) { current.target = move[1].trim(); continue; }
    if (current && line.startsWith("+") && !line.startsWith("+++")) current.lines.push(line.slice(1));
  }
  flush();
  return edits;
}
