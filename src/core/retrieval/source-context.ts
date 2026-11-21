import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { isPathContained } from "../resolver/path-resolver.ts";
import { SymbolLocator } from "../resolver/symbol-locator.ts";
import { readSourceFile } from "../resources/source-files.ts";
import type { GetSymbolArgs, SymbolReference } from "../../types/index.ts";

export interface SymbolContextModeSelection {
  mode: "deep" | "invalid_options" | "source";
  symbol: string;
}

export function selectSymbolContextMode(
  repo: SeptumRepository,
  args: {
    symbol?: string;
    query?: string;
    domain?: string;
    file_path?: string;
    symbol_ref?: SymbolReference;
    context_mode?: string;
    include_source?: boolean;
    source_start_line?: number;
    source_line_limit?: number;
    continuation?: string;
    budget_bytes?: number;
    max_depth?: number;
  }
): SymbolContextModeSelection {
  const symbol = args.symbol_ref?.name || args.symbol || args.query || "";
  const candidates = repo.findSymbolsByName(symbol, {
    domain: args.domain,
    filePath: args.file_path,
    reference: args.symbol_ref,
  });
  const targetPath = candidates.length === 1
    ? candidates[0]!.file_path
    : args.symbol_ref?.file_path || args.file_path;
  const bounded =
    args.context_mode === "source" ||
    args.include_source !== undefined ||
    args.source_start_line !== undefined ||
    args.source_line_limit !== undefined;

  if (args.context_mode === "deep" || (!bounded && (!targetPath || /\.(?:ts|mts|cts|tsx)$/.test(targetPath)))) {
    return { mode: "deep", symbol };
  }
  if (args.continuation !== undefined || ((args.budget_bytes !== undefined || args.max_depth !== undefined) && bounded)) {
    return { mode: "invalid_options", symbol };
  }
  return { mode: "source", symbol };
}

function indexLineOffsets(source: string): { lineStarts: number[]; lineEnds: number[] } {
  const lineStarts = [0];
  const lineEnds: number[] = [];
  for (const match of source.matchAll(/\r\n|\n|\r/g)) {
    const offset = match.index!;
    lineEnds.push(offset);
    lineStarts.push(offset + match[0].length);
  }
  lineEnds.push(source.length);
  return { lineStarts, lineEnds };
}

export function inspectSourceContext(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolArgs,
  workspaceRoot?: string
): Record<string, unknown> {
  const symbol = (args.symbol_ref?.name || args.symbol || (args as unknown as Record<string, unknown>).query || "").toString().trim();
  if (!symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderController::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  if (args.symbol_ref) {
    const file = repo.getFileByPath(args.symbol_ref.file_path);
    if (!file || file.content_hash !== args.symbol_ref.indexed_content_hash) {
      return {
        symbol,
        status: "stale_reference",
        found: false,
        message: "Declaration reference is stale; locate the symbol again.",
        ...(args.include_source ? { source_slice: { status: "stale", reason: "stale_reference" } } : {}),
      };
    }
  }

  const selectedCandidates = repo.findSymbolsByName(symbol, {
    domain: args.domain,
    filePath: args.file_path,
    reference: args.symbol_ref,
  });
  if (selectedCandidates.length > 1) {
    const candidates = selectedCandidates.map(candidate => ({
      name: candidate.name,
      file_path: candidate.file_path,
      kind: candidate.kind,
      signature: candidate.signature,
      start_line: candidate.line_start,
      end_line: candidate.line_end,
      symbol_ref: candidate.symbol_ref,
    }));
    return {
      symbol,
      status: "ambiguous",
      found: false,
      candidates,
      ...(args.include_source ? { source_slice: { status: "ambiguous", candidates } } : {}),
      message: "Multiple matching declarations; select a candidate with symbol_ref or narrow with file_path.",
    };
  }

  const details = repo.getSymbolDetails(symbol, {
    domain: args.domain,
    filePath: args.file_path,
    reference: args.symbol_ref,
    // This inspection path reads the complete file for outbound-call inference; keep source requests bounded.
    includeDependencies: args.include_source ? false : args.include_dependencies,
    workspaceRoot: workspaceRoot || args.workspace_path,
  });

  if (details) {
    const payload: Record<string, unknown> = { ...details, context_mode: "source" };
    if (args.include_source === false) {
      if (Array.isArray(payload.relationships)) {
        const allRels = payload.relationships as Array<any>;
        const maxRels = 20;
        payload.relationships = allRels.slice(0, maxRels).map((edge) => ({
          target: edge?.resolution?.source?.target ?? edge?.target,
          line: edge?.source?.line ?? edge?.line,
          status: edge?.resolution?.status,
          reason: edge?.resolution?.reason,
          resolved_files: Array.isArray(edge?.resolution?.targets)
            ? edge.resolution.targets.flatMap((t: any) => t.files ?? [])
            : [],
        }));
        if (allRels.length > maxRels) {
          payload.relationships_omitted = allRels.length - maxRels;
        }
      }
      if (Array.isArray(payload.connected_files) && payload.connected_files.length > 20) {
        payload.connected_files_omitted = payload.connected_files.length - 20;
        payload.connected_files = payload.connected_files.slice(0, 20);
      }
    }
    if (args.include_source) {
      delete payload.dependencies_injected;
      delete payload.outbound_calls;
      delete payload.resolved_outbound_calls;
      delete payload.connected_files;
      const root = resolve(workspaceRoot || args.workspace_path || process.cwd());
      const file = repo.getFileByPath(details.file_path);
      const fullPath = resolve(root, details.file_path);
      if (!file) {
        payload.source_slice = { status: "unavailable", file_path: details.file_path, reason: "file_not_indexed" };
      } else if (!isPathContained(fullPath, root)) {
        payload.source_slice = { status: "out_of_scope", file_path: details.file_path };
      } else {
        try {
          const source = readSourceFile(fullPath);
          const currentHash = computeContentHash(source);
          if (currentHash !== file.content_hash) {
            payload.source_slice = {
              status: "stale",
              file_path: details.file_path,
              indexed_content_hash: file.content_hash,
              current_content_hash: currentHash,
              message: "File has been modified on disk since last indexed. Run 'septum sync' to synchronize AST coordinates.",
              action_required: "septum sync",
            };
          } else {
            const { lineStarts, lineEnds } = indexLineOffsets(source);
            const startLine = args.source_start_line ?? details.exact_range.start_line;
            const limit = Math.min(args.source_line_limit ?? 120, 200);
            if (
              startLine < details.exact_range.start_line ||
              startLine > details.exact_range.end_line ||
              startLine > lineStarts.length
            ) {
              payload.source_slice = {
                status: "invalid_range",
                file_path: details.file_path,
                allowed_start_line: details.exact_range.start_line,
                allowed_end_line: details.exact_range.end_line,
              };
            } else {
              let endLine = Math.min(details.exact_range.end_line, startLine + limit - 1, lineStarts.length);
              let truncated = endLine < details.exact_range.end_line;
              let sliceText = source.slice(lineStarts[startLine - 1], lineEnds[endLine - 1]);
              if (args.budget_bytes !== undefined && Buffer.byteLength(sliceText, "utf8") > args.budget_bytes) {
                while (endLine > startLine && Buffer.byteLength(sliceText, "utf8") > args.budget_bytes) {
                  endLine--;
                  sliceText = source.slice(lineStarts[startLine - 1], lineEnds[endLine - 1]);
                }
                if (Buffer.byteLength(sliceText, "utf8") > args.budget_bytes) {
                  sliceText = Buffer.from(sliceText, "utf8").subarray(0, args.budget_bytes).toString("utf8");
                }
                truncated = true;
              }
              const lineCount = endLine - startLine + 1;

              let delegatedImpl: {
                symbol: string;
                file_path: string;
                start_line: number;
                end_line: number;
                text: string;
              } | undefined;

              if (lineCount <= 15 || args.semantic_depth === 2) {
                delegatedImpl = resolveDelegatorImplementation(
                  repo,
                  root,
                  source,
                  sliceText,
                  details
                );
              }

              payload.source_slice = {
                status: "current",
                file_path: details.file_path,
                indexed_content_hash: file.content_hash,
                current_content_hash: currentHash,
                start_line: startLine,
                end_line: endLine,
                text: sliceText,
                truncated,
                related_dependency_analysis: delegatedImpl ? "delegated_implementation_expanded" : "omitted_to_keep_source_read_bounded",
                ...(delegatedImpl ? { delegated_implementation: delegatedImpl } : {}),
                ...(truncated ? { next_start_line: endLine + 1 } : {}),
              };
            }
          }
        } catch (error) {
          payload.source_slice = {
            status: "unavailable",
            file_path: details.file_path,
            reason: error instanceof Error && error.name === "SourceFileLimitError"
              ? "source_exceeds_read_limit"
              : "source_unavailable",
          };
        }
      }
    }
    return payload;
  }

  const locator = new SymbolLocator(repo);
  const fallback = locator.locate(symbol, args.domain, { filePath: args.file_path, reference: args.symbol_ref });

  return {
    symbol,
    found: false,
    message: `Symbol '${symbol}' was not found in the deterministic catalog.`,
    suggestions: fallback.suggestions.map((s) => ({
      name: s.name,
      similarity_score: Math.round(s.similarity_score * 100) / 100,
      exact_range: {
        start_line: s.line_start,
        end_line: s.line_end,
        total_lines: s.line_end - s.line_start + 1,
      },
      signature: s.signature,
      file_path: s.file_path,
    })),
    sibling_methods: fallback.sibling_methods,
    ...(args.include_source ? { source_slice: { status: "unavailable", reason: "symbol_not_found" } } : {}),
  };
}

function toPascalCase(identifier: string): string {
  return identifier
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function resolveDelegatorImplementation(
  repo: SeptumRepository,
  root: string,
  sourceCode: string,
  sliceText: string,
  details: any
): { symbol: string; file_path: string; start_line: number; end_line: number; text: string } | undefined {
  const phpPropMatch = /\$this->([a-zA-Z0-9_]+)\s*->\s*([a-zA-Z0-9_]+)\s*\(/i.exec(sliceText);
  const tsPropMatch = /\bthis\.([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)\s*\(/i.exec(sliceText);
  const pySelfMatch = /\bself\.([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)\s*\(/i.exec(sliceText);
  const staticMatch = /([A-Z][a-zA-Z0-9_]*(?:Action|Service|Handler|UseCase))::([a-zA-Z0-9_]+)\s*\(/i.exec(sliceText);
  const goRecvSigMatch = /^func\s*\(\s*([a-zA-Z_]\w*)\s+\*?([A-Za-z_]\w*)(?:\[[^\]]+\])?\s*\)/m.exec(
    details?.signature || sliceText
  );

  let targetClassName: string | undefined;
  let targetMethodName: string | undefined;

  if (phpPropMatch) {
    const propName = phpPropMatch[1];
    targetMethodName = phpPropMatch[2];
    const ctorPropRegex = new RegExp(
      `(?:protected|private|public)\\s+(?:readonly\\s+)?(?:\\\\?[A-Za-z0-9_\\\\]+\\\\)?([A-Z][A-Za-z0-9_]*)\\s+\\\$${propName}\\b`,
      "i"
    );
    const ctorMatch = ctorPropRegex.exec(sourceCode);
    targetClassName = ctorMatch ? ctorMatch[1] : toPascalCase(propName);
  } else if (tsPropMatch) {
    const propName = tsPropMatch[1];
    targetMethodName = tsPropMatch[2];
    const tsPropRegex = new RegExp(`(?:private|protected|public|readonly)\\s+${propName}\\s*:\\s*([A-Z][A-Za-z0-9_]*)`, "i");
    const tsMatch = tsPropRegex.exec(sourceCode);
    targetClassName = tsMatch ? tsMatch[1] : toPascalCase(propName);
  } else if (pySelfMatch) {
    const propName = pySelfMatch[1];
    targetMethodName = pySelfMatch[2];
    const assignMatch = new RegExp(`\\bself\\.${propName}\\s*=\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\b`).exec(sourceCode);
    const paramName = assignMatch ? assignMatch[1] : propName;
    const typeHintRegex = new RegExp(
      `\\b(?:pub\\s+)?(?:self\\.)?${paramName}\\s*:\\s*(?:&(?:mut\\s+)?|(?:Arc|Box|Rc|Option)<)?(?:[a-zA-Z0-9_]+(?:\\.|::))*([A-Z][A-Za-z0-9_]*)\\b`
    );
    const pyMatch = typeHintRegex.exec(sourceCode);
    targetClassName = pyMatch ? pyMatch[1] : toPascalCase(propName);
  } else if (goRecvSigMatch) {
    const recvVar = goRecvSigMatch[1];
    const goPropRegex = new RegExp(`\\b${recvVar}\\.([a-zA-Z_]\\w*)\\s*\\.\\s*([a-zA-Z_]\\w*)\\s*\\(`);
    const goCallMatch = goPropRegex.exec(sliceText);
    if (goCallMatch) {
      const propName = goCallMatch[1];
      targetMethodName = goCallMatch[2];
      const fieldTypeRegex = new RegExp(`\\b${propName}\\s+\\*?(?:[a-zA-Z0-9_]+\\.)?([A-Z][A-Za-z0-9_]*)\\b`);
      const fieldMatch = fieldTypeRegex.exec(sourceCode);
      targetClassName = fieldMatch ? fieldMatch[1] : toPascalCase(propName);
    }
  } else if (staticMatch) {
    targetClassName = staticMatch[1];
    targetMethodName = staticMatch[2];
  }

  if (!targetClassName || !targetMethodName) {
    // Fallback: expand same-file local helper delegation for thin polyglot wrappers (Go/Python/PHP/Rust).
    const currentFile = details?.file_path ? repo.getFileByPath(details.file_path) : undefined;
    if (!currentFile) return undefined;
    const localSymbols = repo.getSymbolsByFileId(currentFile.id).filter(
      (s) =>
        (s.kind === "function" || s.kind === "method") &&
        s.line_start !== details.exact_range?.start_line
    );
    const bodyWithoutHeader = sliceText.split(/\r?\n/).slice(1).join("\n") || sliceText;
    const localMatch = localSymbols.find((s) => {
      const shortName = s.name.split(/::|@|\./).pop() || s.name;
      if (shortName.length < 2) return false;
      const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:\\b(?:self|this|\\$this|[a-zA-Z_]\\w*)\\s*(?:\\.|->|::)\\s*|\\b)${escaped}\\s*\\(`).test(bodyWithoutHeader);
    });
    if (!localMatch) return undefined;
    const { lineStarts: sameStarts, lineEnds: sameEnds } = indexLineOffsets(sourceCode);
    const lStart = localMatch.line_start;
    const lEnd = Math.min(localMatch.line_end, sameStarts.length);
    if (lStart > sameStarts.length || lEnd < lStart) return undefined;
    return {
      symbol: localMatch.name,
      file_path: details.file_path,
      start_line: lStart,
      end_line: lEnd,
      text: sourceCode.slice(sameStarts[lStart - 1], sameEnds[lEnd - 1]),
    };
  }

  const candidateQueries = [
    `${targetClassName}::${targetMethodName}`,
    `${targetClassName}@${targetMethodName}`,
    targetMethodName,
  ];

  let targetSymbol: any = undefined;
  for (const q of candidateQueries) {
    const matches = repo.findSymbolsByName(q);
    const exact = matches.find(
      (m) =>
        (m.name.includes(targetClassName!) ||
          m.symbol_ref?.container === targetClassName ||
          m.symbol_ref?.receiver === targetClassName) &&
        (m.name.endsWith(`::${targetMethodName}`) ||
          m.name.endsWith(`@${targetMethodName}`) ||
          m.name === targetMethodName)
    );
    if (exact) {
      targetSymbol = exact;
      break;
    }
    if (q !== targetMethodName && matches.length === 1) {
      targetSymbol = matches[0];
      break;
    }
  }

  if (!targetSymbol) {
    const classMatches = repo.findSymbolsByName(targetClassName);
    if (classMatches.length >= 1) {
      const cls = classMatches[0];
      const fileSymbols = repo.getSymbolsByFileId(cls.file_id);
      const methodSym = fileSymbols.find(
        s => s.kind === "method" && (s.name.endsWith(`::${targetMethodName}`) || s.name.endsWith(`@${targetMethodName}`) || s.name === targetMethodName)
      );
      if (methodSym) {
        targetSymbol = { ...methodSym, file_path: cls.file_path };
      }
    }
  }

  if (!targetSymbol || !targetSymbol.file_path) return undefined;

  if (targetSymbol.file_path === details.file_path && targetSymbol.line_start === details.exact_range.start_line) {
    return undefined;
  }

  try {
    const targetFullPath = resolve(root, targetSymbol.file_path);
    if (!existsSync(targetFullPath)) return undefined;
    const targetSource = readSourceFile(targetFullPath);
    const { lineStarts: targetStarts, lineEnds: targetEnds } = indexLineOffsets(targetSource);

    const tStart = targetSymbol.line_start;
    const tEnd = Math.min(targetSymbol.line_end, targetStarts.length);
    if (tStart > targetStarts.length || tEnd < tStart) return undefined;

    const targetText = targetSource.slice(targetStarts[tStart - 1], targetEnds[tEnd - 1]);
    return {
      symbol: targetSymbol.name,
      file_path: targetSymbol.file_path,
      start_line: tStart,
      end_line: tEnd,
      text: targetText,
    };
  } catch {
    return undefined;
  }
}
