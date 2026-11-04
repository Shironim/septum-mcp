import ts from "typescript";

/** Bind identifiers inside one verified file, without reading libraries or disk.
 * Import resolution remains owned by Septum's observed resolver.
 */
export function bindContextFile(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: name => name === path ? source : undefined,
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "",
    getDirectories: () => [], fileExists: name => name === path,
    readFile: name => name === path ? text : undefined, getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([path], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  function top(node: ts.Node): ts.Node {
    while (node.parent && node.parent !== source) node = node.parent;
    return node;
  }
  return {
    source,
    hasErrors: program.getSyntacticDiagnostics(source).length > 0,
    declaration(start: number, end: number) {
      return source.statements.find(node => source.getLineAndCharacterOfPosition(node.getStart()).line + 1 <= start &&
        source.getLineAndCharacterOfPosition(node.end).line + 1 >= end);
    },
    references(node: ts.Node) {
      const locals = new Set<ts.Node>();
      const imports = new Map<ts.ImportDeclaration, Set<string>>();
      const visit = (child: ts.Node) => {
        if (ts.isIdentifier(child)) {
          for (const decl of checker.getSymbolAtLocation(child)?.declarations ?? []) {
            const owner = top(decl);
            if (ts.isImportDeclaration(owner)) {
              const names = imports.get(owner) ?? new Set<string>();
              names.add(ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text :
                ts.isImportClause(decl) ? "default" : "*");
              imports.set(owner, names);
            } else if (owner !== node && source.statements.includes(owner as ts.Statement)) locals.add(owner);
          }
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
      return { locals: [...locals], imports };
    },
    exported(name: string) {
      return source.statements.find(node => {
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        if (!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return false;
        if (name === "default") return modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name);
        return "name" in node && (node as unknown as ts.NamedDeclaration).name?.getText(source) === name;
      });
    },
  };
}
