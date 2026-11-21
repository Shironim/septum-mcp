import { z } from "zod";
import { extractSingleStringFallback, withAliases } from "./shared.ts";

export function normalizeTraceVerticalSliceArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "query", [
    "workspace_path", "workspacePath", "workspace", "project_root", "projectRoot", "controller_file",
    "format", "output_format", "outputFormat",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    route: "query",
    uri: "query",
    route_uri: "query",
    routeUri: "query",
    entry_file: "query",
    entryFile: "query",
    file_path: "query",
    filePath: "query",
    file: "query",
    path: "query",
    symbol: "query",
    name: "query",
    feature: "query",
    feature_key: "query",
    featureKey: "query",
    maxDepth: "max_depth",
    depth: "max_depth",
    output_format: "format",
    outputFormat: "format",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  } else if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  }
  if (obj.max_depth !== undefined && obj.max_depth !== null && !Number.isNaN(Number(obj.max_depth))) {
    obj.max_depth = Math.min(Math.max(Math.trunc(Number(obj.max_depth)), 1), 8);
  }
  return obj;
}

export const TraceVerticalSliceSchema = z.preprocess(
  normalizeTraceVerticalSliceArgs,
  z.object({
    query: z.string().min(1, "query is required"),
    symbol: z.string().optional(),
    controller_file: z.string().min(1).optional(),
    max_depth: z.number().int().min(1).max(8).optional().default(5),
    format: z.enum(["json", "text"]).optional().default("text"),
    workspace_path: z.string().optional(),
  })
);
export type TraceVerticalSliceArgs = z.infer<typeof TraceVerticalSliceSchema>;

export const SliceToolSchema = TraceVerticalSliceSchema;
export type SliceToolArgs = TraceVerticalSliceArgs;
