import ts from "typescript";
import { type Handler, literal, TypeScriptBindings, nameText, nodes, unwrap } from "./typescript-bindings.ts";

export type Registration = { name: string; node: ts.Node; handler?: Handler; bin?: string };

function returns(handler: Handler): Array<ts.Expression | undefined> {
  const body = handler.node.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  return nodes(body, true).filter(ts.isReturnStatement).map(node => node.expression);
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const matches = object.properties.filter(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
    nameText(item.name) === name);
  if (matches.length !== 1 || object.properties.some(item => ts.isSpreadAssignment(item) || item.name && ts.isComputedPropertyName(item.name))) {
    return undefined;
  }
  const item = matches[0]!;
  return ts.isPropertyAssignment(item) ? item.initializer : ts.isShorthandPropertyAssignment(item) ? item.name : undefined;
}

function constant(expression: ts.Expression | undefined, bindings: TypeScriptBindings, depth = 0): ts.Expression | undefined {
  if (!expression || depth > 16) return undefined;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return constant(bindings.initializer(bindings.declaration(node)), bindings, depth + 1);
  return node;
}

function unique(handlers: Array<Handler | undefined>): Handler | undefined {
  const first = handlers[0];
  return first && handlers.every(item => item?.node === first.node) ? first : undefined;
}

function endsCase(statement: ts.Statement | undefined): boolean {
  if (!statement) return false;
  if (ts.isBlock(statement)) return endsCase(statement.statements.at(-1));
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) && !statement.label;
}

class Dispatch {
  private readonly assignments = new Map<ts.Declaration, Array<ts.Expression | undefined>>();

  constructor(private readonly bindings: TypeScriptBindings, private readonly body: ts.Node | undefined, private readonly seeds: Map<ts.Declaration, string>) {
    if (!body) return;
    for (const node of nodes(body)) {
      if (!ts.isBinaryExpression(node) || !ts.isIdentifier(node.left) ||
          node.operatorToken.kind < ts.SyntaxKind.FirstAssignment || node.operatorToken.kind > ts.SyntaxKind.LastAssignment) continue;
      const declaration = bindings.declaration(node.left);
      if (!declaration) continue;
      const writes = this.assignments.get(declaration) ?? [];
      writes.push(node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined);
      this.assignments.set(declaration, writes);
    }
  }

  private origin(expression: ts.Expression | undefined, depth = 0): string | undefined {
    if (!expression || depth > 20) return undefined;
    const node = unwrap(expression);
    const from = (value: ts.Expression | undefined) => this.origin(value, depth + 1);
    if (ts.isIdentifier(node)) {
      if (node.text === "process" && !this.bindings.declaration(node)) return "process";
      const declaration = this.bindings.declaration(node);
      if (!declaration) return undefined;
      const seed = this.seeds.get(declaration);
      if (seed) return seed;
      const writes = this.assignments.get(declaration);
      if (ts.isVariableDeclaration(declaration)) {
        if (writes) return writes.length === 1 && !declaration.initializer && (writes[0]?.getStart() ?? Infinity) < node.getStart()
          ? from(writes[0]) : undefined;
        return from(declaration.initializer);
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && !declaration.initializer && !declaration.dotDotDotToken) {
        const field = nameText(declaration.propertyName ?? declaration.name);
        const owner = declaration.parent.parent;
        const parent = ts.isVariableDeclaration(owner) ? from(owner.initializer) : this.seeds.get(owner);
        if (parent && field && !writes) return parent + "." + field;
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = from(node.expression);
      const field = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isNumericLiteral(node.argumentExpression) || ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (base && field !== undefined) return base + "." + field;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "slice" &&
          from(node.expression.expression) === "process.argv" && node.arguments[0]?.getText() === "2") return "argv";
      if (this.bindings.sdk(node.expression, "parseArgs", "node:util") || this.bindings.sdk(node.expression, "parseArgs", "util")) {
        const options = node.arguments[0] && unwrap(node.arguments[0]);
        if (options && ts.isObjectLiteralExpression(options) && from(property(options, "args")) === "argv") return "cli";
      }
      if (from(node.arguments[0]) === "request.params.name") {
        const handler = this.bindings.handler(node.expression);
        const param = handler?.node.parameters[0];
        if (handler && param) {
          const values = returns(handler);
          // Support a local validation helper only when each return preserves its input name.
          if (values.length && values.every(value => {
            const object = value && unwrap(value);
            const name = object && ts.isObjectLiteralExpression(object) ? property(object, "name") : undefined;
            return name && ts.isIdentifier(name) && this.bindings.declaration(name) === param;
          })) return "validated";
        }
      }
    }
    return undefined;
  }

  cases(origins: string[], cli = false): Registration[] {
    const entries: Registration[] = [];
    const body = this.body;
    if (!body) return entries;
    const visited = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (visited.has(node) || visited.size > 24) return;
      visited.add(node);
      for (const child of nodes(node, true)) {
        if (ts.isSwitchStatement(child) && origins.includes(this.origin(child.expression) ?? "")) {
          let labels: Array<{ name: string; node: ts.CaseClause }> = [];
          const clauses = child.caseBlock.clauses;
          for (const [index, clause] of clauses.entries()) {
            if (!ts.isCaseClause(clause)) { labels = []; continue; }
            const name = literal(clause.expression);
            if (name) labels.push({ name, node: clause });
            if (!clause.statements.length) continue;
            const statements = nodes(clause, true);
            const values = statements.filter(ts.isReturnStatement).map(statement => statement.expression);
            if (cli) values.push(...statements.filter(ts.isExpressionStatement).map(statement => statement.expression));
            const handlers = values.flatMap(expression => {
              if (!expression) return cli ? [] : [undefined];
              const call = unwrap(expression);
              if (!ts.isCallExpression(call)) return cli ? [] : [undefined];
              return [this.bindings.handler(call.expression)];
            });
            const fallsThrough = index < clauses.length - 1 && !endsCase(clause.statements.at(-1));
            for (const label of labels) entries.push({ ...label, handler: fallsThrough ? undefined : unique(handlers) });
            labels = [];
          }
        } else if (ts.isCallExpression(child) && !cli) {
          const callee = child.expression;
          const callbacks = ts.isPropertyAccessExpression(callee) && callee.name.text === "runTool" ? child.arguments : [];
          for (const expression of [callee, ...callbacks]) {
            const handler = this.bindings.handler(expression);
            if (handler?.node.body && handler.node.getSourceFile() === node.getSourceFile() &&
                handler.node.pos >= body.pos && handler.node.end <= body.end) visit(handler.node.body);
          }
        }
      }
    };
    visit(body);
    return entries;
  }
}

function sdkServer(expression: ts.Expression, bindings: TypeScriptBindings, depth = 0): { node: ts.NewExpression; highLevel: boolean } | undefined {
  if (depth > 16) return undefined;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    const init = bindings.initializer(bindings.declaration(node));
    return init && sdkServer(init, bindings, depth + 1);
  }
  if (!ts.isNewExpression(node)) return undefined;
  if (bindings.sdk(node.expression, "McpServer")) return { node, highLevel: true };
  if (bindings.sdk(node.expression, "Server")) return { node, highLevel: false };
  return undefined;
}

/** Recognize a literal tool catalog projected directly by a tools/list handler. */
function projectedToolCatalog(expression: ts.Expression | undefined, bindings: TypeScriptBindings): Registration[] {
  if (!expression || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) ||
      expression.expression.name.text !== "map" || expression.arguments.length !== 1) return [];
  const projection = expression.arguments[0];
  if (!ts.isArrowFunction(projection) || !ts.isParenthesizedExpression(projection.body)) return [];
  const body = unwrap(projection.body);
  if (!ts.isObjectLiteralExpression(body) || !property(body, "name") || !property(body, "inputSchema")) return [];
  const array = bindings.value(expression.expression.expression);
  if (!array || !ts.isArrayLiteralExpression(array)) return [];
  return array.elements.flatMap(element => {
    if (!ts.isCallExpression(element) || !ts.isIdentifier(element.expression) ||
        element.expression.text !== "defineTool" || element.arguments.length !== 1) return [];
    const definition = element.arguments[0];
    if (!ts.isObjectLiteralExpression(definition)) return [];
    const name = literal(property(definition, "name"));
    if (!name || !property(definition, "schema") || !property(definition, "inputSchema")) return [];
    const execute = bindings.handler(property(definition, "execute"));
    const results = execute ? returns(execute) : [];
    const call = results.length === 1 ? results[0] : undefined;
    const handler = call && ts.isCallExpression(call) ? bindings.handler(call.expression) : undefined;
    return [{ name, node: definition, handler }];
  });
}

export function mcpRegistrations(source: ts.SourceFile, bindings: TypeScriptBindings): Registration[] {
  const lists = new Map<ts.NewExpression, Registration[]>();
  const dispatches = new Map<ts.NewExpression, Registration[]>();
  const direct: Registration[] = [];
  for (const node of nodes(source)) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) continue;
    const method = node.expression.name.text;
    if (!["registerTool", "tool", "setRequestHandler"].includes(method)) continue;
    const server = sdkServer(node.expression.expression, bindings);
    if (!server) continue;
    if (method !== "setRequestHandler") {
      if (!server.highLevel || node.arguments.length < (method === "registerTool" ? 3 : 2)) continue;
      const name = literal(constant(node.arguments[0], bindings));
      if (name) direct.push({ name, node, handler: bindings.handler(node.arguments.at(-1)) });
      continue;
    }
    if (server.highLevel) continue;
    const schema = node.arguments[0];
    const callback = bindings.handler(node.arguments[1]);
    if (!callback) continue;
    if (bindings.sdk(schema, "ListToolsRequestSchema")) {
      const entries = lists.get(server.node) ?? [];
      const results = returns(callback);
      if (results.length !== 1) continue;
      const object = constant(results[0], bindings);
      const array = object && ts.isObjectLiteralExpression(object) ? constant(property(object, "tools"), bindings) : undefined;
      if (!array || !ts.isArrayLiteralExpression(array)) {
        entries.push(...projectedToolCatalog(array, bindings));
        lists.set(server.node, entries);
        continue;
      }
      for (const element of array.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        const name = literal(constant(property(element, "name"), bindings));
        if (name) entries.push({ name, node: element });
      }
      lists.set(server.node, entries);
    } else if (bindings.sdk(schema, "CallToolRequestSchema")) {
      const param = callback.node.parameters[0];
      if (!param) continue;
      const dispatch = new Dispatch(bindings, callback.node.body, new Map([[param, "request"]]));
      const entries = dispatches.get(server.node) ?? [];
      entries.push(...dispatch.cases(["request.params.name", "validated.name"]));
      dispatches.set(server.node, entries);
    }
  }
  for (const [server, published] of lists) {
    const registered = dispatches.get(server) ?? [];
    for (const entry of published) direct.push({
      ...entry, handler: entry.handler ?? unique(registered.filter(item => item.name === entry.name).map(item => item.handler)),
    });
  }
  return direct;
}

export function cliRegistrations(source: ts.SourceFile, bin: string, bindings: TypeScriptBindings): Registration[] {
  const entries: Registration[] = [];
  const argv = (expr?: ts.Expression): boolean => Boolean(expr && ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "argv" && ts.isIdentifier(expr.expression) && expr.expression.text === "process" && !bindings.declaration(expr.expression));
  // A bin may dispatch directly or invoke a statically bound function with process.argv.
  const origins = ["process.argv.2", "argv.0", "cli.positionals.0"];
  entries.push(...new Dispatch(bindings, source, new Map()).cases(origins, true));
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = unwrap(statement.expression);
    if (!ts.isCallExpression(call)) continue;
    const handler = bindings.handler(call.expression);
    if (!handler) continue;
    const seeds = new Map<ts.Declaration, string>();
    handler.node.parameters.forEach((param, index) => { if (argv(call.arguments[index])) seeds.set(param, "process.argv"); });
    if (seeds.size) entries.push(...new Dispatch(bindings, handler.node.body, seeds).cases(origins, true));
  }
  return entries.map(entry => ({ ...entry, bin }));
}
