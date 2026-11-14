import { rebuildSliceCatalog, sliceInputsCurrent } from "./slice-catalog.ts";
import { scanSourceFiles } from "../resources/source-inventory.ts";
import { relative } from "node:path";
import type {
  ExecutionChainNode,
  VerticalSliceRecord,
  VerticalSliceTraceResponse,
} from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { CallGraphTracer } from "./call-graph-tracer.ts";
import { formatSliceNode, SLICE_RELATIONSHIP_LIMITS } from "./slice-format.ts";

export class VerticalSliceTracer {
  constructor(private repo: SeptumRepository, private projectRoot: string = process.cwd(), private ignorePatterns: string[] = [], private verifyMembership = true) {}

  public async traceAsync(rawQuery: string, maxDepth = 5, signal?: AbortSignal, controllerFile?: string): Promise<VerticalSliceTraceResponse> {
    signal?.throwIfAborted();
    if (this.repo.getMeta("sync_state") === "error" || this.repo.getMeta("sync_state") === "running") {
      return { query: rawQuery, found: false, coverage: "partial", diagnostics: ["index_incomplete"], message: "Workspace synchronization is incomplete." };
    }
    const inventory = this.verifyMembership ? scanSourceFiles(this.projectRoot, { ignorePatterns: this.ignorePatterns, signal }) : undefined;
    const files = inventory?.files.map(file => relative(this.projectRoot, file).replace(/\\/g, "/"));
    const membershipChanged = files !== undefined && JSON.stringify(files) !== this.repo.getMeta("semantic_catalog_files");
    if (membershipChanged || !sliceInputsCurrent(this.repo, this.projectRoot, signal) || this.repo.getMeta("slices_dirty") === "1") {
      try {
        await rebuildSliceCatalog(this.repo, this.projectRoot, { ignorePatterns: this.ignorePatterns, signal });
      } catch (error) {
        signal?.throwIfAborted();
        return { query: rawQuery, found: false, coverage: "partial", diagnostics: [error instanceof Error ? error.message : String(error)], message: "Semantic extraction failed; no complete catalog was published." };
      }
    }
    return this.trace(rawQuery,maxDepth,controllerFile);
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
    const trimmed = rawQuery.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    const allSlices = this.repo.getAllVerticalSlices().filter(slice => !controllerFile || slice.controller_file === controllerFile);

    if (allSlices.length === 0) {
      return {
        query: trimmed,
        found: false,
        coverage: "partial",
        max_depth_applied: effectiveMaxDepth,
        message: controllerFile ? "No catalog target matches controller_file. Copy an exact file from the candidates or omit the filter." : "No vertical slices cataloged. Run 'septum sync' to extract framework routes and MVC slices.",
      };
    }

    // 1. Exact HTTP Method + URI match: "POST /orders/{id}/status" or "POST /api/orders"
    const methodUriMatch = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]+)$/i);
    if (methodUriMatch) {
      const httpMethod = methodUriMatch[1].toUpperCase();
      const uri = methodUriMatch[2];
      const candidates = allSlices.filter((s) => s.http_method.toUpperCase() === httpMethod && this.urisMatch(s.route_uri, uri));
      const literal = candidates.filter(s => s.route_uri === uri);
      if (literal.length === 1) {
        return this.formatSuccessResponse(trimmed, literal[0], "exact", undefined, effectiveMaxDepth);
      }
      if (literal.length > 1 || candidates.length > 1) {
        return this.ambiguousResponse(trimmed, literal.length ? literal : candidates, effectiveMaxDepth);
      }
      if (candidates.length === 1) {
        return this.formatSuccessResponse(trimmed, candidates[0], "inferred", undefined, effectiveMaxDepth);
      }
      return { query: trimmed, found: false, coverage: "partial", max_depth_applied: effectiveMaxDepth, message: `No vertical slice found matching query '${trimmed}'.` };
    }

    // 2. URI-only match: "/orders" or "orders/{id}"
    const literalUriMatches = allSlices.filter((s) => s.route_uri === trimmed);
    const uriMatches = literalUriMatches.length ? literalUriMatches : allSlices.filter((s) => this.urisMatch(s.route_uri, trimmed));
    if (uriMatches.length > 0) {
      const confidence = literalUriMatches.length ? "exact" : "inferred";
      if (uriMatches.length === 1) {
        return this.formatSuccessResponse(trimmed, uriMatches[0], confidence, undefined, effectiveMaxDepth);
      }
      return this.ambiguousResponse(trimmed, uriMatches, effectiveMaxDepth);
    }

    // 3. Named Route match: "orders.status.update" or "admin.users.index"
    const nameMatches = allSlices.filter(
      (s) => s.route_name && s.route_name.toLowerCase() === lowerTrimmed
    );
    if (nameMatches.length) {
      return nameMatches.length > 1 ? this.ambiguousResponse(trimmed, nameMatches, effectiveMaxDepth)
        : this.formatSuccessResponse(trimmed, nameMatches[0], "exact", undefined, effectiveMaxDepth);
    }

    // 3b. Omni-Trigger Match: "JOB ProcessOrderJob", "job:ProcessOrderJob", "CLI order:cleanup", "EVENT OrderPlacedListener"
    const omniTriggerMatch = trimmed.match(/^(JOB|CLI|EVENT)\s+([A-Za-z0-9_:\-]+)$/i);
    if (omniTriggerMatch) {
      const triggerKind = omniTriggerMatch[1].toUpperCase();
      const targetName = omniTriggerMatch[2].toLowerCase();
      const exact = allSlices.filter(
        (s) =>
          s.http_method.toUpperCase() === triggerKind &&
          (s.controller_class.toLowerCase() === targetName ||
            s.route_uri.toLowerCase() === targetName ||
            s.route_uri.toLowerCase() === `${triggerKind.toLowerCase()}:${targetName}`)
      );
      if (exact.length) {
        return exact.length > 1 ? this.ambiguousResponse(trimmed, exact, effectiveMaxDepth)
          : this.formatSuccessResponse(trimmed, exact[0], "exact", undefined, effectiveMaxDepth);
      }
    }

    // 4. Controller@Action match: "OrderController@updateStatus" or "OrderController"
    const controllerActionMatch = trimmed.match(/^([A-Za-z0-9_\\/.]+?)(?:(?:@|::)([A-Za-z0-9_]+))?$/);
    if (controllerActionMatch) {
      const [, rawCtrl, act] = controllerActionMatch;
      const ctrl = rawCtrl.split(/[\\/]/).pop()?.replace(/\.(php|ts|js)$/i, "") || rawCtrl;
      const lowerCtrl = ctrl.toLowerCase();
      const lowerAct = act ? act.toLowerCase() : undefined;

      const exact = allSlices.filter((s) => {
        const sCtrlLower = s.controller_class.toLowerCase();
        const ctrlMatch =
          sCtrlLower === lowerCtrl ||
          sCtrlLower.endsWith(`\\${lowerCtrl}`) ||
          sCtrlLower.endsWith(`/${lowerCtrl}`);
        if (!ctrlMatch) return false;
        if (lowerAct) return s.action_name.toLowerCase() === lowerAct;
        if (!act && !lowerCtrl.endsWith("controller") && sCtrlLower !== lowerCtrl) {
          return false;
        }
        return true;
      });
      if (exact.length) {
        return exact.length > 1 ? this.ambiguousResponse(trimmed, exact, effectiveMaxDepth)
          : this.formatSuccessResponse(trimmed, exact[0], "exact", undefined, effectiveMaxDepth);
      }
    }

    // 5. Symbol Match in Execution Chain or Action Name (e.g. "createOrder", "CreateOrderUseCase", "OrderController")
    let invalidChains = false;
    const symbolMatches = allSlices.filter((s) => {
      if (s.action_name.toLowerCase() === lowerTrimmed) return true;
      if (s.controller_class.toLowerCase() === lowerTrimmed) return true;
      if (s.execution_chain_json) {
        try {
          const chain = this.parseChain(s.execution_chain_json);
          return chain.some(
            (node) =>
              node.symbol.toLowerCase() === lowerTrimmed ||
              node.symbol.toLowerCase().includes(lowerTrimmed) ||
              (node.file && node.file.toLowerCase().includes(lowerTrimmed))
          );
        } catch {
          invalidChains = true;
          return false;
        }
      }
      return false;
    });
    if (symbolMatches.length) {
      return symbolMatches.length > 1 ? this.ambiguousResponse(trimmed, symbolMatches, effectiveMaxDepth)
        : this.formatSuccessResponse(trimmed, symbolMatches[0], "inferred", undefined, effectiveMaxDepth);
    }

    // 6. Semantic / Token Scoring for Natural Language (e.g. "Ubah status order di dashboard")
    const tokens = this.tokenize(trimmed);
    const scoredSlices = allSlices
      .map((slice) => {
        let score = 0;
        const textCorpus = [
          slice.route_uri,
          slice.route_name || "",
          slice.controller_class,
          slice.action_name,
          slice.execution_chain_json || "",
        ].join(" ").toLowerCase();

        for (const token of tokens) {
          if (textCorpus.includes(token)) {
            score += 1;
            if (slice.route_uri.toLowerCase().includes(token)) score += 2;
            if (slice.action_name.toLowerCase().includes(token)) score += 2;
          }
        }
        return { slice, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scoredSlices.length > 0) {
      const tied = scoredSlices.filter(item => item.score === scoredSlices[0].score);
      if (tied.length > 1) return this.ambiguousResponse(trimmed, tied.map(item => item.slice), effectiveMaxDepth);
      const primary = scoredSlices[0].slice;
      const alternatives = scoredSlices.slice(1, 4).map((item) => item.slice);
      return this.formatSuccessResponse(trimmed, primary, "inferred", alternatives, effectiveMaxDepth);
    }

    return {
      query: trimmed,
      found: false,
      coverage: "partial",
      diagnostics: invalidChains ? ["invalid_execution_chain"] : undefined,
      next: invalidChains ? ["Run septum sync to rebuild the catalog before relying on a negative symbol search."] : undefined,
      max_depth_applied: effectiveMaxDepth,
      alternatives: allSlices.slice(0, 5).map((s) => ({
        method: s.http_method,
        uri: s.route_uri,
        controller: s.controller_class,
        action: s.action_name,
      })),
      message: `No vertical slice found matching query '${trimmed}'.`,
    };
  }

  private ambiguousResponse(query: string, candidates: VerticalSliceRecord[], maxDepth: number): VerticalSliceTraceResponse {
    const alternatives = candidates.map(candidate => ({ method: candidate.http_method, uri: candidate.route_uri,
      controller: candidate.controller_class, action: candidate.action_name, file: candidate.controller_file,
      line: candidate.controller_line })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { query, found: false, coverage: "partial", diagnostics: ["ambiguous_target"],
      max_depth_applied: maxDepth, alternatives: alternatives.slice(0, 20),
      candidate_count: alternatives.length, alternatives_omitted: Math.max(0, alternatives.length - 20),
      next: ["Narrow the query to METHOD /route or Controller@action and controller_file copied from a candidate. If candidates remain identical, inspect their source declarations."],
      message: "Multiple catalog targets match; no entrypoint or chain was selected." };
  }

  private parseChain(serialized: string): ExecutionChainNode[] {
    const chain: unknown = JSON.parse(serialized);
    if (!Array.isArray(chain) || chain.some(node => !node || typeof node !== "object" ||
      typeof node.stage !== "string" || typeof node.symbol !== "string" ||
      (node.file !== undefined && typeof node.file !== "string") ||
      (node.description !== undefined && typeof node.description !== "string") ||
      ["guards", "mutations", "emits", "dispatches"].some(key => node[key] !== undefined &&
        (!Array.isArray(node[key]) || node[key].some((value: unknown) => typeof value !== "string"))))) {
      throw new Error("Invalid execution chain shape");
    }
    return chain;
  }

  private urisMatch(uriA: string, uriB: string): boolean {
    const normA = uriA
      .replace(/\{[^}]+\}/g, ":param")
      .replace(/:[a-zA-Z0-9_]+/g, ":param");
    const normB = uriB
      .replace(/\{[^}]+\}/g, ":param")
      .replace(/:[a-zA-Z0-9_]+/g, ":param");
    return normA === normB;
  }

  private tokenize(str: string): string[] {
    return str
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !["ubah", "di", "dan", "yang", "the", "for", "and"].includes(t));
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
      chain = this.parseChain(record.execution_chain_json);
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
