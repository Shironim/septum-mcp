import type { GetSymbolImpactResponse, InboundCaller } from "../../types/index.ts";
import { resolve } from "node:path";
import { assertPathContained } from "./path-resolver.ts";
import { probeSourcePath, readSourceFile } from "../resources/source-files.ts";
import ts from "typescript";
import { ImportResolver } from "./import-resolver.ts";

type SymbolSpan = { name: string; kind: string; signature?: string; line_start: number; line_end: number; file_path: string };
interface ImpactFacts {
  query: string;
  container: string;
  method: string;
  targets: SymbolSpan[];
  dependencies: Array<{ file: string; line_number: number; domain_name?: string | null; import_statement?: string }>;
  samePackageFiles: Set<string>;
  symbolsByFile: Map<string, Array<{ name: string; kind: string; signature: string; line_start: number; line_end: number }>>;
  domainsByFile: Map<string, string>;
  workspaceRoot?: string;
}
function escapeRegExp(str: string): string { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Inferred caller evidence, independent of SQLite queries and persistence. */
export function analyzeSymbolImpact(facts: ImpactFacts): GetSymbolImpactResponse {
  const { query: trimmed, container: targetContainer, method: targetMethod, targets: targetSymRows,
    dependencies: depRows, samePackageFiles: implicitPackageFiles, symbolsByFile: callerSymbolsByFile, domainsByFile: domainByFile } = facts;
  const options = { workspaceRoot: facts.workspaceRoot };
  const definingFiles = new Set(targetSymRows.map(row => row.file_path.replace(/\\/g, "/")));
  const uniqueCallerFiles = [...new Set(depRows.map(row => row.file))];
  const containerWordRegex = new RegExp(`\\b${escapeRegExp(targetContainer)}\\b`);
  const targetSpansByFile = new Map<string, Array<{ start: number; end: number }>>();
  for (const row of targetSymRows) {
    if (!targetMethod && row.name.includes("::") && !trimmed.includes("::")) continue;
    const path = row.file_path.replace(/\\/g, "/");
    const spans = targetSpansByFile.get(path) ?? [];
    spans.push({ start: row.line_start, end: row.line_end });
    targetSpansByFile.set(path, spans);
  }
    const findEnclosingSymbol = (
      filePath: string,
      lineNum: number
    ): { name: string; kind: string; signature: string } | undefined => {
      const syms = callerSymbolsByFile.get(filePath);
      if (!syms) return undefined;
      return syms.find((s) => lineNum >= s.line_start && lineNum <= s.line_end);
    };

    const callersMap = new Map<string, InboundCaller>();

    // Import-bound identifier calls/instantiations carry call-site coordinates, not import lines.
    if (!targetMethod && targetSymRows.some(row => row.kind === "function" || row.kind === "class")) {
      const tsCallerEntries: Array<{ file: string; fullPath: string; source: ts.SourceFile }> = [];
      for (const file of uniqueCallerFiles) {
        if (!/\.[cm]?[jt]sx?$/.test(file) || !options.workspaceRoot) continue;
        const fullPath = resolve(options.workspaceRoot, file);
        assertPathContained(fullPath, options.workspaceRoot, "Caller source");
        if (probeSourcePath(fullPath) !== "file") continue;
        tsCallerEntries.push({
          file,
          fullPath,
          source: ts.createSourceFile(fullPath, readSourceFile(fullPath), ts.ScriptTarget.Latest, true),
        });
      }

      if (tsCallerEntries.length > 0) {
        const sourceByPath = new Map(tsCallerEntries.map(entry => [entry.fullPath, entry.source]));
        const host = ts.createCompilerHost({ noLib: true, noResolve: true });
        host.getSourceFile = name => sourceByPath.get(name);
        const checker = ts.createProgram(
          tsCallerEntries.map(entry => entry.fullPath),
          { noLib: true, noResolve: true },
          host
        ).getTypeChecker();

        for (const { file, source } of tsCallerEntries) {
          const bindings = new Set<ts.Symbol>();
          for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
            const resolution = new ImportResolver(options.workspaceRoot!).resolve(statement.moduleSpecifier.text, file);
            if (resolution.status !== "resolved" || !resolution.targets.some(target => target.files.some(path => definingFiles.has(path)))) continue;
            const clause = statement.importClause;
            if (clause?.name && targetSymRows.some(row => row.signature?.includes("export default"))) { const binding = checker.getSymbolAtLocation(clause.name); if (binding) bindings.add(binding); }
            if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const specifier of clause.namedBindings.elements) {
              if (specifier.isTypeOnly || (specifier.propertyName ?? specifier.name).text !== targetContainer) continue;
              const binding = checker.getSymbolAtLocation(specifier.name); if (binding) bindings.add(binding);
            }
          }
          if (bindings.size === 0) continue;

          const recordUsage = (expr: ts.Node, usageKind: "call" | "instantiation" | "heritage") => {
            const line = source.getLineAndCharacterOfPosition(expr.getStart(source)).line + 1;
            const enclosing = findEnclosingSymbol(file, line);
            callersMap.set(`${file}:${line}:${usageKind}`, {
              file,
              line,
              caller: enclosing?.name ?? `${file}:${line}`,
              kind: usageKind,
              domain: domainByFile.get(file),
            });
          };

          const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.has(checker.getSymbolAtLocation(node.expression)!)) {
              recordUsage(node.expression, "call");
            } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && bindings.has(checker.getSymbolAtLocation(node.expression)!)) {
              recordUsage(node.expression, "instantiation");
            } else if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent) && ts.isIdentifier(node.expression) && bindings.has(checker.getSymbolAtLocation(node.expression)!)) {
              recordUsage(node.expression, "heritage");
            }
            ts.forEachChild(node, visit);
          };
          visit(source);
        }
      }
    }

    for (const row of depRows) {
      const enclosing = findEnclosingSymbol(row.file, row.line_number);
      const callerName = enclosing ? enclosing.name : `${row.file}:${row.line_number}`;
      const key = `${row.file}:${row.line_number}:${callerName}`;

      if (!callersMap.has(key)) {
        callersMap.set(key, {
          file: row.file,
          caller: callerName,
          line: row.line_number,
          kind: "import",
          domain: row.domain_name ?? undefined,
        });
      }
    }

    // 4. Scan file content of callers for exact method/function calls
    const targetMethodRow = targetSymRows.find((r) => r.kind === "method");
    const effectiveMethod =
      targetMethod ||
      (targetMethodRow ? (targetMethodRow.name.split("::").pop() ?? "") : "");
    const targetMethodOwnerFull = targetMethodRow?.name.includes("::")
      ? targetMethodRow.name.split("::")[0]
      : targetMethod
      ? targetContainer
      : undefined;
    const targetMethodOwnerShort = targetMethodOwnerFull?.split(/[\\/]/).pop();
    const isStaticPhpMethod =
      Boolean(effectiveMethod) &&
      targetSymRows.length > 0 &&
      targetSymRows.every((r) => /\bstatic\s+function\b/.test(r.signature ?? ""));
    const staticOwnerCallRegex =
      effectiveMethod && targetMethodOwnerShort
        ? new RegExp(
            `\\b(?:${escapeRegExp(targetMethodOwnerShort)}${
              targetMethodOwnerFull && targetMethodOwnerFull !== targetMethodOwnerShort
                ? `|${escapeRegExp(targetMethodOwnerFull)}`
                : ""
            })::${escapeRegExp(effectiveMethod)}\\s*\\(`
          )
        : null;
    // For standalone functions, match unqualified calls (`fn(...)`) and only allow qualified calls
    // (`alias.fn(...)`) when `alias` is a module/namespace import binding (never `cls.fn`, `self.fn`, etc.).
    const isFunctionTarget = !effectiveMethod && targetSymRows.some((r) => r.kind === "function");
    const nonTsFnCallRegex = isFunctionTarget
      ? new RegExp(`(?:^|[^.\\w$:])\\b${escapeRegExp(targetContainer)}\\s*\\(`)
      : null;
    const nonTsFnDeclRegex = nonTsFnCallRegex
      ? new RegExp(`\\b(?:function|func|def|fn)\\s+${escapeRegExp(targetContainer)}\\b`)
      : null;

    const definingStems = new Set(
      Array.from(definingFiles).flatMap((df) => {
        const stem = df.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        const dir = df.split("/").slice(-2, -1)[0] ?? "";
        return /\.go$/i.test(df) ? [stem, dir] : [stem];
      }).filter(Boolean)
    );
    const moduleAliasesByFile = new Map<string, Set<string>>();
    const directAliasesByFile = new Map<string, Set<string>>();
    const filesWithImportStmts = new Set<string>();
    if (isFunctionTarget) {
      for (const row of depRows) {
        const stmt = String(row.import_statement || "");
        if (!stmt) continue;
        filesWithImportStmts.add(row.file);
        // Python: `from pkg import stem as alias` or `from pkg import stem`
        const fromMatch = stmt.match(/^\s*from\s+([^\s]+)\s+import\s+([\s\S]+)$/);
        if (fromMatch) {
          const items = fromMatch[2]!.replace(/[()]/g, "").split(",");
          for (const rawItem of items) {
            const item = rawItem.trim();
            if (!item) continue;
            const asMatch = item.match(/^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/);
            const orig = asMatch ? asMatch[1]! : item.split(/\s+/)[0]!;
            const bound = asMatch ? asMatch[2]! : orig;
            if (orig === targetContainer && bound !== targetContainer) {
              const set = directAliasesByFile.get(row.file) ?? new Set<string>();
              set.add(bound);
              directAliasesByFile.set(row.file, set);
            } else if (definingStems.has(orig) && !["cls", "self", "this", "super"].includes(bound)) {
              const set = moduleAliasesByFile.get(row.file) ?? new Set<string>();
              set.add(bound);
              moduleAliasesByFile.set(row.file, set);
            }
          }
          continue;
        }
        // Python: `import pkg.stem as alias` or `import pkg.stem`
        const pyImportAs = stmt.match(/^\s*import\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_]\w*))?/);
        if (pyImportAs) {
          const modTail = pyImportAs[1]!.split(".").pop() ?? "";
          const bound = pyImportAs[2] ?? modTail;
          if (definingStems.has(modTail) && !["cls", "self", "this", "super"].includes(bound)) {
            const set = moduleAliasesByFile.get(row.file) ?? new Set<string>();
            set.add(bound);
            moduleAliasesByFile.set(row.file, set);
          }
          continue;
        }
        // Go: `import "pkg/dir"` or `import alias "pkg/dir"`
        const goImport = stmt.match(/^\s*(?:import\s+)?(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/);
        if (goImport) {
          const pkgTail = goImport[2]!.split("/").pop() ?? "";
          const bound = goImport[1] ?? pkgTail;
          if (definingStems.has(pkgTail)) {
            const set = moduleAliasesByFile.get(row.file) ?? new Set<string>();
            set.add(bound);
            moduleAliasesByFile.set(row.file, set);
          }
        }
      }
    }

    if (effectiveMethod || nonTsFnCallRegex) {
      for (const filePath of uniqueCallerFiles) {
        if (nonTsFnCallRegex && /\.[cm]?[jt]sx?$/.test(filePath)) continue;
        const moduleAliases = moduleAliasesByFile.get(filePath);
        const directAliases = directAliasesByFile.get(filePath);
        const fallbackPkgAliases = !filesWithImportStmts.has(filePath) && definingStems.size > 0
          ? definingStems
          : undefined;
        const effectiveModuleAliases = moduleAliases && moduleAliases.size > 0 ? moduleAliases : fallbackPkgAliases;
        const qualifiedFnRegex =
          effectiveModuleAliases && effectiveModuleAliases.size > 0
            ? new RegExp(
                `\\b(?:${Array.from(effectiveModuleAliases).map(escapeRegExp).join("|")})\\.${escapeRegExp(targetContainer)}\\s*\\(`
              )
            : null;
        const aliasedDirectFnRegex =
          directAliases && directAliases.size > 0
            ? new RegExp(
                `(?:^|[^.\\w$:])\\b(?:${Array.from(directAliases).map(escapeRegExp).join("|")})\\s*\\(`
              )
            : null;
        try {
          const fullPath = options.workspaceRoot ? resolve(options.workspaceRoot, filePath) : filePath;
          if (options.workspaceRoot) assertPathContained(fullPath, options.workspaceRoot, "Inbound caller source");
          if (probeSourcePath(fullPath) === "file") {
            const content = readSourceFile(fullPath);
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              const trimmedLine = line.trim();
              if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("#") || trimmedLine.startsWith("*")) {
                continue;
              }
              const matched = effectiveMethod
                ? (!isStaticPhpMethod &&
                    line.includes(`->${effectiveMethod}(`) &&
                    (definingFiles.has(filePath) || !line.includes(`$this->${effectiveMethod}(`))) ||
                  (staticOwnerCallRegex
                    ? staticOwnerCallRegex.test(line)
                    : line.includes(`::${effectiveMethod}(`)) ||
                  (!isStaticPhpMethod && line.includes(`.${effectiveMethod}(`))
                : Boolean(
                    !nonTsFnDeclRegex?.test(line) &&
                      (nonTsFnCallRegex?.test(line) ||
                        qualifiedFnRegex?.test(line) ||
                        aliasedDirectFnRegex?.test(line))
                  );
              if (matched) {
                const lineNum = i + 1;
                const enclosing = findEnclosingSymbol(filePath, lineNum);
                const callerName = enclosing ? enclosing.name : `${filePath}:${lineNum}`;
                const key = `${filePath}:${lineNum}:${callerName}`;
                if (!callersMap.has(key)) {
                  callersMap.set(key, {
                    file: filePath,
                    caller: callerName,
                    line: lineNum,
                    kind: "call",
                    domain: domainByFile.get(filePath),
                  });
                }
              }
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // 4b. Scan same-file (definingFiles outside target declaration range) and same-package/namespace files
    const isLineInsideTargetSpan = (filePath: string, lineNum: number): boolean => {
      const spans = targetSpansByFile.get(filePath);
      if (!spans || spans.length === 0) return false;
      return spans.some((span) => lineNum >= span.start && lineNum <= span.end);
    };

    const targetIsFunctionOnly =
      !targetMethod &&
      targetSymRows.every((r) => r.kind === "function" || r.kind === "method");
    const escapedMethod = targetMethod ? escapeRegExp(targetMethod) : "";
    const escapedContainer = escapeRegExp(targetContainer);
    const sameFileMethodCallRegex = targetMethod
      ? new RegExp(
          `(?:\\$this->|self::|static::|\\bthis\\.|\\bself\\.|\\b${escapedContainer}::)${escapedMethod}\\s*\\(`
        )
      : null;
    const goReceiverMethodCallRegex = targetMethod
      ? new RegExp(`\\b[A-Za-z_]\\w*\\.${escapedMethod}\\s*\\(`)
      : null;
    const fnCallRegex = !targetMethod
      ? new RegExp(`(?:^|[^.\\w$:])${escapedContainer}\\s*\\(`)
      : null;
    const fnDeclRegex = !targetMethod
      ? new RegExp(`\\b(?:function|func|def|fn)\\s+${escapedContainer}\\b`)
      : null;
    const classUsageRegex = !targetMethod
      ? new RegExp(
          `(?:\\bnew\\s+${escapedContainer}\\b|\\b${escapedContainer}::|&?\\b${escapedContainer}\\s*\\{|\\*?\\b${escapedContainer}\\b)`
        )
      : null;

    // Same-file call-site scan (outside target symbol's own line_start..line_end)
    for (const filePath of definingFiles) {
      try {
        const fullPath = options.workspaceRoot ? resolve(options.workspaceRoot, filePath) : filePath;
        if (options.workspaceRoot) assertPathContained(fullPath, options.workspaceRoot, "Inbound caller source");
        if (probeSourcePath(fullPath) !== "file") continue;
        const content = readSourceFile(fullPath);
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const lineNum = i + 1;
          if (isLineInsideTargetSpan(filePath, lineNum)) continue;
          const line = lines[i];
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("#") || trimmedLine.startsWith("*")) {
            continue;
          }
          const enclosing = findEnclosingSymbol(filePath, lineNum);
          let matched = false;
          if (targetMethod) {
            if (sameFileMethodCallRegex?.test(line)) {
              matched = true;
            } else if (/\.go$/i.test(filePath) && goReceiverMethodCallRegex?.test(line) && enclosing) {
              const recv = enclosing.signature.match(/^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)(?:\[[^\]]+\])?\s*\)/);
              if (recv?.[1] === targetContainer) matched = true;
            }
          } else if (targetIsFunctionOnly) {
            if (fnCallRegex?.test(line) && !fnDeclRegex?.test(line)) {
              matched = true;
            }
          } else if (enclosing && classUsageRegex?.test(line)) {
            matched = true;
          }

          if (matched) {
            const callerName = enclosing ? enclosing.name : `${filePath}:${lineNum}`;
            const key = `${filePath}:${lineNum}:${callerName}`;
            if (!callersMap.has(key)) {
              callersMap.set(key, {
                file: filePath,
                caller: callerName,
                line: lineNum,
                kind: "call",
                domain: domainByFile.get(filePath),
              });
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // Same-package / same-namespace call-site scan for .go, .php, .java, .cs files without explicit import
    const explicitCallerSet = new Set(uniqueCallerFiles);
    for (const filePath of implicitPackageFiles) {
      if (explicitCallerSet.has(filePath)) continue;
      try {
        const fullPath = options.workspaceRoot ? resolve(options.workspaceRoot, filePath) : filePath;
        if (options.workspaceRoot) assertPathContained(fullPath, options.workspaceRoot, "Inbound caller source");
        if (probeSourcePath(fullPath) !== "file") continue;
        const content = readSourceFile(fullPath);
        if (!containerWordRegex.test(content)) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const lineNum = i + 1;
          const line = lines[i];
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("#") || trimmedLine.startsWith("*")) {
            continue;
          }
          let matched = false;
          if (targetMethod) {
            if (
              line.includes(`->${targetMethod}(`) ||
              line.includes(`::${targetMethod}(`) ||
              line.includes(`.${targetMethod}(`)
            ) {
              matched = true;
            }
          } else if (targetIsFunctionOnly) {
            if (fnCallRegex?.test(line) && !fnDeclRegex?.test(line)) {
              matched = true;
            }
          } else if (classUsageRegex?.test(line) && !/\b(?:class|interface|trait|enum|type|struct)\s+/.test(line)) {
            matched = true;
          }

          if (matched) {
            const enclosing = findEnclosingSymbol(filePath, lineNum);
            const callerName = enclosing ? enclosing.name : `${filePath}:${lineNum}`;
            const key = `${filePath}:${lineNum}:${callerName}`;
            if (!callersMap.has(key)) {
              callersMap.set(key, {
                file: filePath,
                caller: callerName,
                line: lineNum,
                kind: "call",
                domain: domainByFile.get(filePath),
              });
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    const inboundCallers = Array.from(callersMap.values());
    const affectedFiles = new Set(inboundCallers.map((c) => c.file));
    const distinctDomains = new Set(
      inboundCallers.map((c) => c.domain).filter(Boolean)
    );

    let riskLevel: "low" | "medium" | "high" = "low";
    if (affectedFiles.size > 5 || distinctDomains.size > 2) {
      riskLevel = "high";
    } else if (affectedFiles.size >= 2 || distinctDomains.size >= 2) {
      riskLevel = "medium";
    }

    // 5. Determine if symbol exists in index
    const foundInIndex = targetSymRows.length > 0 || depRows.length > 0;
    const warning = foundInIndex
      ? undefined
      : `Symbol '${trimmed}' was not found in Septum index (neither in declared symbols nor tracked dependencies). Risk cannot be assessed without index evidence.`;

    return {
      target_symbol: trimmed,
      found_in_index: foundInIndex,
      warning,
      impact_summary: {
        total_dependents: affectedFiles.size,
        risk_level: foundInIndex ? riskLevel : "unknown",
        affected_files_count: affectedFiles.size,
      },
      inbound_callers: inboundCallers,
    };
}
