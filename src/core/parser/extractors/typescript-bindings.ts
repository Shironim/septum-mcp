import * as path from "node:path";
import ts from "typescript";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import { bindContextFile } from "../../retrieval/typescript-references.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";

export type Handler = { node: ts.FunctionLikeDeclaration; name: string };
type Unit = ReturnType<typeof bindContextFile>;
type PackageBinding = { module: string; name: string };

export function nodes(node: ts.Node, stopAtFunctions = false): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    found.push(child);
    if (!stopAtFunctions || !ts.isFunctionLike(child)) ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

export function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
  return node;
}

export function nameText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

export function literal(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

export function visitRouteCalls(
  container: ts.SourceFile | ts.Block | ts.Expression,
  visit: (call: ts.CallExpression) => void,
): void {
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isConditionalExpression(node)) return;
    ts.forEachChild(node, walk);
    if (ts.isCallExpression(node)) visit(node);
  };
  if (ts.isSourceFile(container) || ts.isBlock(container)) {
    for (const statement of container.statements) {
      if (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement) || ts.isExportAssignment(statement) ||
          ts.isReturnStatement(statement)) walk(statement);
    }
  } else walk(container);
}

export function objectMember(
  node: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | ts.MethodDeclaration | undefined {
  for (const property of [...node.properties].reverse()) {
    // An unknown later assignment may override this property.
    if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) return undefined;
    if (nameText(property.name) !== key) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    if (ts.isMethodDeclaration(property)) return property;
    return undefined;
  }
  return undefined;
}

function importTarget(node: ts.Node): string | undefined {
  for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
      return parent.moduleSpecifier && nameText(parent.moduleSpecifier);
    }
  }
  return undefined;
}

export class TypeScriptBindings {
  private readonly indexed = new Map<string, Unit | undefined>();
  private readonly resolver: ImportResolver;

  constructor(private readonly root: string, private readonly files: ReadonlySet<string>, private readonly signal?: AbortSignal) {
    this.resolver = new ImportResolver(root);
  }

  load(file: string): Unit | undefined {
    this.signal?.throwIfAborted();
    if (!this.files.has(file)) return undefined;
    if (!this.indexed.has(file)) {
      const text = readOptionalSourceFile(file, "utf-8");
      const unit = text ? bindContextFile(file, text) : undefined;
      this.indexed.set(file, unit?.hasErrors ? undefined : unit);
    }
    return this.indexed.get(file);
  }

  declaration(name: ts.Node): ts.Declaration | undefined {
    const unit = this.load(name.getSourceFile().fileName);
    const symbol = ts.isShorthandPropertyAssignment(name.parent) && name.parent.name === name
      ? unit?.checker.getShorthandAssignmentValueSymbol(name.parent) : unit?.checker.getSymbolAtLocation(name);
    return symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined;
  }

  sdk(name: ts.Node | undefined, expected: string, packageName = "@modelcontextprotocol/sdk"): boolean {
    if (!name) return false;
    const declaration = this.declaration(name);
    const target = declaration && importTarget(declaration);
    return Boolean(declaration && ts.isImportSpecifier(declaration) && !declaration.isTypeOnly &&
      !declaration.parent.parent.isTypeOnly && (declaration.propertyName ?? declaration.name).text === expected &&
      (target === packageName || target?.startsWith(packageName + "/")));
  }

  initializer(node: ts.Declaration | undefined): ts.Expression | undefined {
    if (!node || !ts.isVariableDeclaration(node) || !ts.isVariableDeclarationList(node.parent) ||
        !(node.parent.flags & ts.NodeFlags.Const)) return undefined;
    return node.initializer;
  }

  private module(spec: string, from: ts.Node): Unit | undefined {
    const result = this.resolver.resolve(spec, from.getSourceFile().fileName);
    if (result.status !== "resolved") return undefined;
    const matches = result.targets.flatMap(target => target.files);
    return matches.length === 1 ? this.load(path.resolve(this.root, matches[0]!)) : undefined;
  }

  visitModules(files: readonly string[], visit: (unit: Unit) => void): void {
    const visited = new Set<string>();
    const evaluate = (unit: Unit) => {
      this.signal?.throwIfAborted();
      if (visited.has(unit.source.fileName)) return;
      visited.add(unit.source.fileName);
      for (const stmt of unit.source.statements) {
        if (!(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt))) continue;
        if (ts.isImportDeclaration(stmt) ? stmt.importClause?.isTypeOnly : stmt.isTypeOnly) continue;
        const spec = nameText(stmt.moduleSpecifier);
        const dependency = spec && this.module(spec, stmt);
        if (dependency) evaluate(dependency);
      }
      visit(unit);
    };
    for (const file of files) {
      const unit = this.load(file);
      if (unit) evaluate(unit);
    }
  }

  definition(expression: ts.Expression, seen = new Set<ts.Node>()): ts.Declaration | undefined {
    const node = this.value(expression);
    if (!node || seen.has(node) || seen.size >= 24) return undefined;
    seen.add(node);
    if (ts.isNewExpression(node)) return this.definition(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const declaration = this.declaration(node);
      if (!declaration) return undefined;
      if ((ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly) ||
          (ts.isImportClause(declaration) && !declaration.isTypeOnly)) {
        const spec = importTarget(declaration);
        const target = spec && this.module(spec, declaration);
        const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default";
        return target ? this.exportDeclaration(target, name) : undefined;
      }
      return declaration;
    }
    return undefined;
  }

  private exported(unit: Unit, name: string, seen: Set<ts.Node>): Handler | undefined {
    return this.target(this.exportDeclaration(unit, name), seen);
  }

  private exportDeclaration(unit: Unit, name: string): ts.Declaration | undefined {
    const symbol = unit.checker.getSymbolAtLocation(unit.source);
    const exported = symbol && unit.checker.getExportsOfModule(symbol).find(item => item.name === name);
    return exported?.declarations?.length === 1 ? exported.declarations[0] : undefined;
  }

  value(expression: ts.Expression | undefined, seen = new Set<ts.Node>()): ts.Expression | undefined {
    if (!expression) return undefined;
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return this.declarationValue(this.declaration(node), seen) ?? node;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = this.declaration(node.expression);
      if (declaration && ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly) {
        const spec = importTarget(declaration);
        const unit = spec && this.module(spec, node);
        return (unit && this.declarationValue(this.exportDeclaration(unit, node.name.text), seen)) || node;
      }
    }
    return node;
  }

  private declarationValue(declaration: ts.Declaration | undefined, seen: Set<ts.Node>): ts.Expression | undefined {
    if (!declaration || seen.has(declaration) || seen.size >= 24) return undefined;
    seen.add(declaration);
    if (ts.isExportAssignment(declaration) && !declaration.isExportEquals) return this.value(declaration.expression, seen);
    if (ts.isExportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly) {
      const spec = importTarget(declaration);
      if (spec) {
        const target = this.module(spec, declaration);
        const imported = (declaration.propertyName ?? declaration.name).text;
        return target && this.declarationValue(this.exportDeclaration(target, imported), seen);
      }
      const unit = this.load(declaration.getSourceFile().fileName);
      const local = unit?.checker.getExportSpecifierLocalTargetSymbol(declaration)?.declarations;
      return local?.length === 1 ? this.declarationValue(local[0], seen) : undefined;
    }
    if ((ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly) ||
        (ts.isImportClause(declaration) && !declaration.isTypeOnly)) {
      const spec = importTarget(declaration);
      const target = spec && this.module(spec, declaration);
      const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default";
      return target ? this.declarationValue(this.exportDeclaration(target, name), seen) : undefined;
    }
    return this.value(this.initializer(declaration), seen);
  }

  packageBinding(expression: ts.Expression | undefined, seen = new Set<ts.Node>()): PackageBinding | undefined {
    const node = this.value(expression);
    if (!node || seen.has(node) || seen.size >= 24) return undefined;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node)) {
      const owner = this.packageBinding(node.expression, seen);
      if (owner?.name === "*" || owner?.name === "default") return { module: owner.module, name: node.name.text };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" &&
        !this.declaration(node.expression)) {
      const module = literal(node.arguments[0]);
      if (module) return { module, name: "default" };
    }
    if (!ts.isIdentifier(node)) return undefined;
    const declaration = this.declaration(node);
    if (!declaration) return undefined;
    const module = importTarget(declaration);
    if (!module) return undefined;
    if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly) {
      return { module, name: (declaration.propertyName ?? declaration.name).text };
    }
    if (ts.isImportClause(declaration) && !declaration.isTypeOnly) return { module, name: "default" };
    if (ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly) return { module, name: "*" };
    return undefined;
  }

  handler(expression: ts.Expression | undefined, seen = new Set<ts.Node>()): Handler | undefined {
    if (!expression) return undefined;
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return this.target(this.declaration(node), seen);
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return this.target(node, seen);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = this.declaration(node.expression);
      const moduleName = declaration && importTarget(declaration);
      if (declaration && ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly && moduleName) {
        const unit = this.module(moduleName, node);
        if (unit) return this.exported(unit, node.name.text, seen);
      }
    }
    return undefined;
  }

  private target(declaration: ts.Declaration | undefined, seen: Set<ts.Node>): Handler | undefined {
    if (!declaration || seen.has(declaration) || seen.size >= 24) return undefined;
    seen.add(declaration);
    if ((ts.isFunctionDeclaration(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && declaration.body) {
      const parentName = ts.isVariableDeclaration(declaration.parent) ? nameText(declaration.parent.name) : undefined;
      return { node: declaration, name: nameText(declaration.name) ?? parentName ?? "callback" };
    }
    if (ts.isExportAssignment(declaration) && !declaration.isExportEquals) {
      return this.handler(declaration.expression, seen);
    }
    if (ts.isExportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly) {
      const spec = importTarget(declaration);
      if (spec) {
        const unit = this.module(spec, declaration);
        return unit && this.exported(unit, (declaration.propertyName ?? declaration.name).text, seen);
      }
      const unit = this.load(declaration.getSourceFile().fileName);
      const local = unit?.checker.getExportSpecifierLocalTargetSymbol(declaration);
      return this.target(local?.declarations?.length === 1 ? local.declarations[0] : undefined, seen);
    }
    if ((ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly) ||
        (ts.isImportClause(declaration) && !declaration.isTypeOnly)) {
      const spec = importTarget(declaration);
      const unit = spec && this.module(spec, declaration);
      const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default";
      return unit ? this.exported(unit, name, seen) : undefined;
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && !declaration.dotDotDotToken &&
        !declaration.initializer && ts.isIdentifier(declaration.name)) {
      const owner = declaration.parent.parent;
      const init = ts.isVariableDeclaration(owner) && this.initializer(owner);
      const call = init && unwrap(init);
      if (call && ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = literal(call.arguments[0]);
        const unit = spec && this.module(spec, declaration);
        const name = nameText(declaration.propertyName ?? declaration.name);
        return unit && name ? this.exported(unit, name, seen) : undefined;
      }
    }
    return this.handler(this.initializer(declaration), seen);
  }
}
