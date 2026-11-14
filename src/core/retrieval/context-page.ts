import type { ImportRelationship } from "../../types/index.ts";
import type { ContextValue } from "./typescript-references.ts";

export type SourceItem = {
  selection_role?: "implementation" | "contract";
  kind: "source";
  name: string;
  reason: "target_implementation" | "direct_import_declaration" | "local_dependency";
  source: { file_path: string; indexed_content_hash: string; start_line: number; end_line: number; text: string };
  fragment?: { start_utf16: number; end_utf16: number; total_utf16: number; declaration_start_line: number; declaration_end_line: number };
};
type DiagnosticItem = { kind: "diagnostic"; reason: string; file_path?: string; detail?: string };
export type ContextItem = SourceItem | DiagnosticItem | { kind: "relationship"; reason: "target_file_import"; relationship: ImportRelationship } |
  { kind: "type_contract"; name: string; file_path: string; indexed_content_hash: string; start_line: number; end_line: number;
    projection: "public_instance_signatures"; text: string; inferred_types: "unknown" | "explicit"; fragment?: SourceItem["fragment"] } |
  { kind: "selection"; reason: "known_call_arguments"; file_path: string; start_line: number; arguments: ContextValue[]; pruned_branches: number };

export function response(payload: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
export function budgetedResponse(payload: Record<string, unknown>, budget: number) {
  let bytes = 0;
  for (;;) {
    const result = response({ ...payload, output_bytes: bytes });
    const measured = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes === measured) {
      if (measured > budget) return response({ status: "budget_too_small", minimum_budget_bytes: measured,
        message: "Required response metadata exceeds this budget; retry with a larger budget." });
      return result;
    }
    bytes = measured;
  }
}
interface PageOptions {
  items: ContextItem[];
  start: number;
  sourceOffset: number;
  budget: number;
  incomplete: boolean;
  base: Record<string, unknown> & { query_id: string; snapshot_id: string };
  accounting: { omitted_by_capacity: number; unexpanded_dependency_files: number };
}

export function pageContext(options: PageOptions) {
  const { items: all, start, sourceOffset, budget, incomplete, base, accounting } = options;
  const current = all[start];
  const currentText = current?.kind === "source" ? current.source.text : current?.kind === "type_contract" ? current.text : undefined;
  if (sourceOffset && (currentText === undefined || sourceOffset >= currentText.length ||
    currentText.charCodeAt(sourceOffset - 1) >= 0xd800 && currentText.charCodeAt(sourceOffset - 1) <= 0xdbff ||
    currentText[sourceOffset - 1] === "\r" && currentText[sourceOffset] === "\n"))
    return response({ status: "invalid_continuation", message: "Source fragment offset is outside the selected declaration." });
  const envelope = (items: ContextItem[], end: number, nextSourceOffset = 0) => ({
    ...base,
    status: incomplete || end < all.length || start > 0 || sourceOffset > 0 ? "partial" : "success",
    completeness: incomplete || end < all.length || start > 0 || sourceOffset > 0 ? "partial" : "complete",
    items,
    accounting: { total: all.length, returned: items.length, offset: start, omitted_before: start,
      omitted_after: all.length - end, source_offset: sourceOffset, next_source_offset: nextSourceOffset,
      ...accounting },
    ...(end < all.length && (end > start || nextSourceOffset > sourceOffset) ? { continuation: Buffer.from(JSON.stringify({ query: base.query_id, snapshot: base.snapshot_id, offset: end,
      ...(nextSourceOffset ? { source_offset: nextSourceOffset } : {}) })).toString("base64url") } : {}),
    budget_bytes: budget,
  });
  let end = start;
  const page: ContextItem[] = [];
  let result = budgetedResponse(envelope([], start), budget);
  for (; end < all.length; end++) {
    const item = all[end]!;
    const offset = end === start ? sourceOffset : 0;
    const text = item.kind === "source" ? item.source.text : item.kind === "type_contract" ? item.text : undefined;
    const fragment = (stop: number): ContextItem => {
      if (text === undefined || (item.kind !== "source" && item.kind !== "type_contract")) return item;
      const location = item.kind === "source" ? item.source : item;
      const portion = text.slice(offset, stop);
      const identity = { start_utf16: offset, end_utf16: stop, total_utf16: text.length,
        declaration_start_line: location.start_line, declaration_end_line: location.end_line };
      if (item.kind === "type_contract") return { ...item, text: portion, fragment: identity };
      const line = item.source.start_line + (text.slice(0, offset).match(/\r\n|\r|\n/g)?.length ?? 0);
      const lastLine = line + (portion.match(/\r\n|\r|\n/g)?.length ?? 0) - (/\r\n$|[\r\n]$/.test(portion) ? 1 : 0);
      return { ...item, source: { ...item.source, text: portion, start_line: line, end_line: Math.max(line, lastLine) }, fragment: identity };
    };
    const whole = offset ? fragment(text!.length) : item;
    const next = budgetedResponse(envelope([...page, whole], end + 1), budget);
    if (JSON.parse(next.content[0]!.text).status === "budget_too_small") {
      if (text !== undefined) {
        let low = offset + 1, high = text.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          let stop = middle;
          // Keep UTF-16 surrogate pairs and CRLF boundaries intact.
          if (stop > offset && ((text.charCodeAt(stop - 1) >= 0xd800 && text.charCodeAt(stop - 1) <= 0xdbff) || text[stop - 1] === "\r" && text[stop] === "\n")) stop--;
          if (stop === offset && offset + 2 < text.length) stop = offset + 2;
          const partial = stop > offset ? budgetedResponse(envelope([...page, fragment(stop)], end, stop), budget) : undefined;
          if (partial && JSON.parse(partial.content[0]!.text).status !== "budget_too_small") {
            result = partial; low = middle + 1;
          } else high = middle - 1;
        }
      }
      break;
    }
    page.push(whole);
    result = next;
  }
  if (end === start && all.length > start && !JSON.parse(result.content[0]!.text).continuation) {
    return budgetedResponse({ ...envelope([], start), status: "budget_too_small", completeness: "partial",
      message: "Response metadata and the next item fragment do not fit. Increase budget_bytes; no source was silently omitted." }, budget);
  }
  return result;
}
