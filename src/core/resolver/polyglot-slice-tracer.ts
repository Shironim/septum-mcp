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

function isIdentifierReferencedInScope(scopeText: string, name: string): boolean {
  if (!name) return false;
  const check = (candidate: string) =>
    new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(candidate)}(?![A-Za-z0-9_$])`).test(scopeText);
  if (check(name)) return true;
  const camel = name.charAt(0).toLowerCase() + name.slice(1);
  return camel !== name && check(camel);
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
  const emittedFileSymbols = new Set<string>();
  for (const dep of deps) {
    if (/^\s*(?:import|export)\s+type\b/.test(dep.statement)) continue;
    if (chain.length >= ctx.maxChainNodes) break;
    const importedNames = ctx.extractImportedSymbolNames(dep.statement);
    const baseTarget = dep.target.split(/[\/\\]/).pop()?.replace(/\.[^.]+$/, "") || "";

    const referencedNames = importedNames.filter((name) => isIdentifierReferencedInScope(scopeText, name));
    const isReferenced =
      importedNames.length > 0
        ? referencedNames.length > 0
        : baseTarget.length > 0 && isIdentifierReferencedInScope(scopeText, baseTarget);

    if (!isReferenced) continue;

    const resolvedFiles = ctx.hasWorkspaceRoot
      ? ctx.resolveImportTargets(startFile.path, dep.target)
      : dep.is_external
      ? []
      : [ctx.resolveImportToFile(startFile.path, dep.target)].filter((file): file is FileRecord => !!file);

    for (const resolvedFile of resolvedFiles) {
      if (!resolvedFile || resolvedFile.path === startFile.path) continue;

      const stage = ctx.detectStage(resolvedFile.path, resolvedFile.archetype);
      const fileSymbols = ctx.fileSymbols(resolvedFile.id);
      const matchedSymbols: SymbolRecord[] = [];
      if (referencedNames.length > 0) {
        for (const refName of referencedNames) {
          const direct = fileSymbols.find(
            (s) =>
              ctx.isExecutableSymbol(s) &&
              (s.name === refName ||
                s.name.endsWith(`::${refName}`) ||
                s.name.endsWith(`@${refName}`) ||
                s.name.endsWith(`.${refName}`))
          );
          const resolved = direct ?? ctx.resolveExecutableSymbol(fileSymbols, [refName]);
          if (resolved && !matchedSymbols.some((m) => m.name === resolved.name && m.line_start === resolved.line_start)) {
            matchedSymbols.push(resolved);
          }
        }
      } else if (!visitedFiles.has(resolvedFile.path)) {
        visitedFiles.add(resolvedFile.path);
        const fallback = ctx.resolveExecutableSymbol(fileSymbols, []);
        if (fallback) matchedSymbols.push(fallback);
      }

      for (const mainSymbol of matchedSymbols) {
        if (chain.length >= ctx.maxChainNodes) break;
        const emitKey = `${resolvedFile.path}\0${mainSymbol.name}`;
        if (emittedFileSymbols.has(emitKey)) continue;
        emittedFileSymbols.add(emitKey);

        const symbolDisplay = mainSymbol.name;
        const shortSymbolDisplay = symbolDisplay.split(/[\\:]/).pop();
        const existingNode = chain.find(
          (c) =>
            c.file === resolvedFile.path &&
            (c.symbol === symbolDisplay || c.symbol.split(/[\\:]/).pop() === shortSymbolDisplay)
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
}
