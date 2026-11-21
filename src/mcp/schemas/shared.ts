import { z } from "zod";

export function withAliases(raw: unknown, aliases: Record<string, string>): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
    }
  }
  return obj;
}

export function extractSingleStringFallback(
  raw: unknown,
  targetField: string,
  ignoredKeys: string[] = ["workspace_path", "workspacePath", "workspace", "project_root", "projectRoot"]
): unknown {
  if (typeof raw === "string") {
    return { [targetField]: raw };
  }
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string") {
    return { [targetField]: raw[0] };
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = { ...(raw as Record<string, unknown>) };
    if (obj[targetField] !== undefined && typeof obj[targetField] === "string" && (obj[targetField] as string).trim() !== "") {
      return obj;
    }
    const nonIgnoredEntries = Object.entries(obj).filter(
      ([key, val]) => !ignoredKeys.includes(key) && typeof val === "string" && (val as string).trim() !== ""
    );
    if (nonIgnoredEntries.length === 1) {
      obj[targetField] = nonIgnoredEntries[0][1];
    }
    return obj;
  }
  return raw;
}

export const SymbolReferenceSchema = z.object({
  file_path: z.string().min(1),
  language: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  signature: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  indexed_content_hash: z.string().min(1),
  container: z.string().optional(),
  receiver: z.string().optional(),
}).refine(ref => ref.end_line >= ref.start_line, { message: "end_line must be at or after start_line" });
