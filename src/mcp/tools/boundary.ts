import type { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { BoundaryToolArgs } from "../schemas.ts";
import { handleCheckBoundary } from "./check-boundary.ts";
import { evaluateChangePlan } from "../../core/boundary/change-plan.ts";

export type { BoundaryToolArgs };

export async function handleBoundaryTool(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  args: BoundaryToolArgs,
  repo?: SeptumRepository,
  workspaceRoot?: string,
  rawArgs?: unknown
) {
  if (args.action === "plan" || args.action === "verify") {
    if (!repo) throw new Error("Change plans require an initialized workspace repository.");
    return evaluateChangePlan(evaluator, config, args, repo, workspaceRoot || args.workspace_path || process.cwd(), async (file, imports, feature) => {
      const result = await handleCheckBoundary(evaluator, structuredClone(config), {
        scope: "file", file_path: file, proposed_imports: imports, feature_key: feature,
      }, repo, workspaceRoot || args.workspace_path);
      return JSON.parse(result.content[0]!.text);
    }, async () => {
      const result = await handleCheckBoundary(evaluator, structuredClone(config), { scope: "all", proposed_imports: [] }, repo, workspaceRoot || args.workspace_path);
      return JSON.parse(result.content[0]!.text);
    });
  }
  // Preserve whether imports were actually supplied before schema defaults.
  return await handleCheckBoundary(evaluator, config, (rawArgs ?? args) as any, repo, workspaceRoot);
}
