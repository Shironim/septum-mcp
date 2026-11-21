import type { VerticalSliceRecord, VerticalSliceTraceResponse } from "../../types/index.ts";
import { parseSliceChain } from "./slice-format.ts";

interface SliceMatch {
  query: string;
  record: VerticalSliceRecord;
  confidence: "exact" | "inferred";
  alternatives?: VerticalSliceRecord[];
}

function match(query: string, record: VerticalSliceRecord, confidence: SliceMatch["confidence"], alternatives?: VerticalSliceRecord[]): SliceMatch {
  return { query, record, confidence, alternatives };
}

export function selectSliceTarget(
  records: VerticalSliceRecord[],
  rawQuery: string,
  effectiveMaxDepth: number,
  controllerFile?: string,
): SliceMatch | VerticalSliceTraceResponse {
  const trimmed = rawQuery.trim();
  const lowerTrimmed = trimmed.toLowerCase();
  const allSlices = records.filter(slice => !controllerFile || slice.controller_file === controllerFile);

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
  const methodUriMatch = trimmed.match(/^([A-Z][A-Z0-9-]*)\s+(\/[^\s]*)$/i);
  if (methodUriMatch) {
    const httpMethod = methodUriMatch[1].toUpperCase();
    const uri = methodUriMatch[2];
    const candidates = allSlices.filter((s) => {
      const method = s.http_method.toUpperCase();
      return (method === httpMethod || method === "ANY") && urisMatch(s.route_uri, uri);
    });
    const literal = candidates.filter(s => s.route_uri === uri);
    if (literal.length === 1) {
      const confidence = literal[0].http_method.toUpperCase() === httpMethod ? "exact" : "inferred";
      return match(trimmed, literal[0], confidence, undefined);
    }
    if (literal.length > 1 || candidates.length > 1) {
      return ambiguousResponse(trimmed, literal.length ? literal : candidates, effectiveMaxDepth);
    }
    if (candidates.length === 1) {
      return match(trimmed, candidates[0], "inferred", undefined);
    }
    return { query: trimmed, found: false, coverage: "partial", max_depth_applied: effectiveMaxDepth, message: `No vertical slice found matching query '${trimmed}'.` };
  }

  // 2. URI-only match: "/orders" or "orders/{id}"
  const literalUriMatches = allSlices.filter((s) => s.route_uri === trimmed);
  const uriMatches = literalUriMatches.length ? literalUriMatches : allSlices.filter((s) => urisMatch(s.route_uri, trimmed));
  if (uriMatches.length > 0) {
    const confidence = literalUriMatches.length ? "exact" : "inferred";
    if (uriMatches.length === 1) {
      return match(trimmed, uriMatches[0], confidence, undefined);
    }
    return ambiguousResponse(trimmed, uriMatches, effectiveMaxDepth);
  }

  // 3. Named Route match: "orders.status.update" or "admin.users.index"
  const nameMatches = allSlices.filter(
    (s) => s.route_name && s.route_name.toLowerCase() === lowerTrimmed
  );
  if (nameMatches.length) {
    return nameMatches.length > 1 ? ambiguousResponse(trimmed, nameMatches, effectiveMaxDepth)
      : match(trimmed, nameMatches[0], "exact", undefined);
  }

  // 3b. Omni-Trigger Match: "JOB ProcessOrderJob", "CLI command:check", "MCP tool:septum_symbol", "EVENT OrderPlacedListener"
  const omniTriggerMatch = trimmed.match(/^(JOB|CLI|EVENT|MCP|RPC|QUEUE|CRON|WS)\s+([A-Za-z0-9_:\-\./]+)$/i);
  if (omniTriggerMatch) {
    const triggerKind = omniTriggerMatch[1].toUpperCase();
    const targetName = omniTriggerMatch[2].toLowerCase();
    const exact = allSlices.filter(
      (s) =>
        s.http_method.toUpperCase() === triggerKind &&
        (s.controller_class.toLowerCase() === targetName ||
          s.route_uri.toLowerCase() === targetName ||
          s.route_uri.toLowerCase() === `${triggerKind.toLowerCase()}:${targetName}` ||
          (s.route_name && s.route_name.toLowerCase() === targetName))
    );
    if (exact.length) {
      return exact.length > 1 ? ambiguousResponse(trimmed, exact, effectiveMaxDepth)
        : match(trimmed, exact[0], "exact", undefined);
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
      return exact.length > 1 ? ambiguousResponse(trimmed, exact, effectiveMaxDepth)
        : match(trimmed, exact[0], "exact", undefined);
    }
  }

  // 5. Symbol Match in Execution Chain or Action Name (e.g. "createOrder", "CreateOrderUseCase", "OrderController")
  let invalidChains = false;
  const symbolMatches = allSlices.filter((s) => {
    if (s.action_name.toLowerCase() === lowerTrimmed) return true;
    if (s.controller_class.toLowerCase() === lowerTrimmed) return true;
    if (s.execution_chain_json) {
      try {
        const chain = parseSliceChain(s.execution_chain_json);
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
    return symbolMatches.length > 1 ? ambiguousResponse(trimmed, symbolMatches, effectiveMaxDepth)
      : match(trimmed, symbolMatches[0], "inferred", undefined);
  }

  // 6. Semantic / Token Scoring for Natural Language (e.g. "Ubah status order di dashboard")
  const tokens = tokenize(trimmed);
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
    if (tied.length > 1) return ambiguousResponse(trimmed, tied.map(item => item.slice), effectiveMaxDepth);
    const primary = scoredSlices[0].slice;
    const alternatives = scoredSlices.slice(1, 4).map((item) => item.slice);
    return match(trimmed, primary, "inferred", alternatives);
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

function ambiguousResponse(query: string, candidates: VerticalSliceRecord[], maxDepth: number): VerticalSliceTraceResponse {
  const alternatives = candidates.map(candidate => ({ method: candidate.http_method, uri: candidate.route_uri,
    controller: candidate.controller_class, action: candidate.action_name, file: candidate.controller_file,
    line: candidate.controller_line })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { query, found: false, coverage: "partial", diagnostics: ["ambiguous_target"],
    max_depth_applied: maxDepth, alternatives: alternatives.slice(0, 20),
    candidate_count: alternatives.length, alternatives_omitted: Math.max(0, alternatives.length - 20),
    next: ["Narrow the query to METHOD /route or Controller@action and controller_file copied from a candidate. If candidates remain identical, inspect their source declarations."],
    message: "Multiple catalog targets match; no entrypoint or chain was selected." };
}

function urisMatch(uriA: string, uriB: string): boolean {
  const normA = uriA
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/:[a-zA-Z0-9_]+/g, ":param");
  const normB = uriB
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/:[a-zA-Z0-9_]+/g, ":param");
  return normA === normB;
}

function tokenize(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !["ubah", "di", "dan", "yang", "the", "for", "and"].includes(t));
}
