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
  const target = firstString(input, ["TargetFile", "file_path", "filePath", "path", "Path"]) ?? firstString(outer, ["TargetFile", "file_path", "filePath", "path", "Path"]);
  if (!target) return;
  const full = firstString(input, ["CodeContent", "content", "Content"]) ?? firstString(outer, ["CodeContent", "content", "Content"]);
  if (full !== undefined) return { target, content: full, coverage: "complete_candidate" };
  const edits = Array.isArray(input.edits) ? input.edits : Array.isArray(input.ReplacementChunks) ? input.ReplacementChunks : undefined;
  if (edits) {
    let content = readCurrent(target);
    for (const value of edits) {
      const edit = record(value);
      const old = firstString(edit, ["old_string", "TargetContent"]);
      const next = firstString(edit, ["new_string", "ReplacementContent"]);
      if (old === undefined || next === undefined) return { target, content: edits.map(value => firstString(record(value), ["new_string", "ReplacementContent"]) ?? "").join("\n"), coverage: "replacement_fragment" };
      content = replace(content, old, next, edit.replace_all === true);
    }
    return { target, content, coverage: "complete_candidate" };
  }
  const replacement = firstString(input, ["ReplacementContent", "new_string", "Replacement"]) ?? firstString(outer, ["ReplacementContent", "new_string", "Replacement"]);
  if (replacement === undefined) return;
  const old = firstString(input, ["old_string", "TargetContent"]) ?? firstString(outer, ["old_string", "TargetContent"]);
  return { target, content: old === undefined ? replacement : replace(readCurrent(target), old, replacement, input.replace_all === true),
    coverage: old === undefined ? "replacement_fragment" : "complete_candidate" };
}
