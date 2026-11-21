import { z } from "zod";
import { extractSingleStringFallback } from "./shared.ts";

export function normalizeBoundaryArgs(raw: unknown): unknown {
  if (Array.isArray(raw) && raw.length > 1 && raw.every((item) => typeof item === "string")) {
    raw = { file_paths: raw };
  }
  const coerced = extractSingleStringFallback(raw, "file_path", [
    "action",
    "plan_ref",
    "workspace_path",
    "max_bytes",
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
    "format",
    "output_format",
    "outputFormat",
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
    output_format: "format",
    outputFormat: "format",
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
    format: z.enum(["json", "text"]).optional().default("text"),
    workspace_path: z.string().optional(),
    max_bytes: z.number().int().min(512).max(2 * 1024 * 1024).optional(),
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

export const BoundaryToolSchema = CheckBoundarySchema;
export type BoundaryToolArgs = CheckBoundaryArgs;
