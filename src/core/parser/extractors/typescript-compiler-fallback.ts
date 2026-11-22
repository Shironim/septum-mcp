import ts from "typescript";
import type {
  ExtractedDependency,
  ExtractedSymbol,
  ParsedFileAST,
  SymbolKind,
  Visibility,
} from "../../../types/index.ts";

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx") || lower.endsWith(".js")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function memberVisibility(node: ts.Node, name: string): Visibility {
  if (name.startsWith("#")) return "private";
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return "private";
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)) return "protected";
  return "public";
}

function nodeLineRange(source: ts.SourceFile, node: ts.Node): { start: number; end: number; count: number } {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = Math.max(start, source.getLineAndCharacterOfPosition(node.end).line + 1);
  return { start, end, count: Math.max(1, end - start + 1) };
}

function headerText(source: ts.SourceFile, node: ts.Node, body?: ts.Node): string {
  const start = node.getStart(source);
  const end = body ? body.getStart(source) : node.end;
  return source.text.slice(start, end).trim().replace(/;$/, "");
}

function extractBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) {
      out.push(...extractBindingNames(el.name));
    }
  }
  return out;
}

/**
 * Fallback AST extractor backed by the official TypeScript compiler parser.
 * Used when tree-sitter-wasms reports syntax_recovery on valid modern TS/TSX syntax.
 * Returns null if the TypeScript compiler also reports syntactic errors.
 */
export function extractWithTypeScriptCompiler(filePath: string, content: string): ParsedFileAST | null {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath));
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === filePath ? source : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === filePath,
    readFile: (name) => (name === filePath ? content : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
    [filePath],
    { allowJs: true, noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve },
    host
  );
  if (program.getSyntacticDiagnostics(source).length > 0) {
    return null;
  }

  const lines = content.split("\n");
  const dependencies: ExtractedDependency[] = [];
  const symbols: ExtractedSymbol[] = [];

  const collectDependencies = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = node.moduleSpecifier.text.trim();
      if (target) {
        const imported = new Set<string>();
        const clause = node.importClause;
        if (clause?.name) imported.add(clause.name.text);
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            imported.add(clause.namedBindings.name.text);
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              imported.add((el.propertyName ?? el.name).text);
              imported.add(el.name.text);
            }
          }
        }
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        dependencies.push({
          target,
          statement: (lines[line - 1] ?? node.getText(source)).trim(),
          line_number: line,
          is_external: !target.startsWith(".") && !target.startsWith("/"),
          ...(imported.size > 0 ? { imported_symbols: Array.from(imported) } : {}),
        });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = node.moduleSpecifier.text.trim();
      if (target) {
        const exported = new Set<string>();
        if (node.exportClause) {
          if (ts.isNamespaceExport(node.exportClause)) {
            exported.add(node.exportClause.name.text);
          } else if (ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              exported.add((el.propertyName ?? el.name).text);
              exported.add(el.name.text);
            }
          }
        }
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        dependencies.push({
          target,
          statement: (lines[line - 1] ?? node.getText(source)).trim(),
          line_number: line,
          is_external: !target.startsWith(".") && !target.startsWith("/"),
          ...(exported.size > 0 ? { imported_symbols: Array.from(exported) } : {}),
        });
      }
    } else if (ts.isCallExpression(node)) {
      const isReqOrDynImport =
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isReqOrDynImport && node.arguments.length > 0) {
        const arg = node.arguments[0]!;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (ts.isStringLiteralLike(arg) && arg.text.trim()) {
          const target = arg.text.trim();
          dependencies.push({
            target,
            statement: (lines[line - 1] ?? node.getText(source)).trim(),
            line_number: line,
            is_external: !target.startsWith(".") && !target.startsWith("/"),
          });
        } else {
          dependencies.push({
            target: `dynamic:${node.getText(source)}`,
            statement: node.getText(source),
            line_number: line,
            is_external: false,
          });
        }
      }
    }
    ts.forEachChild(node, collectDependencies);
  };

  const extractClassMembers = (className: string, members: ts.NodeArray<ts.ClassElement | ts.TypeElement>): void => {
    for (const member of members) {
      const range = nodeLineRange(source, member);
      if (ts.isConstructorDeclaration(member)) {
        for (const param of member.parameters) {
          const mods = ts.canHaveModifiers(param) ? ts.getModifiers(param) : undefined;
          if (!mods?.some((m) =>
            m.kind === ts.SyntaxKind.PublicKeyword ||
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword ||
            m.kind === ts.SyntaxKind.ReadonlyKeyword
          )) {
            continue;
          }
          if (ts.isIdentifier(param.name)) {
            const pName = param.name.text;
            const vis = memberVisibility(param, pName);
            const pRange = nodeLineRange(source, param);
            const typeStr = param.type ? `: ${param.type.getText(source)}` : "";
            symbols.push({
              name: `${className}::${pName}`,
              kind: "property",
              signature: `${vis} ${pName}${typeStr}`,
              visibility: vis,
              line_start: pRange.start,
              line_end: pRange.end,
              line_count: pRange.count,
            });
          }
        }
        const paramsText = `(${member.parameters.map((p) => p.getText(source)).join(", ")})`;
        symbols.push({
          name: `${className}::constructor`,
          kind: "method",
          signature: `public constructor${paramsText}`,
          visibility: "public",
          line_start: range.start,
          line_end: range.end,
          line_count: range.count,
        });
        continue;
      }

      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        const mName = member.name ? (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source)) : undefined;
        if (!mName) continue;
        const vis = memberVisibility(member, mName);
        const paramsText = `(${member.parameters.map((p) => p.getText(source)).join(", ")})`;
        const retText = member.type ? `: ${member.type.getText(source)}` : "";
        symbols.push({
          name: `${className}::${mName}`,
          kind: "method",
          signature: `${vis} ${mName}${paramsText}${retText}`,
          visibility: vis,
          line_start: range.start,
          line_end: range.end,
          line_count: range.count,
        });
      } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
        const pName = member.name ? (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source)) : undefined;
        if (!pName) continue;
        const vis = memberVisibility(member, pName);
        const typeStr = member.type ? `: ${member.type.getText(source)}` : "";
        symbols.push({
          name: `${className}::${pName}`,
          kind: "property",
          signature: `${vis} ${pName}${typeStr}`,
          visibility: vis,
          line_start: range.start,
          line_end: range.end,
          line_count: range.count,
        });
      }
    }
  };

  const processStatement = (stmt: ts.Statement, namespacePrefix = ""): void => {
    const range = nodeLineRange(source, stmt);
    const prefix = (name: string) => (namespacePrefix ? `${namespacePrefix}::${name}` : name);

    if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name) && stmt.body && ts.isModuleBlock(stmt.body)) {
      const nextPrefix = prefix(stmt.name.text);
      for (const child of stmt.body.statements) {
        processStatement(child, nextPrefix);
      }
      return;
    }

    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.propertyName) {
          symbols.push({
            name: prefix(el.name.text),
            kind: "constant",
            signature: `export { ${el.propertyName.text} as ${el.name.text} }`,
            visibility: "public",
            line_start: range.start,
            line_end: range.end,
            line_count: range.count,
          });
        }
      }
      return;
    }

    if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      const name = stmt.name?.text;
      if (!name) return;
      const fullName = prefix(name);
      const kind: SymbolKind = ts.isInterfaceDeclaration(stmt) ? "interface" : "class";
      const braceOpen = stmt.members.pos > 0 ? stmt.members[0] : undefined;
      symbols.push({
        name: fullName,
        kind,
        signature: headerText(source, stmt, braceOpen),
        visibility: "public",
        line_start: range.start,
        line_end: range.end,
        line_count: range.count,
      });
      extractClassMembers(fullName, stmt.members);
      return;
    }

    if (ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      const name = stmt.name.text;
      symbols.push({
        name: prefix(name),
        kind: ts.isEnumDeclaration(stmt) ? "enum" : "type",
        signature: headerText(source, stmt),
        visibility: "public",
        line_start: range.start,
        line_end: range.end,
        line_count: range.count,
      });
      return;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const fnName = stmt.name.text;
      const paramsText = `(${stmt.parameters.map((p) => p.getText(source)).join(", ")})`;
      const retText = stmt.type ? `: ${stmt.type.getText(source)}` : "";
      symbols.push({
        name: prefix(fnName),
        kind: "function",
        signature: `${fnName}${paramsText}${retText}`,
        visibility: "public",
        line_start: range.start,
        line_end: range.end,
        line_count: range.count,
      });
      return;
    }

    if (ts.isVariableStatement(stmt)) {
      const isExported = hasExportModifier(stmt);
      const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
      const declKeyword = isConst ? "const" : stmt.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      for (const decl of stmt.declarationList.declarations) {
        const dRange = nodeLineRange(source, decl);
        const startLine = stmt.declarationList.declarations.length === 1 ? range.start : dRange.start;
        if (!ts.isIdentifier(decl.name)) {
          for (const vName of extractBindingNames(decl.name)) {
            symbols.push({
              name: prefix(vName),
              kind: isConst ? "constant" : "variable",
              signature: `${declKeyword} ${vName}`,
              visibility: isExported ? "public" : "private",
              line_start: range.start,
              line_end: dRange.end,
              line_count: Math.max(1, dRange.end - range.start + 1),
            });
          }
          continue;
        }
        const varName = decl.name.text;
        const typeStr = decl.type ? `: ${decl.type.getText(source)}` : "";
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const fn = decl.initializer;
          const paramsText = `(${fn.parameters.map((p) => p.getText(source)).join(", ")})`;
          const retText = fn.type ? `: ${fn.type.getText(source)}` : typeStr;
          symbols.push({
            name: prefix(varName),
            kind: "function",
            signature: `${varName}${paramsText}${retText}`,
            visibility: isExported ? "public" : "private",
            line_start: Math.min(range.start, startLine),
            line_end: dRange.end,
            line_count: Math.max(1, dRange.end - Math.min(range.start, startLine) + 1),
          });
        } else {
          symbols.push({
            name: prefix(varName),
            kind: isConst ? "constant" : "variable",
            signature: `${declKeyword} ${varName}${typeStr}`,
            visibility: isExported ? "public" : "private",
            line_start: Math.min(range.start, startLine),
            line_end: dRange.end,
            line_count: Math.max(1, dRange.end - Math.min(range.start, startLine) + 1),
          });
        }
      }
    }
  };

  collectDependencies(source);
  for (const stmt of source.statements) {
    processStatement(stmt);
  }

  return {
    status: "parsed",
    extraction: { method: "fallback", coverage: "partial" },
    diagnostics: [],
    symbols,
    dependencies,
  };
}
