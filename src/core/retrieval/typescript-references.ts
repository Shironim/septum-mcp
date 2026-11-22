import ts from "typescript";

export type ContextValue = { kind: "unknown" | "undefined" } |
  { kind: "literal"; value: string | number | boolean | null } |
  { kind: "object"; properties: Record<string, ContextValue> };

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
  const program = ts.createProgram([path], { allowJs: true, noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker();
  function top(node: ts.Node): ts.Node {
    while (node.parent && node.parent !== source) node = node.parent;
    return node;
  }
  return {
    source,
    checker,
    hasErrors: program.getSyntacticDiagnostics(source).length > 0,
    declaration(start: number, end: number) {
      const stmt = source.statements.find(node => source.getLineAndCharacterOfPosition(node.getStart()).line + 1 <= start &&
        source.getLineAndCharacterOfPosition(node.end).line + 1 >= end);
      if (stmt && ts.isClassDeclaration(stmt)) {
        const member = stmt.members.find(m =>
          source.getLineAndCharacterOfPosition(m.getStart()).line + 1 <= start &&
          source.getLineAndCharacterOfPosition(m.end).line + 1 >= end
        );
        if (member) return member;
      }
      return stmt;
    },
    contract(node: ts.ClassDeclaration) {
      const printer = ts.createPrinter();
      const members: string[] = [];
      const signatures: ts.Node[] = [...(node.typeParameters ?? []), ...(node.heritageClauses ?? [])];
      let inferred = false;
      for (const member of node.members) {
        const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
        if (modifiers?.some(m => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.StaticKeyword].includes(m.kind))) continue;
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (!ts.isIdentifier(parameter.name) || !parameter.modifiers?.some(m => m.kind === ts.SyntaxKind.PublicKeyword || m.kind === ts.SyntaxKind.ReadonlyKeyword) ||
              parameter.modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
            if (parameter.type) signatures.push(parameter.type); else inferred = true;
            members.push(printer.printNode(ts.EmitHint.Unspecified, ts.factory.createPropertySignature(
              parameter.modifiers.filter(m => m.kind === ts.SyntaxKind.ReadonlyKeyword), parameter.name, parameter.questionToken,
              parameter.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)), source));
          }
        }
        if (!member.name || ts.isPrivateIdentifier(member.name) || ts.isComputedPropertyName(member.name)) continue;
        if (ts.isMethodDeclaration(member)) {
          signatures.push(...(member.typeParameters ?? []));
          const parameters = member.parameters.map(p => {
            if (p.type) signatures.push(p.type); else inferred = true;
            return ts.factory.updateParameterDeclaration(p, undefined, p.dotDotDotToken, p.name,
              p.questionToken ?? (p.initializer ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined),
              p.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword), undefined);
          });
          if (member.type) signatures.push(member.type); else inferred = true;
          const signature = ts.factory.createMethodSignature(undefined, member.name, member.questionToken,
            member.typeParameters, parameters, member.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
          members.push(printer.printNode(ts.EmitHint.Unspecified, signature, source));
        } else if (ts.isPropertyDeclaration(member)) {
          if (member.type) signatures.push(member.type); else inferred = true;
          members.push(printer.printNode(ts.EmitHint.Unspecified, ts.factory.createPropertySignature(
            modifiers?.filter(m => m.kind === ts.SyntaxKind.ReadonlyKeyword), member.name, member.questionToken,
            member.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)), source));
        } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          const type = ts.isGetAccessorDeclaration(member) ? member.type : member.parameters[0]?.type;
          if (type) signatures.push(type); else inferred = true;
          members.push(`${member.name.getText(source)}: ${type?.getText(source) ?? "unknown"};`);
        }
      }
      const heritage = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword);
      return { text: `interface ${node.name?.text ?? "Anonymous"}${node.typeParameters ? `<${node.typeParameters.map(p => p.getText(source)).join(", ")}>` : ""}${heritage ? ` ${heritage.getText(source)}` : ""} {\n${members.map(m => `  ${m}`).join("\n")}\n}`,
        signatures, inferred };
    },
    references(node: ts.Node, argumentFacts?: ContextValue[], signatureNodes?: ts.Node[]) {
      const locals = new Set<ts.Node>();
      const imports = new Map<ts.ImportDeclaration, Set<string>>();
      const calls: Array<{ target: ts.Node; name?: string; arguments: ContextValue[] }> = [];
      const escapes = new Set<ts.Node>();
      const facts = new Map<ts.Symbol, ContextValue>();
      const unknown: ContextValue = { kind: "unknown" };
      const absent: ContextValue = { kind: "undefined" };
      const fn = ts.isFunctionLike(node) ? node : ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
        ? node.declarationList.declarations[0]?.initializer : undefined;
      const evaluate = (expression: ts.Node, depth = 0): ContextValue => {
        if (depth > 8) return unknown;
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return evaluate(expression.expression, depth + 1);
        if (expression.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
        if (expression.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
        if (expression.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: null };
        if (ts.isStringLiteral(expression) && expression.text.length <= 256) return { kind: "literal", value: expression.text };
        if (ts.isNumericLiteral(expression)) return { kind: "literal", value: Number(expression.text) };
        if (ts.isIdentifier(expression)) {
          const symbol = checker.getSymbolAtLocation(expression);
          if (symbol && facts.has(symbol)) return facts.get(symbol)!;
          if (expression.text === "undefined" && !symbol?.declarations?.length) return absent;
          const declaration = symbol?.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
            ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
            // const protects the binding, not a mutable object shared with the caller.
            if (ts.isObjectLiteralExpression(declaration.initializer)) return unknown;
            return evaluate(declaration.initializer, depth + 1);
          }
          return unknown;
        }
        if (ts.isObjectLiteralExpression(expression)) {
          const properties: Record<string, ContextValue> = Object.create(null);
          if (expression.properties.length > 32) return unknown;
          for (const property of expression.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return unknown;
            if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return unknown;
            properties[property.name.text] = evaluate(ts.isPropertyAssignment(property) ? property.initializer : property.name, depth + 1);
          }
          return { kind: "object", properties };
        }
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
          const owner = evaluate(expression.expression, depth + 1);
          const key = ts.isPropertyAccessExpression(expression) ? expression.name.text :
            expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
          if (owner.kind === "object" && key !== undefined) return owner.properties[key] ?? absent;
          if (expression.questionDotToken && (owner.kind === "undefined" || owner.kind === "literal" && owner.value === null)) return absent;
        }
        if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
          const value = evaluate(expression.operand, depth + 1);
          if (value.kind !== "unknown") return { kind: "literal", value: value.kind === "undefined" || value.kind === "literal" && !value.value };
        }
        if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(expression.operatorToken.kind)) {
          const left = evaluate(expression.left, depth + 1), right = evaluate(expression.right, depth + 1);
          if ((left.kind === "literal" || left.kind === "undefined") && (right.kind === "literal" || right.kind === "undefined")) {
            const equal = (left.kind === "literal" ? left.value : undefined) === (right.kind === "literal" ? right.value : undefined);
            return { kind: "literal", value: expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal };
          }
        }
        return unknown;
      };
      if (fn && ts.isFunctionLike(fn)) fn.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) return;
        const symbol = checker.getSymbolAtLocation(parameter.name);
        let value = argumentFacts ? argumentFacts[index] ?? absent : unknown;
        if (value.kind === "undefined" && parameter.initializer) value = evaluate(parameter.initializer);
        if (symbol) facts.set(symbol, value);
      });
      const invalidate = (expression: ts.Node): void => {
        const tracked = new Set<ContextValue>([...facts.values()].filter(value => value.kind === "object"));
        const aliases = (value: ContextValue): boolean => tracked.has(value) ||
          value.kind === "object" && Object.values(value.properties).some(aliases);
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) || aliases(evaluate(expression)))
          for (const [key, value] of facts) if (value.kind === "object") facts.set(key, unknown);
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return invalidate(expression.expression);
        if (!ts.isIdentifier(expression)) return;
        const symbol = checker.getSymbolAtLocation(expression);
        if (symbol) facts.set(symbol, unknown);
      };
      const escapedClosures = new Set<ts.Node>();
      const escape = (expression: ts.Node, depth = 0): void => {
        if (depth > 64) {
          for (const [key, value] of facts) if (value.kind === "object") facts.set(key, unknown);
          return;
        }
        if (evaluate(expression).kind === "object") invalidate(expression);
        // A scalar property read does not expose the containing option object.
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return;
        if (ts.isIdentifier(expression)) {
          const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
          const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
          if (initializer && !escapedClosures.has(initializer) &&
            (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isFunctionDeclaration(initializer))) {
            escapedClosures.add(initializer);
            ts.forEachChild(initializer, child => escape(child, depth + 1));
          }
          return;
        }
        ts.forEachChild(expression, child => escape(child, depth + 1));
      };
      let prunedBranches = 0;
      const visit = (child: ts.Node) => {
        if (child !== node && child !== fn && ts.isFunctionLike(child)) {
          const saved = new Map(facts);
          facts.clear();
          ts.forEachChild(child, visit);
          facts.clear();
          for (const [key, value] of saved) facts.set(key, value);
          return;
        }
        if (!signatureNodes && (ts.isIfStatement(child) || ts.isConditionalExpression(child))) {
          const condition = ts.isIfStatement(child) ? child.expression : child.condition;
          const value = evaluate(condition);
          visit(condition);
          if (value.kind !== "unknown") {
            const truthy = value.kind === "object" || value.kind === "literal" && Boolean(value.value);
            const chosen = ts.isIfStatement(child) ? truthy ? child.thenStatement : child.elseStatement : truthy ? child.whenTrue : child.whenFalse;
            prunedBranches++;
            if (chosen) visit(chosen);
            return;
          }
        }
        if (!signatureNodes && ts.isCallExpression(child)) {
          const effectful = (arg: ts.Node): boolean => ts.isCallExpression(arg) || ts.isNewExpression(arg) ||
            ts.isAwaitExpression(arg) || ts.isDeleteExpression(arg) ||
            ts.isBinaryExpression(arg) && arg.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && arg.operatorToken.kind <= ts.SyntaxKind.LastAssignment ||
            ts.isPostfixUnaryExpression(arg) || ts.forEachChild(arg, n => effectful(n) || undefined) === true;
          const callArgs = () => child.arguments.length <= 16
            ? child.arguments.map(arg => child.arguments.some(effectful) ? unknown : evaluate(arg))
            : Array(16).fill(unknown);

          if (ts.isIdentifier(child.expression)) {
            for (const declaration of checker.getSymbolAtLocation(child.expression)?.declarations ?? []) {
              calls.push({ target: top(declaration),
                name: ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text :
                  ts.isImportClause(declaration) ? "default" : undefined,
                arguments: callArgs() });
            }
          } else if (
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
            ts.isClassDeclaration(node.parent)
          ) {
            const memberName = child.expression.name.text;
            const sibling = node.parent.members.find(
              (m) =>
                m !== node &&
                (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) &&
                m.name &&
                (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) &&
                m.name.text === memberName
            );
            if (sibling) {
              locals.add(sibling);
              calls.push({ target: sibling, arguments: callArgs() });
            }
          }
          ts.forEachChild(child, visit);
          // An unknown callee may mutate object arguments. Subsequent guards cannot reuse those facts.
          for (const arg of child.arguments) escape(arg);
          return;
        }
        if (!signatureNodes && ts.isNewExpression(child)) {
          ts.forEachChild(child, visit);
          for (const arg of child.arguments ?? []) escape(arg);
          return;
        }
        if (!signatureNodes && ts.isYieldExpression(child)) {
          if (child.expression) escape(child.expression);
          ts.forEachChild(child, visit);
          return;
        }
        if (!signatureNodes && ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) invalidate(child.left);
        if (!signatureNodes && ts.isDeleteExpression(child)) invalidate(child.expression);
        if (!signatureNodes && (ts.isPostfixUnaryExpression(child) || ts.isPrefixUnaryExpression(child)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(child.operator)) invalidate(child.operand);
        if (ts.isIdentifier(child)) {
          for (const decl of checker.getSymbolAtLocation(child)?.declarations ?? []) {
            const owner = top(decl);
            if (ts.isImportDeclaration(owner)) {
              if (!(ts.isCallExpression(child.parent) && child.parent.expression === child)) escapes.add(owner);
              const names = imports.get(owner) ?? new Set<string>();
              names.add(ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text :
                ts.isImportClause(decl) ? "default" : "*");
              imports.set(owner, names);
            } else if (owner !== node && !(owner.pos <= node.pos && owner.end >= node.end) && source.statements.includes(owner as ts.Statement)) {
              locals.add(owner);
              if (!(ts.isCallExpression(child.parent) && child.parent.expression === child)) escapes.add(owner);
            }
          }
        }
        ts.forEachChild(child, visit);
      };
      if (signatureNodes) signatureNodes.forEach(visit); else visit(node);
      return { locals: [...locals], imports, calls, escapes, prunedBranches };
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
