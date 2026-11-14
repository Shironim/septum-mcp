import { z } from "zod";

function withAliases(raw: unknown, aliases: Record<string, string>): unknown {
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

export function normalizeBoundaryArgs(raw: unknown): unknown {
  if (Array.isArray(raw) && raw.length > 1 && raw.every((item) => typeof item === "string")) {
    raw = { file_paths: raw };
  }
  const coerced = extractSingleStringFallback(raw, "file_path", [
    "action",
    "plan_ref",
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "scope",
    "domain",
    "domain_name",
    "domainName",
    "feature_key",
    "featureKey",
    "feature",
    "feature_name",
    "featureName",
    "name",
    "key",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = { ...(coerced as Record<string, unknown>) };
  const aliases: Record<string, string> = {
    filePath: "file_path",
    file: "file_path",
    path: "file_path",
    from_file: "file_path",
    fromFile: "file_path",
    source_file: "file_path",
    sourceFile: "file_path",
    filePaths: "file_paths",
    files: "file_paths",
    paths: "file_paths",
    proposedImports: "proposed_imports",
    imports: "proposed_imports",
    featureKey: "feature_key",
    feature: "feature_key",
    feature_name: "feature_key",
    featureName: "feature_key",
    name: "feature_key",
    key: "feature_key",
    domain_name: "domain",
    domainName: "domain",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  };
  obj.proposed_imports_supplied ??= ["proposed_imports", "proposedImports", "imports", "to_file", "toFile"].some(key => Object.prototype.hasOwnProperty.call(obj, key));
  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
    }
  }

  if (obj.feature_key !== undefined && obj.feature === undefined) {
    obj.feature = obj.feature_key;
  } else if (obj.feature !== undefined && obj.feature_key === undefined) {
    obj.feature_key = obj.feature;
  }

  if (obj.to_file || obj.toFile) {
    const rawTo = obj.to_file ?? obj.toFile;
    const toFiles = Array.isArray(rawTo) ? rawTo.map(String) : [String(rawTo)];
    if (!obj.proposed_imports) {
      obj.proposed_imports = toFiles;
    } else if (Array.isArray(obj.proposed_imports)) {
      obj.proposed_imports = [...obj.proposed_imports, ...toFiles];
    }
  }
  if (Array.isArray(obj.file_path) && !obj.file_paths) {
    obj.file_paths = obj.file_path;
    delete obj.file_path;
  }
  if (typeof obj.file_paths === "string" && !obj.file_path) {
    obj.file_path = obj.file_paths;
    delete obj.file_paths;
  }
  if (obj.scope === undefined) {
    if (obj.staged === true) {
      obj.scope = "staged";
    } else if (obj.domain !== undefined && obj.file_path === undefined && obj.file_paths === undefined) {
      obj.scope = "domain";
    }
  }
  return obj;
}

export function normalizeDomainCatalogArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "domain", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "target_path",
    "path",
    "archetype_filter",
    "archetype",
    "archetypeFilter",
    "type",
    "detail_level",
    "detailLevel",
    "mode",
    "format",
    "file_filter",
    "fileFilter",
    "file",
    "filter",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    domain_name: "domain",
    domainName: "domain",
    name: "domain",
    archetype: "archetype_filter",
    archetypeFilter: "archetype_filter",
    type: "archetype_filter",
    detailLevel: "detail_level",
    mode: "detail_level",
    format: "detail_level",
    fileFilter: "file_filter",
    file: "file_filter",
    filter: "file_filter",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
    target_path: "workspace_path",
    path: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.domain !== undefined && obj.name === undefined) {
    obj.name = obj.domain;
  } else if (obj.name !== undefined && obj.domain === undefined) {
    obj.domain = obj.name;
  }
  if (obj.archetype_filter !== undefined && obj.archetype === undefined) {
    obj.archetype = obj.archetype_filter;
  } else if (obj.archetype !== undefined && obj.archetype_filter === undefined) {
    obj.archetype_filter = obj.archetype;
  }
  if (obj.full === true && obj.detail_level === undefined) {
    obj.detail_level = "full";
  }
  return obj;
}

export const GetDomainCatalogSchema = z.preprocess(
  normalizeDomainCatalogArgs,
  z.object({
    domain: z.string().optional(),
    name: z.string().optional(),
    archetype_filter: z.string().optional(),
    archetype: z.string().optional(),
    detail_level: z.enum(["compact", "full"]).optional().default("compact"),
    file_filter: z.string().optional(),
    file_offset: z.number().int().nonnegative().optional(),
    file_limit: z.number().int().min(1).max(100).optional(),
    include_evidence: z.boolean().optional(),
    include_capabilities: z.boolean().optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetDomainCatalogArgs = z.infer<typeof GetDomainCatalogSchema>;

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

export const SymbolReferenceSchema = z.object({
  file_path: z.string().min(1), language: z.string().min(1), name: z.string().min(1), kind: z.string().min(1),
  signature: z.string(), start_line: z.number().int().positive(), end_line: z.number().int().positive(),
  indexed_content_hash: z.string().min(1), container: z.string().optional(), receiver: z.string().optional(),
}).refine(ref => ref.end_line >= ref.start_line, { message: "end_line must be at or after start_line" });

export const LocateSymbolSchema = z.preprocess(
  normalizeLocateSymbolArgs,
  z.object({
    query: z.string().min(1, "query is required"),
    symbol: z.string().optional(),
    domain: z.string().optional(),
    symbol_ref: SymbolReferenceSchema.optional(),
    file_path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional().default(10),
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

export function normalizeTraceVerticalSliceArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "query", [
    "workspace_path", "workspacePath", "workspace", "project_root", "projectRoot", "controller_file",
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
    workspace_path: z.string().optional(),
  })
);
export type TraceVerticalSliceArgs = z.infer<typeof TraceVerticalSliceSchema>;

export const CheckBoundarySchema = z.preprocess(
  normalizeBoundaryArgs,
  z.object({
    file_path: z.string().trim().min(1, "file_path cannot be blank").optional(),
    file_paths: z.array(z.string().trim().min(1, "file_paths cannot contain blank paths")).optional(),
    proposed_imports: z.array(z.string()).optional().default([]),
    proposed_imports_supplied: z.boolean().optional().default(false),
    scope: z.enum(["file", "all", "staged", "domain"]).optional(),
    domain: z.string().trim().min(1, "domain cannot be blank").optional(),
    staged: z.boolean().optional(),
    workspace_path: z.string().optional(),
  }).superRefine((args, ctx) => {
    const hasBatch = Boolean(args.file_paths?.length);
    const hasTarget = args.file_path !== undefined || hasBatch;
    const scope = args.scope ?? (args.staged ? "staged" : hasTarget ? "file" : args.domain ? "domain" : "all");
    if (args.file_path !== undefined && hasBatch) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["file_paths"], message: "Use either file_path or file_paths, not both." });
    }
    if (args.staged && scope !== "staged") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["staged"], message: "staged=true requires scope='staged'." });
    }
    if (scope === "file" && !hasTarget) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["file_path"], message: "scope='file' requires file_path or non-empty file_paths." });
    }
    if (scope !== "file" && hasTarget) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: `scope='${scope}' does not accept file targets. Use scope='file' for proposed-import checks.` });
    }
    if (scope === "domain" && !args.domain) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["domain"], message: "scope='domain' requires a registered domain name." });
    }
    if (scope === "all" && args.domain) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["domain"], message: "scope='all' checks the entire repository. Use scope='domain' to filter a domain." });
    }
    if (scope !== "file" && args.proposed_imports.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["proposed_imports"], message: "proposed_imports requires a file target and scope='file'." });
    }
  })
);
export type CheckBoundaryArgs = z.infer<typeof CheckBoundarySchema>;

export function normalizeRegisterDomainArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "domain", [
    "root",
    "root_path",
    "rootPath",
    "path",
    "root_dir",
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    name: "domain",
    domain_name: "domain",
    domainName: "domain",
    root_path: "root",
    rootPath: "root",
    path: "root",
    allowedDependencies: "allowed_dependencies",
    allowed: "allowed_dependencies",
    forbiddenDependencies: "forbidden_dependencies",
    forbidden: "forbidden_dependencies",
    archetype: "archetypes",
    ingestNow: "ingest_now",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.domain !== undefined && obj.name === undefined) {
    obj.name = obj.domain;
  } else if (obj.name !== undefined && obj.domain === undefined) {
    obj.domain = obj.name;
  }
  return obj;
}

export const RegisterDomainSchema = z.preprocess(
  normalizeRegisterDomainArgs,
  z.object({
    domain: z.string().min(1, "Domain name/identifier is required"),
    name: z.string().optional(),
    root: z.string().min(1, "Domain root path is required"),
    description: z.string().optional(),
    allowed_dependencies: z.array(z.string()).optional(),
    forbidden_dependencies: z.array(z.string()).optional(),
    archetypes: z.record(z.string()).optional(),
    ingest_now: z.boolean().optional().default(false),
    workspace_path: z.string().optional(),
  })
);
export type RegisterDomainArgs = z.infer<typeof RegisterDomainSchema>;

// =========================================================================
// 4 UNIFIED TOOLS SCHEMAS & NORMALIZERS
// =========================================================================

// 1. septum_map
export function normalizeMapToolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "domain", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "target_path",
    "path",
    "action",
    "detail_level",
    "detailLevel",
    "mode",
    "format",
    "archetype_filter",
    "archetype",
    "file_filter",
    "fileFilter",
    "root",
    "root_path",
    "rootPath",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    domain_name: "domain",
    domainName: "domain",
    name: "domain",
    archetype: "archetype_filter",
    archetypeFilter: "archetype_filter",
    type: "archetype_filter",
    detailLevel: "detail_level",
    mode: "detail_level",
    format: "detail_level",
    fileFilter: "file_filter",
    file: "file_filter",
    filter: "file_filter",
    root_path: "root",
    rootPath: "root",
    path: "root",
    allowedDependencies: "allowed_dependencies",
    allowed: "allowed_dependencies",
    forbiddenDependencies: "forbidden_dependencies",
    forbidden: "forbidden_dependencies",
    archetypes: "archetypes",
    ingestNow: "ingest_now",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;

  if (obj.domain !== undefined && obj.name === undefined) {
    obj.name = obj.domain;
  } else if (obj.name !== undefined && obj.domain === undefined) {
    obj.domain = obj.name;
  }

  if (obj.archetype_filter !== undefined && obj.archetype === undefined) {
    obj.archetype = obj.archetype_filter;
  } else if (obj.archetype !== undefined && obj.archetype_filter === undefined) {
    obj.archetype_filter = obj.archetype;
  }

  if (obj.full === true && obj.detail_level === undefined) {
    obj.detail_level = "full";
  }

  if (!obj.action) {
    if (obj.root !== undefined || obj.ingest_now !== undefined) {
      obj.action = "register";
    } else {
      obj.action = "catalog";
    }
  }

  return obj;
}

export const MapToolSchema = z.preprocess(
  normalizeMapToolArgs,
  z.object({
    action: z.enum(["catalog", "register"]).optional().default("catalog"),
    domain: z.string().optional(),
    name: z.string().optional(),
    detail_level: z.enum(["compact", "full"]).optional().default("compact"),
    archetype_filter: z.string().optional(),
    archetype: z.string().optional(),
    file_filter: z.string().optional(),
    file_offset: z.number().int().nonnegative().optional(),
    file_limit: z.number().int().min(1).max(100).optional(),
    include_evidence: z.boolean().optional(),
    include_capabilities: z.boolean().optional(),
    root: z.string().optional(),
    description: z.string().optional(),
    allowed_dependencies: z.array(z.string()).optional(),
    forbidden_dependencies: z.array(z.string()).optional(),
    archetypes: z.record(z.string()).optional(),
    ingest_now: z.boolean().optional().default(false),
    workspace_path: z.string().optional(),
  })
);
export type MapToolArgs = z.infer<typeof MapToolSchema>;

// 2. septum_symbol
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
  }) as Record<string, unknown>;

  if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  } else if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  }

  if (!obj.action) {
    if (obj.budget_bytes !== undefined || obj.continuation !== undefined || obj.context_mode !== undefined) {
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
    continuation: z.string().min(1).max(4096).optional(),
  }).superRefine((args, ctx) => {
    if (args.symbol_ref && args.action !== "locate" && args.action !== "inspect" && args.action !== "impact" && args.action !== "context") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["symbol_ref"], message: "symbol_ref is supported only for locate, inspect, impact, and context." });
    }
    if (args.action !== "context" && (args.budget_bytes !== undefined || args.continuation !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "budget_bytes and continuation are supported only for context." });
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

// 3. septum_slice
export const SliceToolSchema = TraceVerticalSliceSchema;
export type SliceToolArgs = TraceVerticalSliceArgs;

// 4. septum_boundary
export const BoundaryToolSchema = CheckBoundarySchema;
export type BoundaryToolArgs = CheckBoundaryArgs;

export function parseToolRequest(name: string, args: unknown) {
  switch (name) {
    case "septum_map": return { name, args: MapToolSchema.parse(args ?? {}) } as const;
    case "septum_symbol": return { name, args: SymbolToolSchema.parse(args ?? {}) } as const;
    case "septum_slice": return { name, args: SliceToolSchema.parse(args ?? {}) } as const;
    case "septum_boundary": return { name, args: BoundaryToolSchema.parse(args ?? {}) } as const;
    default: throw new Error(`Unknown tool: '${name}'`);
  }
}

