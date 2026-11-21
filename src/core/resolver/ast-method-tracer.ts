import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { ExecutionChainNode, FileRecord, SymbolRecord } from "../../types/index.ts";
import { bindContextFile } from "../retrieval/typescript-references.ts";

export type BoundUnit = ReturnType<typeof bindContextFile>;
export type TracerDependency = { target: string; statement: string; line_number: number; is_external: boolean };

export interface AstMethodTracerContext {
  projectRoot: string;
  maxChainNodes: number;
  hasWorkspaceRoot: boolean;
  fileSymbols: (fileId: number) => SymbolRecord[];
  fileDependencies: (fileId: number) => TracerDependency[];
  resolveImportTargets: (fromPath: string, moduleSpec: string) => FileRecord[];
  resolveImportToFile: (fromPath: string, moduleSpec: string) => FileRecord | undefined;
  resolveExecutableSymbol: (symbols: SymbolRecord[], preferredNames: string[]) => SymbolRecord | undefined;
  isExecutableSymbol: (symbol: SymbolRecord) => boolean;
  detectStage: (filePath: string, archetype: string) => string;
}

/** Locate the narrowest AST node covering a symbol's indexed line span. */
export function findAstNodeForSymbol(unit: BoundUnit, sym: SymbolRecord): ts.Node | undefined {
  let best: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    const sLine = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const eLine = unit.source.getLineAndCharacterOfPosition(node.end).line + 1;
    if (sLine <= sym.line_start && eLine >= sym.line_end) {
      if (ts.isFunctionLike(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node)) {
        best = node;
      }
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(unit.source, visit);
  return best ?? unit.declaration(sym.line_start, sym.line_end);
}

/** Collect non-type-only AST import declarations and their referenced symbol names. */
export function collectActiveAstImports(importDecl: ts.ImportDeclaration, importedNames: Set<string>): string[] {
  if (importDecl.importClause?.isTypeOnly) return [];
  const named = importDecl.importClause?.namedBindings;
  return [...importedNames].filter((name) => {
    if (named && ts.isNamedImports(named)) {
      const el = named.elements.find((e) => (e.propertyName ?? e.name).text === name);
      if (el?.isTypeOnly) return false;
    }
    return name !== "*";
  });
}

function resolveAstTargetSymbol(
  ctx: AstMethodTracerContext,
  resolvedFile: FileRecord,
  symName: string,
  loadBound: (filePath: string) => BoundUnit | null
): SymbolRecord | undefined {
  const fileSymbols = ctx.fileSymbols(resolvedFile.id);
  const direct = ctx.resolveExecutableSymbol(fileSymbols, [symName]);
  if (direct || !/\.[cm]?[jt]sx?$/i.test(resolvedFile.path)) return direct;

  const targetUnit = loadBound(resolvedFile.path);
  const exportedNode = targetUnit?.exported(symName);
  if (!targetUnit || !exportedNode) return undefined;

  const sLine = targetUnit.source.getLineAndCharacterOfPosition(exportedNode.getStart()).line + 1;
  const eLine = targetUnit.source.getLineAndCharacterOfPosition(exportedNode.end).line + 1;
  return fileSymbols.find((s) => s.line_start >= sLine && s.line_end <= eLine && ctx.isExecutableSymbol(s));
}

/**
 * AST-verified BFS traversal for TypeScript/JavaScript methods.
 * Expands same-file local helper calls without consuming import hop budget,
 * and follows bound imported callees/references up to effectiveMaxDepth.
 */
export function traverseAstMethodGraph(
  ctx: AstMethodTracerContext,
  startFile: FileRecord,
  startSymbol: SymbolRecord,
  chain: ExecutionChainNode[],
  effectiveMaxDepth: number
): void {
  const boundCache = new Map<string, BoundUnit | null>();
  const loadBound = (filePath: string): BoundUnit | null => {
    if (boundCache.has(filePath)) return boundCache.get(filePath)!;
    const fullPath = resolve(ctx.projectRoot, filePath);
    const source = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : "";
    const unit = source ? bindContextFile(filePath, source) : null;
    boundCache.set(filePath, unit);
    return unit;
  };

  const visitedNodes = new Set<string>([`${startFile.path}:${startSymbol.name}:${startSymbol.line_start}`]);
  const queue: Array<{ file: FileRecord; symbol: SymbolRecord; depth: number; visualDepth: number }> = [
    { file: startFile, symbol: startSymbol, depth: 1, visualDepth: 1 },
  ];

  while (queue.length > 0 && chain.length < ctx.maxChainNodes) {
    const current = queue.shift()!;
    if (current.depth > effectiveMaxDepth || !/\.[cm]?[jt]sx?$/i.test(current.file.path)) continue;

    const unit = loadBound(current.file.path);
    const declNode = unit ? findAstNodeForSymbol(unit, current.symbol) : undefined;
    if (!unit || !declNode) continue;

    const refs = unit.references(declNode);
    // Bridge same-file local helper calls (e.g. thin entrypoint wrappers delegating to local functions).
    const currentSymbols = ctx.fileSymbols(current.file.id);
    for (const localNode of refs.locals) {
      if (chain.length >= ctx.maxChainNodes) break;
      const isLocalCall = refs.calls.some((c) => c.target === localNode);
      if (!isLocalCall) continue;
      const localStart = unit.source.getLineAndCharacterOfPosition(localNode.getStart()).line + 1;
      const localEnd = unit.source.getLineAndCharacterOfPosition(localNode.end).line + 1;
      const localSymbol = currentSymbols.find(
        (s) =>
          ctx.isExecutableSymbol(s) &&
          (s.line_start === localStart || (s.line_start >= localStart && s.line_end <= localEnd))
      );
      if (!localSymbol) continue;
      const localVisitKey = `${current.file.path}:${localSymbol.name}:${localSymbol.line_start}`;
      if (!chain.some((c) => c.file === current.file.path && c.symbol === localSymbol.name)) {
        const stage = ctx.detectStage(current.file.path, current.file.archetype);
        chain.push({
          stage,
          symbol: localSymbol.name,
          parent_symbol: current.symbol.name,
          depth: current.visualDepth,
          file: current.file.path,
          line: localSymbol.line_start || 1,
          description: `${stage.toUpperCase()} (AST local call): ${localSymbol.name}`,
          relationship: {
            kind: "calls",
            derivation: "source",
            source: { file: current.file.path, line: current.symbol.line_start || 1 },
            reason: "ast_local_call_site",
          },
        });
      }
      if (!visitedNodes.has(localVisitKey)) {
        visitedNodes.add(localVisitKey);
        queue.push({ file: current.file, symbol: localSymbol, depth: current.depth, visualDepth: current.visualDepth + 1 });
      }
    }

    const importEntries = new Map<ts.ImportDeclaration, Set<string>>(refs.imports);
    if (ts.isMethodDeclaration(declNode) && ts.isClassDeclaration(declNode.parent)) {
      const usedProps = new Set<string>();
      const walkProps = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
          usedProps.add(n.name.text);
        }
        ts.forEachChild(n, walkProps);
      };
      walkProps(declNode);
      if (usedProps.size > 0) {
        for (const member of declNode.parent.members) {
          const propNames = ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)
            ? [{ name: member.name.text, typeNode: member.type }]
            : ts.isConstructorDeclaration(member)
              ? member.parameters.filter(p => ts.isIdentifier(p.name)).map(p => ({ name: (p.name as ts.Identifier).text, typeNode: p.type }))
              : [];
          for (const p of propNames) {
            if (!usedProps.has(p.name) || !p.typeNode) continue;
            const typeRefs = unit.references(p.typeNode);
            for (const [imp, names] of typeRefs.imports) {
              const existing = importEntries.get(imp) ?? new Set<string>();
              for (const name of names) existing.add(name);
              importEntries.set(imp, existing);
            }
          }
        }
      }
    }

    const deps = ctx.fileDependencies(current.file.id);

    for (const [importDecl, importedNames] of importEntries) {
      if (chain.length >= ctx.maxChainNodes) break;
      const activeNames = collectActiveAstImports(importDecl, importedNames);
      const moduleSpec = ts.isStringLiteral(importDecl.moduleSpecifier) ? importDecl.moduleSpecifier.text : "";
      if (activeNames.length === 0 || !moduleSpec) continue;

      const importLine = unit.source.getLineAndCharacterOfPosition(importDecl.getStart()).line + 1;
      const dep = deps.find((d) => d.target === moduleSpec || d.line_number === importLine);
      if (dep?.is_external) continue;

      const resolvedFiles = ctx.hasWorkspaceRoot
        ? ctx.resolveImportTargets(current.file.path, moduleSpec)
        : [ctx.resolveImportToFile(current.file.path, moduleSpec)].filter((f): f is FileRecord => !!f);

      for (const resolvedFile of resolvedFiles) {
        for (const symName of activeNames) {
          if (chain.length >= ctx.maxChainNodes) break;
          const mainSymbol = resolveAstTargetSymbol(ctx, resolvedFile, symName, loadBound);
          if (!mainSymbol) continue;

          const isCall = !refs.escapes.has(importDecl) &&
            refs.calls.some((c) => c.target === importDecl && (!c.name || c.name === symName));
          const stage = ctx.detectStage(resolvedFile.path, resolvedFile.archetype);

          if (!chain.some((c) => c.file === resolvedFile.path && c.symbol === mainSymbol.name)) {
            chain.push({
              stage,
              symbol: mainSymbol.name,
              parent_symbol: current.symbol.name,
              depth: current.visualDepth,
              file: resolvedFile.path,
              line: mainSymbol.line_start || 1,
              description: `${stage.toUpperCase()} (${isCall ? "AST call" : "AST import"}): ${mainSymbol.name}`,
              relationship: {
                kind: isCall ? "calls" : "imports",
                derivation: "source",
                source: { file: current.file.path, line: importLine, statement: dep?.statement ?? importDecl.getText(unit.source) },
                reason: isCall ? "ast_call_site" : "ast_referenced_import",
              },
            });
          }

          const visitKey = `${resolvedFile.path}:${mainSymbol.name}:${mainSymbol.line_start}`;
          if (!visitedNodes.has(visitKey) && current.depth < effectiveMaxDepth) {
            visitedNodes.add(visitKey);
            queue.push({ file: resolvedFile, symbol: mainSymbol, depth: current.depth + 1, visualDepth: current.visualDepth + 1 });
          }
        }
      }
    }
  }
}
