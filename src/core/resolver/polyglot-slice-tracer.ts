import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecutionChainNode, FileRecord, SymbolRecord } from "../../types/index.ts";
import { readOptionalSourceFile } from "../resources/source-files.ts";
import type { TracerDependency } from "./ast-method-tracer.ts";

export interface PolyglotSliceTracerContext {
  projectRoot: string;
  maxChainNodes: number;
  hasWorkspaceRoot: boolean;
  fileSymbols: (fileId: number) => SymbolRecord[];
  fileDependencies: (fileId: number) => TracerDependency[];
  extractImportedSymbolNames: (statement: string) => string[];
  resolveImportTargets: (fromPath: string, target: string) => FileRecord[];
  resolveImportToFile: (fromPath: string, target: string) => FileRecord | undefined;
  resolveExecutableSymbol: (symbols: SymbolRecord[], preferredNames: string[]) => SymbolRecord | undefined;
  isExecutableSymbol: (symbol: SymbolRecord) => boolean;
  detectStage: (filePath: string, archetype: string) => string;
}

const IGNORED_LOCAL_CALL_NAMES = new Set(["constructor", "__init__", "new", "main", "get", "set"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readLinesSafe(projectRoot: string, filePath: string): string[] | undefined {
  const fullPath = resolve(projectRoot, filePath);
  if (!existsSync(fullPath)) return undefined;
  try {
    return readOptionalSourceFile(fullPath, "utf-8").split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/**
 * Polyglot method-scoped dependency traversal (Go, Python, PHP, Rust, Ruby, Java, C#).
 * Bridges same-file local helper calls (up to 2 local hops) before matching imported collaborators
 * so thin wrapper handlers expose the services/repositories called inside their local delegates.
 */
export function traversePolyglotMethodDependencies(
  ctx: PolyglotSliceTracerContext,
  startFile: FileRecord,
  methodBody: string,
  methodSymbol: SymbolRecord,
  chain: ExecutionChainNode[]
): void {
  const visitedFiles = new Set<string>([startFile.path]);
  let scopeText = (methodSymbol.signature || "") + "\n" + methodBody;

  // 1. Bridge same-file local helper calls (Go, Python, PHP, Rust, etc.)
  const localSymbols = ctx.fileSymbols(startFile.id).filter((s) => ctx.isExecutableSymbol(s));
  const fileLines = localSymbols.length > 1 ? readLinesSafe(ctx.projectRoot, startFile.path) : undefined;
  if (fileLines) {
    const visitedLocal = new Set<string>([`${methodSymbol.name}:${methodSymbol.line_start}`]);
    const localQueue: Array<{ symbol: SymbolRecord; body: string; depth: number }> = [
      { symbol: methodSymbol, body: methodBody, depth: 0 },
    ];

    while (localQueue.length > 0 && chain.length < ctx.maxChainNodes) {
      const current = localQueue.shift()!;
      if (current.depth >= 2) continue;

      for (const candidate of localSymbols) {
        if (chain.length >= ctx.maxChainNodes) break;
        const candKey = `${candidate.name}:${candidate.line_start}`;
        if (visitedLocal.has(candKey)) continue;
        const shortName = candidate.name.split(/::|@|\./).pop() || candidate.name;
        if (shortName.length < 2 || IGNORED_LOCAL_CALL_NAMES.has(shortName)) continue;

        const callPattern = new RegExp(
          `(?:\\b(?:self|this|\\$this|[a-zA-Z_]\\w*)\\s*(?:\\.|->|::)\\s*|\\b)${escapeRegExp(shortName)}\\s*\\(`
        );
        if (!callPattern.test(current.body)) continue;

        visitedLocal.add(candKey);
        const stage = ctx.detectStage(startFile.path, startFile.archetype);
        if (!chain.some((c) => c.file === startFile.path && c.symbol === candidate.name)) {
          chain.push({
            stage,
            symbol: candidate.name,
            file: startFile.path,
            line: candidate.line_start || 1,
            description: `${stage.toUpperCase()} (local call): ${candidate.name}`,
            relationship: {
              kind: "calls",
              derivation: "source",
              source: { file: startFile.path, line: current.symbol.line_start || 1 },
              reason: "local_call_site",
            },
          });
        }

        const start = Math.max(0, candidate.line_start - 1);
        const end = Math.min(fileLines.length, candidate.line_end);
        const candidateBody = fileLines.slice(start, end).join("\n");
        if (candidateBody) {
          scopeText += `\n${candidate.signature || ""}\n${candidateBody}`;
          localQueue.push({ symbol: candidate, body: candidateBody, depth: current.depth + 1 });
        }
      }
    }
  }

  // 2. Match imported collaborators referenced in the method (and its bridged local helpers)
  const deps = ctx.fileDependencies(startFile.id);
  for (const dep of deps) {
    if (/^\s*(?:import|export)\s+type\b/.test(dep.statement)) continue;
    if (chain.length >= ctx.maxChainNodes) break;
    const importedNames = ctx.extractImportedSymbolNames(dep.statement);
    const baseTarget = dep.target.split(/[\/\\]/).pop()?.replace(/\.[^.]+$/, "") || "";

    const isReferenced =
      (importedNames.length > 0 &&
        importedNames.some((name) => {
          const camel = name.charAt(0).toLowerCase() + name.slice(1);
          return scopeText.includes(name) || scopeText.includes(camel);
        })) ||
      (baseTarget.length > 0 &&
        (scopeText.includes(baseTarget) ||
          scopeText.includes(baseTarget.charAt(0).toLowerCase() + baseTarget.slice(1))));

    if (!isReferenced) continue;

    const resolvedFiles = ctx.hasWorkspaceRoot
      ? ctx.resolveImportTargets(startFile.path, dep.target)
      : dep.is_external
      ? []
      : [ctx.resolveImportToFile(startFile.path, dep.target)].filter((file): file is FileRecord => !!file);

    for (const resolvedFile of resolvedFiles) {
      if (!resolvedFile || visitedFiles.has(resolvedFile.path)) continue;
      visitedFiles.add(resolvedFile.path);

      const stage = ctx.detectStage(resolvedFile.path, resolvedFile.archetype);
      const fileSymbols = ctx.fileSymbols(resolvedFile.id);
      const mainSymbol = ctx.resolveExecutableSymbol(fileSymbols, importedNames);
      if (!mainSymbol) continue;

      const symbolDisplay = mainSymbol.name;
      const shortSymbolDisplay = symbolDisplay.split(/[\\:]/).pop();
      const existingNode = chain.find(
        (c) =>
          (c.file && c.file === resolvedFile.path) ||
          (c.stage === stage &&
            (c.symbol === symbolDisplay || c.symbol.split(/[\\:]/).pop() === shortSymbolDisplay))
      );

      if (!existingNode) {
        chain.push({
          stage,
          symbol: symbolDisplay,
          file: resolvedFile.path,
          line: mainSymbol.line_start || 1,
          description: `${stage.toUpperCase()} (referenced import): ${symbolDisplay}`,
          relationship: {
            kind: "imports",
            derivation: "source",
            source: { file: startFile.path, line: dep.line_number, statement: dep.statement },
            reason: "import referenced in method scope; not proof of a call",
          },
        });
      }
    }
  }
}
