import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { computeContentHash } from "../../core/ingestion/hasher.ts";
import { isPathContained } from "../../core/resolver/path-resolver.ts";
import { readSourceFile } from "../../core/resources/source-files.ts";
import { SymbolLocator } from "../../core/resolver/symbol-locator.ts";
import type { GetSymbolArgs } from "../../types/index.ts";
import { symbolWorkspace, withSymbolEvidence } from "../../core/retrieval/symbol-evidence.ts";

export function handleGetSymbol(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetSymbolArgs,
  workspaceRoot?: string
) {
  const root = symbolWorkspace(repo, workspaceRoot || args.workspace_path);
  return withSymbolEvidence(repo, root, { operation: "inspect", requested: args.symbol_ref },
    () => inspectSymbol(repo, config, args, root));
}

function inspectSymbol(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolArgs,
  workspaceRoot?: string
) {
  const symbol = (args.symbol_ref?.name || args.symbol || (args as unknown as Record<string, unknown>).query || "").toString().trim();
  if (!symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderController::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  if (args.symbol_ref) {
    const file = repo.getFileByPath(args.symbol_ref.file_path);
    if (!file || file.content_hash !== args.symbol_ref.indexed_content_hash) {
      return { content: [{ type: "text" as const, text: JSON.stringify({
        symbol, status: "stale_reference", found: false,
        message: "Declaration reference is stale; locate the symbol again.",
        ...(args.include_source ? { source_slice: { status: "stale", reason: "stale_reference" } } : {}),
      }) }] };
    }
  }
  const selectedCandidates = repo.findSymbolsByName(symbol, {
    domain: args.domain, filePath: args.file_path, reference: args.symbol_ref,
  });
  if (selectedCandidates.length > 1) {
    const candidates = selectedCandidates.map(candidate => ({
      name: candidate.name, file_path: candidate.file_path, kind: candidate.kind, signature: candidate.signature,
      start_line: candidate.line_start, end_line: candidate.line_end, symbol_ref: candidate.symbol_ref,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify({
      symbol, status: "ambiguous", found: false, candidates,
      ...(args.include_source ? { source_slice: { status: "ambiguous", candidates } } : {}),
      message: "Multiple matching declarations; select a candidate with symbol_ref or narrow with file_path.",
    }, null, 2) }] };
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
    const payload: Record<string, unknown> = { ...details };
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
            const lineStarts = [0];
            const lineEnds: number[] = [];
            for (const match of source.matchAll(/\r\n|\n|\r/g)) {
              const offset = match.index!;
              lineEnds.push(offset);
              lineStarts.push(offset + match[0].length);
            }
            lineEnds.push(source.length);
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
              const endLine = Math.min(details.exact_range.end_line, startLine + limit - 1, lineStarts.length);
              const truncated = endLine < details.exact_range.end_line;
              const sliceText = source.slice(lineStarts[startLine - 1], lineEnds[endLine - 1]);
              const lineCount = endLine - startLine + 1;

              // 1-hop Transitive Delegator Expansion (Hollow Slicing Prevention)
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
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  // Fallback to fuzzy SymbolLocator to provide actionable hints
  const locator = new SymbolLocator(repo);
  const fallback = locator.locate(symbol, args.domain, { filePath: args.file_path, reference: args.symbol_ref });

  const payload = {
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

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
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
  // 1. Check for PHP/TS/Python/Go delegator call patterns:
  //    $this->property->execute(...) or ->handle(...)
  //    this.property.execute(...) or .handle(...)
  //    self.property.execute(...) (Python)
  //    receiver.property.Execute(...) (Go)
  //    ClassName::execute(...) or ClassName::handle(...)
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
    if (ctorMatch) {
      targetClassName = ctorMatch[1];
    } else {
      targetClassName = toPascalCase(propName);
    }
  } else if (tsPropMatch) {
    const propName = tsPropMatch[1];
    targetMethodName = tsPropMatch[2];
    const tsPropRegex = new RegExp(`(?:private|protected|public|readonly)\\s+${propName}\\s*:\\s*([A-Z][A-Za-z0-9_]*)`, "i");
    const tsMatch = tsPropRegex.exec(sourceCode);
    if (tsMatch) {
      targetClassName = tsMatch[1];
    } else {
      targetClassName = toPascalCase(propName);
    }
  } else if (pySelfMatch) {
    const propName = pySelfMatch[1];
    targetMethodName = pySelfMatch[2];
    // Check `self.prop = param` in `__init__` or direct `prop: TypeName` type annotation
    const assignMatch = new RegExp(`\\bself\\.${propName}\\s*=\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\b`).exec(sourceCode);
    const paramName = assignMatch ? assignMatch[1] : propName;
    const typeHintRegex = new RegExp(`\\b(?:self\\.)?${paramName}\\s*:\\s*(?:[a-zA-Z0-9_]+\\.)?([A-Z][A-Za-z0-9_]*)\\b`);
    const pyMatch = typeHintRegex.exec(sourceCode);
    if (pyMatch) {
      targetClassName = pyMatch[1];
    } else {
      targetClassName = toPascalCase(propName);
    }
  } else if (goRecvSigMatch) {
    const recvVar = goRecvSigMatch[1];
    const goPropRegex = new RegExp(`\\b${recvVar}\\.([a-zA-Z_]\\w*)\\s*\\.\\s*([a-zA-Z_]\\w*)\\s*\\(`);
    const goCallMatch = goPropRegex.exec(sliceText);
    if (goCallMatch) {
      const propName = goCallMatch[1];
      targetMethodName = goCallMatch[2];
      const fieldTypeRegex = new RegExp(`\\b${propName}\\s+\\*?(?:[a-zA-Z0-9_]+\\.)?([A-Z][A-Za-z0-9_]*)\\b`);
      const fieldMatch = fieldTypeRegex.exec(sourceCode);
      if (fieldMatch) {
        targetClassName = fieldMatch[1];
      } else {
        targetClassName = toPascalCase(propName);
      }
    }
  } else if (staticMatch) {
    targetClassName = staticMatch[1];
    targetMethodName = staticMatch[2];
  }

  if (!targetClassName || !targetMethodName) return undefined;

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
      const methodSym = fileSymbols.find(s => s.kind === "method" && (s.name.endsWith(`::${targetMethodName}`) || s.name.endsWith(`@${targetMethodName}`) || s.name === targetMethodName));
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
    const targetStarts = [0];
    const targetEnds: number[] = [];
    for (const match of targetSource.matchAll(/\r\n|\n|\r/g)) {
      targetEnds.push(match.index!);
      targetStarts.push(match.index! + match[0].length);
    }
    targetEnds.push(targetSource.length);

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
