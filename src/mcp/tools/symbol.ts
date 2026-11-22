import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { IngestionPipeline } from "../../core/ingestion/pipeline.ts";
import { SymbolLocator, type SymbolLocationResult } from "../../core/resolver/symbol-locator.ts";
import { isIgnoredDirectory } from "../../core/resources/ignore.ts";
import { retrieveContext } from "../../core/retrieval/context.ts";
import { partitionResolutionWarnings } from "../../core/retrieval/resolution-warnings.ts";
import { inspectSourceContext, selectSymbolContextMode } from "../../core/retrieval/source-context.ts";
import { symbolWorkspace, withSymbolEvidence } from "../../core/retrieval/symbol-evidence.ts";
import type { GetSymbolArgs, GetSymbolImpactArgs } from "../../types/index.ts";
import {
  formatDeepContextAsText,
  formatImpactAsText,
  formatLocateAsText,
  formatSourceContextAsText,
} from "../formatters/compact-text.ts";
import type { LocateSymbolArgs, SymbolToolArgs } from "../schemas.ts";

export type { LocateSymbolArgs, SymbolToolArgs };

function applySymbolFormat<T extends { content: Array<{ type: "text"; text: string }>; metadata?: unknown; structuredContent?: unknown }>(
  result: T,
  format: "json" | "text" | undefined,
  formatter: (payload: Record<string, any>) => string
): T {
  const effective = format ?? "text";
  if (effective === "json") return result;
  try {
    const payload = JSON.parse(result.content[0]!.text) as Record<string, any>;
    return {
      ...result,
      content: [{ type: "text" as const, text: formatter(payload) }, ...result.content.slice(1)],
      structuredContent: result.structuredContent ?? payload,
      metadata: result.metadata ?? payload,
    };
  } catch {
    return result;
  }
}

export async function handleSymbolTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: SymbolToolArgs,
  pipeline?: IngestionPipeline,
  workspaceRoot?: string,
  signal?: AbortSignal
) {
  const action = args.action || "locate";
  const format = args.format ?? "text";

  switch (action) {
    case "context":
    case "inspect": {
      const { mode, symbol } = selectSymbolContextMode(repo, args);
      if (mode === "invalid_query") {
        const err = {
          status: "invalid_query",
          message: "Choose a target with query, symbol or symbol_ref.",
        };
        return {
          content: [{
            type: "text" as const,
            text: format === "json" ? JSON.stringify(err) : formatSourceContextAsText(err),
          }],
          structuredContent: err,
          metadata: err,
        };
      }
      if (mode === "deep") {
        const res = await retrieveContext(repo, config, args, symbolWorkspace(repo, workspaceRoot || args.workspace_path), signal);
        return applySymbolFormat(res, format, formatDeepContextAsText);
      }
      if (mode === "invalid_options") {
        const err = {
          status: "invalid_context_options",
          message: "budget_bytes and continuation apply to deep TypeScript context. For bounded source use source_start_line and source_line_limit.",
        };
        return {
          content: [{
            type: "text" as const,
            text: format === "json" ? JSON.stringify(err) : formatSourceContextAsText(err),
          }],
          structuredContent: err,
          metadata: err,
        };
      }
      return handleGetSymbol(
        repo,
        config,
        {
          symbol,
          query: symbol,
          domain: args.domain,
          file_path: args.file_path,
          symbol_ref: args.symbol_ref,
          include_dependencies: args.include_dependencies,
          include_source: args.include_source ?? true,
          source_start_line: args.source_start_line,
          source_line_limit: args.source_line_limit,
          budget_bytes: args.budget_bytes,
          semantic_depth: args.semantic_depth,
          format,
          workspace_path: args.workspace_path,
        },
        workspaceRoot
      );
    }

    case "impact": {
      const symbol = args.symbol || args.query || args.symbol_ref?.name || "";
      return handleGetSymbolImpact(
        repo,
        config,
        {
          symbol,
          query: symbol,
          domain: args.domain,
          file_path: args.file_path,
          symbol_ref: args.symbol_ref,
          format,
          workspace_path: args.workspace_path,
        },
        workspaceRoot
      );
    }

    case "locate":
    default:
      return await handleLocateSymbol(
        repo,
        config,
        {
          query: args.query || args.symbol || "",
          domain: args.domain,
          file_path: args.file_path,
          symbol_ref: args.symbol_ref,
          limit: args.limit ?? 10,
          format,
          workspace_path: args.workspace_path,
        },
        pipeline,
        workspaceRoot
      );
  }
}

export function handleGetSymbol(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetSymbolArgs,
  workspaceRoot?: string
) {
  const root = symbolWorkspace(repo, workspaceRoot || args.workspace_path);
  const res = withSymbolEvidence(repo, root, { operation: "inspect", requested: args.symbol_ref }, () => {
    const payload = inspectSourceContext(repo, config, args, root);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    };
  });
  return applySymbolFormat(res, args.format, formatSourceContextAsText);
}

export function handleGetSymbolImpact(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetSymbolImpactArgs,
  workspaceRoot?: string
) {
  const root = symbolWorkspace(repo, workspaceRoot || args.workspace_path);
  const res = withSymbolEvidence(repo, root, { operation: "impact", requested: args.symbol_ref },
    () => inspectImpact(repo, config, args, root));
  return applySymbolFormat(res, args.format, formatImpactAsText);
}

function inspectImpact(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolImpactArgs,
  workspaceRoot?: string
) {
  const symbol = (args.symbol_ref?.name || args.symbol || (args as unknown as Record<string, unknown>).query || "").toString().trim();
  if (!symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderService::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  if (args.symbol_ref) {
    const file = repo.getFileByPath(args.symbol_ref.file_path);
    if (!file || file.content_hash !== args.symbol_ref.indexed_content_hash) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            target_symbol: symbol,
            status: "stale_reference",
            found_in_index: false,
            message: "Declaration reference is stale; locate the symbol again.",
          }),
        }],
      };
    }
  }

  const candidates = repo.findSymbolsByName(symbol, {
    domain: args.domain,
    filePath: args.file_path,
    reference: args.symbol_ref,
  });
  if (candidates.length > 1) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "ambiguous",
          target_symbol: symbol,
          found_in_index: false,
          candidates: candidates.map(c => ({ name: c.name, file_path: c.file_path, symbol_ref: c.symbol_ref })),
          message: "Multiple declarations match; select a candidate with symbol_ref or narrow with file_path.",
        }, null, 2),
      }],
    };
  }

  const selectedCandidate = candidates[0];
  let suggestions: string[] | undefined;
  if (!selectedCandidate && args.file_path) {
    const normalizedPath = args.file_path.replace(/\\/g, "/").replace(/^\.\//, "");
    const file = repo.getFileByPath(normalizedPath);
    if (file) {
      const fileSymbols = repo.getSymbolsByFileId(file.id);
      if (fileSymbols.length > 0) {
        const lower = symbol.toLowerCase();
        const ranked = [...fileSymbols].sort((a, b) => {
          const aMatch = a.name.toLowerCase().includes(lower) ? 0 : 1;
          const bMatch = b.name.toLowerCase().includes(lower) ? 0 : 1;
          return aMatch - bMatch || a.line_start - b.line_start;
        });
        suggestions = ranked.slice(0, 10).map((s) => s.name);
      }
    }
  }

  const impact = repo.getSymbolImpact(symbol, {
    domain: args.domain,
    filePath: args.file_path || selectedCandidate?.file_path,
    reference: args.symbol_ref || selectedCandidate?.symbol_ref,
    workspaceRoot: workspaceRoot || args.workspace_path,
  });

  const relationships = repo.getImportRelationships(workspaceRoot || args.workspace_path);
  const targetFiles = candidates.map(c => c.file_path);
  const targetFileSet = new Set(targetFiles);
  const importDependents = relationships.filter(edge =>
    edge.resolution.status === "resolved" &&
    edge.resolution.targets.some(t => t.files.some(f => targetFileSet.has(f)))
  );
  const warnings = partitionResolutionWarnings(relationships, targetFiles);
  const callSites = impact.inbound_callers.filter(
    caller => caller.kind === "call" || caller.kind === "instantiation" || caller.kind === "heritage"
  );
  const firstResolution = importDependents[0]?.resolution;
  const isTypeOnlyStmt = (stmt: string) => /^\s*(?:import|export)\s+type\b/.test(stmt);
  const fileDomainMap = new Map<string, string>();
  for (const c of impact.inbound_callers) {
    if (c.domain) fileDomainMap.set(c.file, c.domain);
  }
  const runtimeImports: Array<{ file: string; line: number; domain?: string; statement: string }> = [];
  const typeOnlyImports: Array<{ file: string; line: number; domain?: string; statement: string }> = [];
  for (const edge of importDependents) {
    const entry = {
      file: edge.source.file,
      line: edge.source.line,
      ...(fileDomainMap.get(edge.source.file) ? { domain: fileDomainMap.get(edge.source.file) } : {}),
      statement: edge.source.statement,
    };
    if (isTypeOnlyStmt(edge.source.statement)) typeOnlyImports.push(entry);
    else runtimeImports.push(entry);
  }
  const compactImportDependents = importDependents.map(edge => ({
    source: { file: edge.source.file, line: edge.source.line, statement: edge.source.statement },
    target_domains: edge.target_domains,
    is_type_only: isTypeOnlyStmt(edge.source.statement),
    resolution: { status: edge.resolution.status, reason: edge.resolution.reason, targets: edge.resolution.targets },
  }));

  const payload = {
    ...impact,
    impact_summary: {
      ...impact.impact_summary,
      call_sites_count: callSites.length,
      runtime_imports_count: runtimeImports.length,
      type_only_imports_count: typeOnlyImports.length,
    },
    symbol_ref: selectedCandidate?.symbol_ref,
    ...(suggestions ? { suggestions } : {}),
    coverage: "partial",
    inbound_callers_complete: false,
    call_sites: callSites,
    runtime_imports: runtimeImports,
    type_only_imports: typeOnlyImports,
    risk_scope: "advisory; incomplete static consumer evidence",
    relationship_limits: "Imports do not prove executed calls; runtime dispatch and unindexed callers are omitted.",
    ...(firstResolution ? { resolution_metadata: { resolver_revision: firstResolution.resolver_revision, config_revision: firstResolution.config_revision } } : {}),
    import_dependents: compactImportDependents,
    resolution_warnings: warnings.relevant,
    workspace_resolution_diagnostics: {
      count: warnings.workspace.length,
      returned_details: 0,
      omitted_details: warnings.workspace.length,
      reason: "Resolved unrelated workspace imports omitted; unresolved/stale items stay in resolution_warnings.",
    },
    diagnostic_accounting: {
      total: warnings.relevant.length + warnings.workspace.length,
      target_or_possible_target: warnings.relevant.length,
      unrelated_workspace: warnings.workspace.length,
    },
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export async function handleLocateSymbol(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: Partial<LocateSymbolArgs>,
  pipeline?: IngestionPipeline,
  workspaceRoot?: string
) {
  const query = (args.query || args.symbol || args.symbol_ref?.name || "").toString().trim();
  const root = symbolWorkspace(repo, workspaceRoot || args.workspace_path);
  const diagnostics: string[] = [];
  const limit = args.limit ?? 10;

  if (!query || query === "*") {
    if (args.file_path) {
      const normalizedPath = args.file_path.replace(/\\/g, "/").replace(/^\.\//, "");
      const file = repo.getFileByPath(normalizedPath);
      const allSymbols = file ? repo.getSymbolsByFileId(file.id) : [];
      const sliced = allSymbols.slice(0, limit).map((s) => ({
        name: s.name,
        file_path: normalizedPath,
        kind: s.kind,
        signature: s.signature,
        start_line: s.line_start,
        end_line: s.line_end,
      }));
      const filePayload = {
        status: sliced.length > 0 ? "success" : "not_found",
        found: sliced.length > 0,
        query: query || null,
        file_path: normalizedPath,
        candidates: sliced,
        total_candidates: allSymbols.length,
        omitted_candidates: Math.max(0, allSymbols.length - sliced.length),
        summary: sliced.length > 0
          ? `[FOUND] Listed ${sliced.length} of ${allSymbols.length} declarations in ${normalizedPath}.`
          : `[NOT FOUND] No indexed declarations found in '${normalizedPath}'.`,
      };
      const res = withSymbolEvidence(repo, root, { operation: "locate", requested: args.symbol_ref, diagnostics }, () => ({
        content: [{ type: "text" as const, text: JSON.stringify(filePayload, null, 2) }],
        metadata: filePayload,
      }));
      return applySymbolFormat(res, args.format, formatLocateAsText);
    }
    throw new Error(
      "Missing required argument: 'query' (e.g. 'OrderController::calculateTotal' or error log snippet)"
    );
  }

  if (repo.countFiles() === 0 && pipeline) {
    try {
      await pipeline.run(config);
    } catch {
      diagnostics.push("initial_index_refresh_failed");
    }

    if (repo.countFiles() === 0) {
      const diagnostic = {
        status: "NOT_INDEXED",
        found: false,
        query,
        message: `Workspace '${root}' belum terindeks dalam Septum catalog.`,
        suggested_action: {
          tool: "septum_map",
          params: { action: "register", name: "core", root: "src", ingest_now: true },
        },
        agent_guidance:
          "Panggil tool 'septum_map(action: \"register\", name: \"core\", root: \"src\", ingest_now: true)' untuk mendaftarkan dan mengindeks codebase ini, atau jalankan 'septum init' di terminal workspace.",
      };

      const res = withSymbolEvidence(repo, root, { operation: "locate", requested: args.symbol_ref, diagnostics }, () => ({
        content: [{ type: "text" as const, text: JSON.stringify(diagnostic, null, 2) }],
        metadata: diagnostic,
      }));
      return applySymbolFormat(res, args.format, formatLocateAsText);
    }
  }

  const locator = new SymbolLocator(repo);
  let result: SymbolLocationResult = locator.locate(query, args.domain, { filePath: args.file_path, reference: args.symbol_ref });

  if (result.found && result.file_path && pipeline) {
    const fullPath = isAbsolute(result.file_path) ? result.file_path : join(root, result.file_path);
    try {
      const reindexed = await pipeline.ingestFile(fullPath, config);
      if (reindexed) {
        result = locator.locate(query, args.domain, { filePath: args.file_path, reference: args.symbol_ref });
      }
    } catch {
      diagnostics.push("target_index_refresh_failed");
    }
  }

  if (!result.found && pipeline) {
    try {
      const cleanTerm = query.replace(/[^a-zA-Z0-9_]/g, " ").trim().split(/\s+/)[0] || "";
      if (cleanTerm.length >= 3) {
        const candidateFiles = findCandidateFiles(root, cleanTerm);
        let anyReindexed = false;
        for (const candidate of candidateFiles) {
          const reindexed = await pipeline.ingestFile(candidate, config);
          if (reindexed) anyReindexed = true;
        }
        if (anyReindexed) {
          result = locator.locate(query, args.domain, { filePath: args.file_path, reference: args.symbol_ref });
        }
      }
    } catch {
      diagnostics.push("candidate_refresh_failed");
    }
  }

  const exactLineCount = result.exact_symbol
    ? result.exact_symbol.line_end - result.exact_symbol.line_start + 1
    : 0;
  const complexitySmell = exactLineCount > 300
    ? {
        is_high_complexity: true,
        threshold: 300,
        total_lines: exactLineCount,
        warning: `Symbol '${result.exact_symbol?.name}' spans ${exactLineCount} lines (exceeds 300-line threshold). Candidate for decomposition/refactoring.`,
      }
    : undefined;

  const suggestions = (result.suggestions || []).slice(0, limit);
  let summary = result.status === "ambiguous"
    ? `[AMBIGUOUS] Multiple declarations match '${query}'; select a candidate with symbol_ref or file_path.`
    : result.status === "stale_reference"
    ? `[STALE REFERENCE] Locate '${query}' again before using its indexed coordinates.`
    : result.found
    ? `[FOUND] ${result.exact_symbol?.name || query} in ${result.file_path} (lines ${result.exact_symbol?.line_start}-${result.exact_symbol?.line_end})`
    : `[NOT FOUND] Symbol '${query}' not found. ${suggestions.length > 0 ? `Top suggestions: ${suggestions.map((s) => s.name).slice(0, 3).join(", ")}` : "No close suggestions."}`;

  if (complexitySmell) {
    summary += ` | ⚠️ High-Complexity Smell: spans ${exactLineCount} lines (> 300L)`;
  }

  const allCandidates = result.candidates || [];
  const boundedCandidates = allCandidates.slice(0, limit);
  const payload = {
    status: result.status ?? (result.found ? "success" : "not_found"),
    candidates: result.candidates ? boundedCandidates : undefined,
    ...(allCandidates.length > boundedCandidates.length
      ? { total_candidates: allCandidates.length, omitted_candidates: allCandidates.length - boundedCandidates.length }
      : {}),
    symbol_ref: result.symbol_ref,
    visibility_semantics: "legacy_normalized",
    found: result.found,
    query,
    file_path: result.file_path || null,
    container_name: result.container_name || null,
    exact_symbol: result.exact_symbol
      ? {
          name: result.exact_symbol.name,
          kind: result.exact_symbol.kind,
          ...(result.symbol_ref ? {} : { signature: result.exact_symbol.signature }),
          visibility: result.exact_symbol.visibility,
          line_start: result.exact_symbol.line_start,
          line_end: result.exact_symbol.line_end,
          start_line: result.exact_symbol.start_line,
          end_line: result.exact_symbol.end_line,
          total_lines: exactLineCount,
        }
      : null,
    complexity_smell: complexitySmell,
    sibling_methods: result.sibling_methods || [],
    suggestions,
    summary,
    message: result.message || summary,
  };

  const res = withSymbolEvidence(repo, root, { operation: "locate", requested: args.symbol_ref, diagnostics }, () => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    metadata: payload,
  }));
  return applySymbolFormat(res, args.format, formatLocateAsText);
}

function findCandidateFiles(root: string, term: string): string[] {
  const matched: string[] = [];
  const lowerTerm = term.toLowerCase().replace(/_/g, "");
  const searchDirs = ["src", "app", "lib"].map((d) => join(root, d)).filter((d) => existsSync(d));

  function scan(dir: string, depth: number = 0) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (isIgnoredDirectory(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          scan(full, depth + 1);
        } else if (e.isFile() && /\.(ts|tsx|js|jsx|php|py|go)$/i.test(e.name)) {
          const lowerName = e.name.toLowerCase().replace(/[-_.]/g, "");
          if (lowerName.includes(lowerTerm) || lowerTerm.includes(lowerName.replace(/\.[^.]+$/, ""))) {
            matched.push(full);
            if (matched.length >= 5) return;
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  for (const sDir of searchDirs) {
    scan(sDir);
    if (matched.length >= 5) break;
  }

  return matched;
}
