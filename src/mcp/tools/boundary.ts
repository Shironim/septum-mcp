import type { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import { evaluateBoundary as auditBoundary } from "../../core/boundary/audit.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { formatBoundaryAsText } from "../formatters/compact-text.ts";
import { CheckBoundarySchema, type BoundaryToolArgs, type CheckBoundaryArgs } from "../schemas.ts";

export type { BoundaryToolArgs, CheckBoundaryArgs };

export async function handleBoundaryTool(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  args: BoundaryToolArgs,
  repo?: SeptumRepository,
  workspaceRoot?: string
) {
  return await evaluateBoundary(evaluator, config, args, repo, workspaceRoot);
}

export async function handleCheckBoundary(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  rawArgs: unknown,
  repo?: SeptumRepository,
  workspaceRoot?: string,
) {
  return evaluateBoundary(evaluator, config, CheckBoundarySchema.parse(rawArgs ?? {}), repo, workspaceRoot);
}

export async function evaluateBoundary(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  args: CheckBoundaryArgs,
  repo?: SeptumRepository,
  workspaceRoot?: string,
) {
  const effectiveRoot = workspaceRoot ?? args.workspace_path ?? evaluator.getResolver().getProjectRoot();
  const audit = await auditBoundary(
    evaluator, config, args, repo, effectiveRoot,
  );
  return renderBoundaryAudit(audit, args.max_bytes, args.format ?? "text", effectiveRoot);
}

export function renderBoundaryAudit(
  { payload, kind }: Awaited<ReturnType<typeof auditBoundary>>,
  maxBytes?: number,
  format: "json" | "text" = "text",
  workspaceRoot?: string,
) {
  const structuredPayload = workspaceRoot
    ? { workspace_root: workspaceRoot, ...(payload as Record<string, unknown>) }
    : (payload as Record<string, unknown>);
  const rendered = format === "json"
    ? JSON.stringify(structuredPayload, null, kind === "evaluated" ? 2 : undefined)
    : formatBoundaryAsText(structuredPayload as Record<string, any>);
  const result = {
    content: [{ type: "text" as const, text: rendered }],
    structuredContent: structuredPayload,
    metadata: { status: payload.status, format },
  };
  if (maxBytes === undefined) return result;

  const compact = format === "json"
    ? { ...result, content: [{ type: "text" as const, text: JSON.stringify(structuredPayload) }] }
    : result;
  const requiredBytes = Buffer.byteLength(JSON.stringify(compact));
  if (requiredBytes <= maxBytes) return compact;

  const errPayload = {
    status: "unknown",
    code: "BUDGET_RESPONSE_TOO_LARGE",
    required_bytes: requiredBytes,
    max_bytes: maxBytes,
    message: "Increase max_bytes or narrow the audit scope.",
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: format === "json" ? JSON.stringify(errPayload) : formatBoundaryAsText(errPayload) }],
    structuredContent: errPayload,
    metadata: { status: "unknown" as const, code: "BUDGET_RESPONSE_TOO_LARGE", format },
  };
}
