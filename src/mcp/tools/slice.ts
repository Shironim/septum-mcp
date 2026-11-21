import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { VerticalSliceTracer } from "../../core/resolver/vertical-slice-tracer.ts";
import { formatSliceNode, SLICE_RELATIONSHIP_LIMITS } from "../../core/resolver/slice-format.ts";
import type { VerticalSliceTraceResponse } from "../../types/index.ts";
import { formatSliceAsText } from "../formatters/compact-text.ts";
import type { SliceToolArgs, TraceVerticalSliceArgs } from "../schemas.ts";

export type { SliceToolArgs, TraceVerticalSliceArgs };

export function handleSliceTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: SliceToolArgs,
  workspaceRoot?: string,
  signal?: AbortSignal
) {
  return handleTraceVerticalSlice(repo, config, args, workspaceRoot, signal);
}

export function handleTraceVerticalSlice(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: Partial<TraceVerticalSliceArgs> & { route?: string },
  workspaceRoot?: string,
  signal?: AbortSignal
) {
  const query = (args.query || args.symbol || args.route || "").toString().trim();

  if (!query) {
    throw new Error(
      "Missing required argument: 'query' (e.g. 'POST /orders/{id}/status', 'OrderController@updateStatus', or task intent 'Ubah status order di dashboard')"
    );
  }

  const root =
    workspaceRoot ||
    args.workspace_path ||
    ((config.settings as Record<string, unknown>)?.workspace_root as string) ||
    process.cwd();
  const maxDepth = Math.min(Math.max(Math.trunc(Number(args.max_depth ?? 5)), 1), 8);
  const tracer = new VerticalSliceTracer(repo, root, config.settings.ignore_patterns, false);

  return tracer.traceAsync(query, maxDepth, signal, args.controller_file).then((result: VerticalSliceTraceResponse) => {
    const chain = result.chain || result.slice || [];

    let summary = "";
    if (result.found && chain.length > 0) {
      summary = chain.map(formatSliceNode).join("\n");
    } else if (result.found && result.entrypoint) {
      summary = `[ENTRYPOINT] ${result.entrypoint.method} ${result.entrypoint.uri}; catalog handler ${result.entrypoint.controller}@${result.entrypoint.action} [unknown; unknown]`;
    } else if (result.diagnostics?.length) {
      summary = ` [UNKNOWN] ${result.message || `No matching slice in the available static catalog for '${query}'.`}`.trim();
    } else {
      summary = `[NOT FOUND] No matching slice in the available static catalog for '${query}'; this does not prove the route is absent at runtime.`;
    }
    if (result.diagnostics?.includes("ambiguous_target")) {
      summary = `[AMBIGUOUS] ${result.message}`;
    } else if (result.diagnostics?.length && result.found) {
      summary = `[UNKNOWN: ${result.diagnostics.join(", ")}]\n${summary}`;
    }

    const nextHints = result.next ?? [
      result.found && result.entrypoint?.action && result.entrypoint?.file
        ? `Use septum_symbol(action='context', query='${result.entrypoint.action}', file_path='${result.entrypoint.file}') to inspect handler source/contracts; read the selected mode, freshness and omissions.`
        : result.found
        ? "Inspect the selected implementation and unresolved relationships before planning edits."
        : "Refine the query or synchronize the workspace; no match does not prove runtime absence.",
    ];

    const payload = {
      status: result.diagnostics?.includes("ambiguous_target") ? "ambiguous" : result.diagnostics?.length ? "unknown" : result.found ? "success" : "not_found",
      coverage: result.coverage,
      diagnostics: result.diagnostics,
      next: nextHints,
      controller_file_filter: args.controller_file ?? null,
      query,
      found: result.found,
      confidence: result.confidence,
      confidence_scope: "query_to_catalog_target_only",
      relationship_limits: SLICE_RELATIONSHIP_LIMITS,
      execution_order: "not_established",
      branch_scope: "Static relationships can span mutually exclusive handler actions; this is not one executed branch.",
      is_exact_match: result.is_exact_match,
      architecture_style: result.architecture_style,
      max_depth_applied: result.max_depth_applied ?? maxDepth,
      entrypoint: result.entrypoint || null,
      chain,
      alternatives: result.alternatives || [],
      candidate_count: result.candidate_count,
      alternatives_omitted: result.alternatives_omitted,
      summary,
      message: result.message || summary,
    };

    const format = args.format ?? "text";
    const text = format === "json" ? JSON.stringify(payload) : formatSliceAsText(payload);
    return {
      content: [{ type: "text" as const, text }],
      metadata: {
        status: payload.status,
        found: payload.found,
        confidence: payload.confidence,
        query: payload.query,
        chain_length: payload.chain.length,
        format,
      },
    };
  });
}
