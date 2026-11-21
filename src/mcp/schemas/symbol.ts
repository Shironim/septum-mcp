import { z } from "zod";
import { extractSingleStringFallback, SymbolReferenceSchema, withAliases } from "./shared.ts";

export function normalizeLocateSymbolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "query", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "target_path",
    "path",
    "domain",
    "domain_name",
    "domainName",
    "file_path",
    "filePath",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    symbol: "query",
    name: "query",
    symbol_name: "query",
    symbolName: "query",
    target: "query",
    domain_name: "domain",
    domainName: "domain",
    max: "limit",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
    target_path: "workspace_path",
    path: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  } else if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  }
  if (!obj.query && !obj.symbol && typeof obj.symbol_ref === "object" && obj.symbol_ref !== null) {
    obj.query = (obj.symbol_ref as Record<string, unknown>).name;
    obj.symbol = obj.query;
  }
  return obj;
}

export const LocateSymbolSchema = z.preprocess(
  normalizeLocateSymbolArgs,
  z.object({
    query: z.string().min(1, "query is required"),
    symbol: z.string().optional(),
    domain: z.string().optional(),
    symbol_ref: SymbolReferenceSchema.optional(),
    file_path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional().default(10),
    format: z.enum(["json", "text"]).optional().default("text"),
    workspace_path: z.string().optional(),
  })
);
export type LocateSymbolArgs = z.infer<typeof LocateSymbolSchema>;

export function normalizeGetSymbolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "symbol", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "domain",
    "domain_name",
    "domainName",
    "file_path",
    "filePath",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    query: "symbol",
    name: "symbol",
    symbol_name: "symbol",
    symbolName: "symbol",
    target: "symbol",
    domain_name: "domain",
    domainName: "domain",
    includeDependencies: "include_dependencies",
    include_deps: "include_dependencies",
    includeDeps: "include_dependencies",
    dependencies: "include_dependencies",
    deps: "include_dependencies",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  } else if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  }
  if (!obj.query && !obj.symbol && typeof obj.symbol_ref === "object" && obj.symbol_ref !== null) {
    obj.query = (obj.symbol_ref as Record<string, unknown>).name;
    obj.symbol = obj.query;
  }
  return obj;
}

export const GetSymbolSchema = z.preprocess(
  normalizeGetSymbolArgs,
  z.object({
    symbol: z.string().min(1, "symbol is required"),
    query: z.string().optional(),
    domain: z.string().optional(),
    symbol_ref: SymbolReferenceSchema.optional(),
    include_dependencies: z.boolean().optional().default(true),
    workspace_path: z.string().optional(),
    file_path: z.string().min(1).optional(),
    include_source: z.boolean().optional().default(false),
    source_start_line: z.number().int().positive().optional(),
    source_line_limit: z.number().int().positive().max(200).optional().default(120),
  })
);
export type GetSymbolArgs = z.infer<typeof GetSymbolSchema>;

export function normalizeGetSymbolImpactArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "symbol");
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    query: "symbol",
    name: "symbol",
    symbol_name: "symbol",
    symbolName: "symbol",
    file_path: "symbol",
    filePath: "symbol",
    file: "symbol",
    path: "symbol",
    target: "symbol",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  } else if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  }
  return obj;
}

export const GetSymbolImpactSchema = z.preprocess(
  normalizeGetSymbolImpactArgs,
  z.object({
    symbol: z.string().min(1, "symbol is required"),
    query: z.string().optional(),
    domain: z.string().optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetSymbolImpactArgs = z.infer<typeof GetSymbolImpactSchema>;

export function normalizeSymbolToolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "query", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "action",
    "domain",
    "domain_name",
    "domainName",
    "file_path",
    "filePath",
    "limit",
    "format",
    "output_format",
    "outputFormat",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    symbol: "query",
    name: "query",
    symbol_name: "query",
    symbolName: "query",
    target: "query",
    domain_name: "domain",
    domainName: "domain",
    includeDependencies: "include_dependencies",
    include_deps: "include_dependencies",
    includeDeps: "include_dependencies",
    dependencies: "include_dependencies",
    deps: "include_dependencies",
    max: "limit",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
    filePath: "file_path",
    sourceStartLine: "source_start_line",
    sourceLineLimit: "source_line_limit",
    semanticDepth: "semantic_depth",
    maxDepth: "max_depth",
    output_format: "format",
    outputFormat: "format",
  }) as Record<string, unknown>;

  if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  } else if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  }

  if (!obj.action) {
    if (obj.budget_bytes !== undefined || obj.continuation !== undefined || obj.context_mode !== undefined || obj.max_depth !== undefined) {
      obj.action = "context";
    } else if (obj.include_dependencies !== undefined || obj.include_source !== undefined ||
      obj.source_start_line !== undefined || obj.source_line_limit !== undefined) {
      obj.action = "context";
    } else {
      obj.action = "locate";
    }
  }

  if (!obj.query && !obj.symbol && typeof obj.symbol_ref === "object" && obj.symbol_ref !== null) {
    obj.query = (obj.symbol_ref as Record<string, unknown>).name;
    obj.symbol = obj.query;
  }
  if (obj.action === "inspect") obj.action = "context";
  return obj;
}

export const SymbolToolSchema = z.preprocess(
  normalizeSymbolToolArgs,
  z.object({
    action: z.enum(["locate", "inspect", "impact", "context"]).optional().default("locate"),
    query: z.string().optional(),
    symbol: z.string().optional(),
    domain: z.string().optional(),
    symbol_ref: SymbolReferenceSchema.optional(),
    include_dependencies: z.boolean().optional().default(true),
    limit: z.number().int().positive().optional(),
    workspace_path: z.string().optional(),
    file_path: z.string().min(1).optional(),
    include_source: z.boolean().optional(),
    source_start_line: z.number().int().positive().optional(),
    source_line_limit: z.number().int().positive().max(200).optional(),
    semantic_depth: z.number().int().min(1).max(2).optional(),
    context_mode: z.enum(["deep", "source"]).optional(),
    budget_bytes: z.number().int().min(2048).max(2 * 1024 * 1024).optional(),
    max_depth: z.number().int().min(1).max(4).optional(),
    continuation: z.string().min(1).max(4096).optional(),
    format: z.enum(["json", "text"]).optional().default("text"),
  }).superRefine((args, ctx) => {
    if (args.symbol_ref && args.action !== "locate" && args.action !== "inspect" && args.action !== "impact" && args.action !== "context") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["symbol_ref"], message: "symbol_ref is supported only for locate, inspect, impact, and context." });
    }
    if (args.action !== "context" && (args.budget_bytes !== undefined || args.continuation !== undefined || args.max_depth !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "budget_bytes, max_depth, and continuation are supported only for context." });
    }
    if (args.context_mode !== undefined && args.action !== "context") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["context_mode"], message: "context_mode requires action='context' or its inspect alias." });
    }
    if (args.context_mode === "deep" && (args.include_source !== undefined || args.source_start_line !== undefined || args.source_line_limit !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["context_mode"], message: "Deep context does not accept bounded source options." });
    }
  })
);
export type SymbolToolArgs = z.infer<typeof SymbolToolSchema>;
