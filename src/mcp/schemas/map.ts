import { z } from "zod";
import { extractSingleStringFallback, withAliases } from "./shared.ts";

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
    output_format: "format",
    outputFormat: "format",
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
  if (obj.format === "compact" || obj.format === "full") {
    if (obj.detail_level === undefined) obj.detail_level = obj.format;
    delete obj.format;
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
    format: z.enum(["json", "text"]).optional().default("text"),
    file_filter: z.string().optional(),
    file_offset: z.number().int().nonnegative().optional(),
    file_limit: z.number().int().min(1).max(100).optional(),
    include_evidence: z.boolean().optional(),
    include_capabilities: z.boolean().optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetDomainCatalogArgs = z.infer<typeof GetDomainCatalogSchema>;

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
    output_format: "format",
    outputFormat: "format",
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
  if (obj.format === "compact" || obj.format === "full") {
    if (obj.detail_level === undefined) obj.detail_level = obj.format;
    delete obj.format;
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
    format: z.enum(["json", "text"]).optional().default("text"),
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
