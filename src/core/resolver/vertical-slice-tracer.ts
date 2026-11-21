import { refreshSliceCatalog } from "./slice-catalog.ts";
import { selectSliceTarget } from "./slice-selection.ts";
import type {
  ExecutionChainNode,
  VerticalSliceRecord,
  VerticalSliceTraceResponse,
} from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { CallGraphTracer } from "./call-graph-tracer.ts";
import { formatSliceNode, parseSliceChain, SLICE_RELATIONSHIP_LIMITS } from "./slice-format.ts";

export class VerticalSliceTracer {
  constructor(private repo: SeptumRepository, private projectRoot: string = process.cwd(), private ignorePatterns: string[] = [], private verifyMembership = true) {}

  public async traceAsync(rawQuery: string, maxDepth = 5, signal?: AbortSignal, controllerFile?: string): Promise<VerticalSliceTraceResponse> {
    signal?.throwIfAborted();
    if (this.repo.getMeta("sync_state") === "error" || this.repo.getMeta("sync_state") === "running") {
      return { query: rawQuery, found: false, coverage: "partial", diagnostics: ["index_incomplete"], message: "Workspace synchronization is incomplete." };
    }
    try {
      await refreshSliceCatalog(this.repo, this.projectRoot, {
        ignorePatterns: this.ignorePatterns,
        signal,
        verifyMembership: this.verifyMembership,
      });
    } catch (error) {
      signal?.throwIfAborted();
      return { query: rawQuery, found: false, coverage: "partial", diagnostics: [error instanceof Error ? error.message : String(error)], message: "Semantic extraction failed; no complete catalog was published." };
    }
    return this.trace(rawQuery, maxDepth, controllerFile);
  }


  /**
   * Trace an end-to-end vertical slice from route/action/intent query.
   * Examples of queries:
   *  - "POST /orders/{id}/status"
   *  - "/orders/{id}/status"
   *  - "OrderController@updateStatus"
   *  - "OrderController::updateStatus"
   *  - "orders.update_status"
   *  - "createOrder"
   *  - "Ubah status order di dashboard"
   */
  // Synchronous compatibility API reads persisted slices only; use traceAsync for on-demand extraction.
  public trace(rawQuery: string, maxDepth: number = 5, controllerFile?: string): VerticalSliceTraceResponse {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const selection = selectSliceTarget(this.repo.getAllVerticalSlices(), rawQuery, effectiveMaxDepth, controllerFile);
    if ("record" in selection) {
      return this.formatSuccessResponse(selection.query, selection.record, selection.confidence, selection.alternatives, effectiveMaxDepth);
    }
    return selection;
  }

  private formatSuccessResponse(
    query: string,
    record: VerticalSliceRecord,
    confidence: "exact" | "inferred" = "exact",
    alternatives?: VerticalSliceRecord[],
    effectiveMaxDepth: number = 5
  ): VerticalSliceTraceResponse {
    let chain: ExecutionChainNode[] = [];
    const diagnostics: string[] = [];
    try {
      chain = parseSliceChain(record.execution_chain_json);
    } catch {
      diagnostics.push("invalid_execution_chain");
    }

    // Import expansion is derived per request, so cached depth cannot override the requested hop limit.
    chain = chain.filter(node => node.relationship?.kind !== "imports" && !node.description?.includes("(dependency)"));
    // Go imports resolve whole packages; expanding them injects unrelated handlers/services.
    if (
      record.architecture_style !== "go-http" && !diagnostics.length && record.controller_file &&
      typeof (this.repo as any).getAllFiles === "function"
    ) {
      try {
        const callGraphTracer = new CallGraphTracer(this.repo, this.projectRoot);
        chain = record.action_name
          ? callGraphTracer.expandChainFromMethod(
              record.controller_file,
              record.action_name,
              chain,
              effectiveMaxDepth
            )
          : callGraphTracer.expandChainFromFile(
              record.controller_file,
              chain,
              effectiveMaxDepth
            );
      } catch {
        diagnostics.push("dependency_expansion_failed");
      }
    }

    if (chain.some(node => node.stage === "ingress" && node.relationship?.derivation === "inferred")) confidence = "inferred";
    let message = `Vertical slice target match (${confidence}): ${record.http_method} ${record.route_uri} -> ${record.controller_class}@${record.action_name} (${chain.length} node(s)).`;
    if (record.architecture_style === "go-http") {
      message += " Go package import expansion is omitted; extracted handler/service relationships remain lexical and partial.";
    }
    if (diagnostics.length) message += ` Analysis incomplete: ${diagnostics.join(", ")}. Run septum sync and retry; inspect source if it persists.`;

    return {
      query,
      found: true,
      coverage: "partial",
      diagnostics: diagnostics.length ? diagnostics : undefined,
      next: diagnostics.length ? ["Run septum sync to rebuild analysis; retry the query. Inspect source directly if the diagnostic persists."] : undefined,
      confidence,
      is_exact_match: confidence === "exact",
      architecture_style: record.architecture_style,
      max_depth_applied: effectiveMaxDepth,
      entrypoint: {
        method: record.http_method,
        uri: record.route_uri,
        name: record.route_name,
        controller: record.controller_class,
        action: record.action_name,
        file: record.controller_file,
        line: record.controller_line,
      },
      chain,
      slice: chain,
      alternatives: alternatives?.map((a) => ({
        method: a.http_method,
        uri: a.route_uri,
        controller: a.controller_class,
        action: a.action_name,
      })),
      message,
    };
  }
}
