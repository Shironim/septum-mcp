import * as path from "node:path";
import type Parser from "web-tree-sitter";

type Node = Parser.SyntaxNode;
export type GoImports = Map<string, string>;
export type GoType = { owner: string; name: string };
type Framework = "http" | "gin" | "echo" | "chi" | "fiber";

const frameworkImports: Array<[RegExp, Framework]> = [
  [/^net\/http$/, "http"],
  [/^github\.com\/gin-gonic\/gin$/, "gin"],
  [/^github\.com\/labstack\/echo(?:\/v\d+)?$/, "echo"],
  [/^github\.com\/go-chi\/chi(?:\/v\d+)?$/, "chi"],
  [/^github\.com\/gofiber\/fiber(?:\/v\d+)?$/, "fiber"],
];
const routerTypes: Record<Framework, string[]> = {
  http: ["ServeMux"], gin: ["Engine", "RouterGroup", "IRouter"],
  echo: ["Echo", "Group"], chi: ["Mux", "Router"], fiber: ["App", "Group", "Router"],
};
const constructors: Record<Framework, string[]> = {
  http: ["NewServeMux"], gin: ["New", "Default"], echo: ["New"], chi: ["NewRouter", "NewMux"], fiber: ["New"],
};
const verbs = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "CONNECT", "TRACE", "ANY"]);

function frameworkFor(importPath: string | undefined) {
  return frameworkImports.find(([pattern]) => importPath && pattern.test(importPath))?.[1];
}

function children(node: Node | null | undefined): Node[] {
  return node?.namedChildren.filter(child => child.type !== "comment") ?? [];
}

function literal(node: Node | null | undefined): string | undefined {
  if (!node || node.hasError) return undefined;
  const text = node.text.slice(1, -1);
  if (node.type === "raw_string_literal") return text.replace(/\r/g, "");
  // Route bytes requiring Go-specific escapes stay unresolved.
  if (node.type === "interpreted_string_literal" && !text.includes("\\")) return text;
  return undefined;
}

export function goImports(root: Node): GoImports {
  const imports: GoImports = new Map();
  for (const declaration of children(root).filter(node => node.type === "import_declaration")) {
    for (const spec of declaration.descendantsOfType("import_spec")) {
      const target = literal(spec.childForFieldName("path"));
      if (!target) continue;
      const name = spec.childForFieldName("name")?.text ?? path.basename(target.replace(/\/v\d+$/, ""));
      if (name !== "_" && name !== ".") imports.set(name, target);
    }
  }
  return imports;
}

export function goType(node: Node | null, imports: GoImports, owner: string, localPackage: (target: string) => string | undefined): GoType | undefined {
  if (node?.type === "pointer_type") node = node.namedChild(0);
  if (node?.type === "type_identifier") return { owner, name: node.text };
  if (node?.type !== "qualified_type") return undefined;
  const target = imports.get(node.childForFieldName("package")?.text ?? "");
  const name = node.childForFieldName("name")?.text;
  return target && name ? { owner: localPackage(target) ?? target, name } : undefined;
}

export function goKey(owner: string, name: string): string {
  return `${owner}\0${name}`;
}

type Mount = { router: Router; prefix: string };
type Router = { framework: Framework; mounts: Mount[]; dynamicMount?: boolean };
type Handler = { name: string; key?: string; receiver?: string; line?: number };
type Binding = { type?: GoType; router?: Router; handler?: Handler };
class Scope extends Map<string, Binding> {
  private readonly declared = new Set<string>();

  constructor(private readonly parent?: Scope) {
    super(parent);
  }

  declare(name: string, value: Binding): void {
    this.declared.add(name);
    this.set(name, value);
  }

  assign(name: string, value: Binding): void {
    if (!this.declared.has(name) && this.parent?.has(name)) {
      // An assignment in a nested/conditional scope can change the outer value.
      // Without control-flow analysis, keep later outer uses unresolved.
      this.parent.assign(name, {});
    }
    this.set(name, value);
  }

  shortDeclare(name: string, value: Binding): void {
    if (this.declared.has(name)) this.assign(name, value);
    else this.declare(name, value);
  }
}
type FunctionInfo = { parameters: Binding[]; result?: GoType };
export type GoRoute = { router: Router; uri: string; method: string; handler: Handler; line: number };

function routerFor(type: GoType | undefined): Router | undefined {
  const framework = frameworkFor(type?.owner);
  return framework && type && routerTypes[framework].includes(type.name) ? { framework, mounts: [] } : undefined;
}

function joinUri(prefix: string, suffix: string): string {
  return prefix.replace(/\/$/, "") + (suffix && !suffix.startsWith("/") ? "/" : "") + suffix;
}

export class GoRouting {
  readonly functions = new Map<string, FunctionInfo>();
  readonly fields = new Map<string, Map<string, GoType>>();

  constructor(private readonly localPackage: (target: string) => string | undefined) {}

  readType(node: Node | null, imports: GoImports, owner: string) {
    return goType(node, imports, owner, this.localPackage);
  }

  registerFunction(key: string, declaration: Node, imports: GoImports, owner: string) {
    const parameters = this.parameters(declaration.childForFieldName("parameters"), imports, owner).map(entry => entry[1]);
    if (this.functions.has(key)) {
      // Build alternatives with the same name have no unique declaration.
      this.functions.set(key, { parameters: [] });
    } else {
      const result = this.readType(declaration.childForFieldName("result"), imports, owner);
      this.functions.set(key, { parameters, result });
    }
  }

  private parameters(list: Node | null, imports: GoImports, owner: string): Array<[string, Binding]> {
    return children(list).flatMap(param => {
      const type = this.readType(param.childForFieldName("type"), imports, owner);
      const names = param.childrenForFieldName("name");
      return (names.length ? names : [null]).map((name): [string, Binding] =>
        [name?.text ?? "", { type, router: routerFor(type) }]);
    });
  }

  collect(root: Node, imports: GoImports, owner: string, signal?: AbortSignal): GoRoute[] {
    const routes: GoRoute[] = [];
    const fieldBindings = new Map<string, Binding>();
    const field = (type: GoType, name: string): Binding => {
      const typeKey = goKey(type.owner, type.name);
      const key = goKey(typeKey, name);
      let binding = fieldBindings.get(key);
      if (!binding) {
        const fieldType = this.fields.get(typeKey)?.get(name);
        binding = fieldType
          ? { type: fieldType, router: routerFor(fieldType) }
          : { handler: { name, key: goKey(type.owner, `${type.name}.${name}`), receiver: type.name } };
        fieldBindings.set(key, binding);
      }
      return binding;
    };
    const selector = (node: Node | null, scope: Scope) => {
      if (node?.type !== "selector_expression") return undefined;
      const receiver = node.childForFieldName("operand");
      const name = node.childForFieldName("field")?.text;
      if (!receiver || !name) return undefined;
      const target = receiver.type === "identifier" && !scope.has(receiver.text) ? imports.get(receiver.text) : undefined;
      return { receiver, name, target };
    };
    const functionKey = (node: Node | null, scope: Scope): string | undefined => {
      if (node?.type === "identifier" && !scope.has(node.text)) return goKey(owner, node.text);
      const member = selector(node, scope);
      const imported = member?.target && this.localPackage(member.target);
      return imported && member ? goKey(imported, member.name) : undefined;
    };
    const value = (node: Node | null | undefined, scope: Scope): Binding => {
      if (!node || node.hasError) return {};
      if (node.type === "identifier") {
        return scope.get(node.text) ?? { handler: { name: node.text, key: goKey(owner, node.text) } };
      }
      if (node.type === "func_literal") return { handler: { name: "closure", line: node.startPosition.row + 1 } };
      if (node.type === "parenthesized_expression") return value(node.namedChild(0), scope);
      if (node.type === "unary_expression" && node.childForFieldName("operator")?.text === "&") {
        return value(node.childForFieldName("operand"), scope);
      }
      if (node.type === "composite_literal") {
        const type = this.readType(node.childForFieldName("type"), imports, owner);
        return { type, router: routerFor(type) };
      }
      const member = selector(node, scope);
      if (member) {
        if (member.target === "net/http" && member.name === "DefaultServeMux") {
          return { router: defaultMux };
        }
        const key = functionKey(node, scope);
        if (key) return { handler: { name: member.name, key } };
        const receiver = value(member.receiver, scope);
        return receiver.type ? field(receiver.type, member.name) : {};
      }
      if (node.type !== "call_expression") return {};
      const callee = node.childForFieldName("function");
      const call = selector(callee, scope);
      const args = children(node.childForFieldName("arguments"));
      const framework = frameworkFor(call?.target);
      if (call && framework && constructors[framework].includes(call.name)) return { router: { framework, mounts: [] } };
      if (call?.target === "net/http" && call.name === "HandlerFunc") return value(args[0], scope);
      if (callee?.text === "new" && !scope.has("new")) {
        const type = this.readType(args[0] ?? null, imports, owner);
        return { type, router: routerFor(type) };
      }
      if (call) {
        const router = value(call.receiver, scope).router;
        if (router?.framework === "chi" && call.name === "With") return { router };
        if (router && ["gin", "echo", "fiber"].includes(router.framework) && call.name === "Group") {
          const prefix = literal(args[0]);
          return { router: { framework: router.framework, mounts: prefix === undefined ? [] : [{ router, prefix }],
            dynamicMount: prefix === undefined } };
        }
      }
      const key = functionKey(callee, scope);
      const type = key ? this.functions.get(key)?.result : undefined;
      return { type, router: routerFor(type) };
    };

    const defaultMux: Router = { framework: "http", mounts: [] };
    const visit = (node: Node, scope: Scope, depth = 0): void => {
      signal?.throwIfAborted();
      if (depth > 128 || node.type === "ERROR" || node.type === "func_literal") return;
      if (node.type === "block" || /^(?:if|for|expression_switch|type_switch|select)_statement$/.test(node.type) ||
          node.type.endsWith("_case")) scope = new Scope(scope);
      if (node.type === "short_var_declaration" || node.type === "var_spec" || node.type === "assignment_statement") {
        const names = node.type === "var_spec" ? node.childrenForFieldName("name") : children(node.childForFieldName("left"));
        const expressions = children(node.childForFieldName(node.type === "var_spec" ? "value" : "right"));
        const type = this.readType(node.childForFieldName("type"), imports, owner);
        const bindings = names.map((_, index) => expressions.length === names.length ? value(expressions[index], scope) : {});
        names.forEach((name, index) => {
          if (name.type !== "identifier") return;
          const binding = bindings[index]!;
          const resolved = type ? { ...binding, type, router: binding.router ?? routerFor(type) } : binding;
          if (node.type === "assignment_statement") scope.assign(name.text, resolved);
          else if (node.type === "short_var_declaration") scope.shortDeclare(name.text, resolved);
          else scope.declare(name.text, resolved);
        });
        return;
      }
      if (node.type === "call_expression" && !node.hasError) {
        const callee = node.childForFieldName("function");
        const args = children(node.childForFieldName("arguments"));
        const call = selector(callee, scope);
        const key = functionKey(callee, scope);
        if (key && this.functions.has(key)) {
          this.functions.get(key)!.parameters.forEach(({ router }, index) => {
            const parent = value(args[index], scope).router;
            if (router && parent && router !== parent && router.framework === parent.framework) {
              router.mounts.push({ router: parent, prefix: "" });
            }
          });
        }
        if (call) {
          const router = call.target === "net/http" ? defaultMux : value(call.receiver, scope).router;
          const prefix = literal(args[0]);
          if (router && call.name === "Mount" && ["chi", "fiber"].includes(router.framework)) {
            const child = value(args[1], scope).router;
            if (child && child !== router) {
              if (prefix === undefined) child.dynamicMount = true;
              else child.mounts.push({ router, prefix });
            }
          }
          if (router?.framework === "chi" && (call.name === "Route" || call.name === "Group")) {
            const callback = args[call.name === "Route" ? 1 : 0];
            const body = callback?.type === "func_literal" ? callback.childForFieldName("body") : null;
            const mountPrefix = call.name === "Route" ? prefix : "";
            if (body && callback) {
              const inner = new Scope(scope);
              const params = this.parameters(callback.childForFieldName("parameters"), imports, owner);
              for (const [name, binding] of params) if (name) inner.declare(name, binding);
              const child = params[0]?.[1].router;
              if (child?.framework === "chi") {
                if (mountPrefix === undefined) child.dynamicMount = true;
                else child.mounts.push({ router, prefix: mountPrefix });
                for (const statement of children(body)) visit(statement, inner, depth + 1);
              }
            }
          }
          if (router && prefix !== undefined) {
            const netHttp = router.framework === "http";
            const method = call.name.toUpperCase();
            if (netHttp ? ["HandleFunc", "Handle"].includes(call.name) : verbs.has(method)) {
              const pattern = netHttp ? /^(?:([A-Z]+)\s+)?(\/\S*)$/.exec(prefix.trim()) : null;
              const handlerNode = args[netHttp ? 1 : args.length - 1];
              if ((!netHttp || pattern) && handlerNode) {
                const binding = value(handlerNode, scope);
                const serveHttp = netHttp && call.name === "Handle" && binding.type
                  ? field(binding.type, "ServeHTTP").handler : undefined;
                const handler = binding.handler ?? serveHttp ?? { name: "unresolved_handler" };
                routes.push({ router, method: netHttp ? (pattern?.[1] ?? "ANY") : method,
                  uri: pattern?.[2] ?? prefix, handler, line: node.startPosition.row + 1 });
              }
            }
          }
        }
      }
      for (const child of children(node)) visit(child, scope, depth + 1);
    };

    const global = new Scope();
    for (const node of children(root)) {
      if (node.type === "var_declaration") visit(node, global);
    }
    for (const node of children(root)) {
      if (!["function_declaration", "method_declaration"].includes(node.type)) continue;
      const body = node.childForFieldName("body");
      const params = node.childForFieldName("parameters");
      if (!body || !params) continue;
      const local = new Scope(global);
      const fn = this.functions.get(goKey(owner, node.childForFieldName("name")?.text ?? ""));
      const parameters = this.parameters(params, imports, owner);
      for (const [index, [name, binding]] of parameters.entries()) {
        if (name) local.declare(name, node.type === "function_declaration" ? fn?.parameters[index] ?? binding : binding);
      }
      for (const [name, binding] of this.parameters(node.childForFieldName("receiver"), imports, owner)) {
        if (name) local.declare(name, binding);
      }
      for (const statement of children(body)) visit(statement, local);
    }
    return routes;
  }
}

export function goRouteUris(route: GoRoute): string[] {
  const uris = new Set<string>();
  const ancestry = new Set<Router>();
  let budget = 2048;
  const expand = (router: Router, suffix: string): void => {
    if (ancestry.has(router) || ancestry.size >= 32 || budget <= 0) return;
    budget--;
    if (!router.mounts.length) {
      if (!router.dynamicMount) uris.add(joinUri("", suffix) || "/");
      return;
    }
    ancestry.add(router);
    for (const mount of router.mounts) {
      if (budget <= 0) break;
      expand(mount.router, joinUri(mount.prefix, suffix));
    }
    ancestry.delete(router);
  };
  expand(route.router, route.uri);
  return [...uris];
}
