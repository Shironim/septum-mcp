import type Parser from "web-tree-sitter";
import type { ImportResolver } from "../../resolver/import-resolver.ts";
import { readPythonStaticString } from "../static-string.ts";

type Node = Parser.SyntaxNode;
export type PythonImport = { module: string; symbol?: string; qualifiedRoot?: string };

export function pythonImports(statement: Node): Array<[string, PythonImport]> {
  const from = statement.type === "import_from_statement";
  if (!from && statement.type !== "import_statement") return [];
  const source = statement.childForFieldName("module_name");
  return statement.namedChildren.flatMap((child): Array<[string, PythonImport]> => {
    if (child.id === source?.id) return [];
    const name = child.type === "aliased_import" ? child.childForFieldName("name") : child;
    if (name?.type !== "dotted_name") return [];
    const alias = child.childForFieldName("alias")?.text;
    if (from && source) return [[alias ?? name.text, { module: source.text, symbol: name.text }]];
    const head = name.text.split(".")[0]!;
    return [[alias ?? head, { module: name.text, qualifiedRoot: alias ? undefined : name.text }]];
  });
}

export function pythonImportMember(module: string, symbol: string): string {
  return module.endsWith(".") ? module + symbol : module + "." + symbol;
}

export function pythonCallArgument(call: Node, name: string, position?: number): Node | undefined {
  const args = call.childForFieldName("arguments")?.namedChildren.filter(child => child.type !== "comment") ?? [];
  const keyword = args.find(child => child.type === "keyword_argument" && child.childForFieldName("name")?.text === name);
  if (keyword) return keyword.childForFieldName("value") ?? undefined;
  const argument = position === undefined ? undefined : args[position];
  if (!argument || ["keyword_argument", "list_splat", "dictionary_splat"].includes(argument.type)) return undefined;
  return argument;
}

/** Resolve the imported spelling of a dotted identifier. Calls provide no binding evidence. */
export function pythonImportedName(name: string, imports: ReadonlyMap<string, PythonImport>): string | undefined {
  const [head, ...tail] = name.split(".");
  const binding = imports.get(head!);
  if (!binding) return undefined;
  if (binding.qualifiedRoot) {
    return name === binding.qualifiedRoot || name.startsWith(binding.qualifiedRoot + ".") ? name : undefined;
  }
  const module = binding.symbol ? pythonImportMember(binding.module, binding.symbol) : binding.module;
  return [module, ...tail].join(".");
}

export function pythonCallUsesUnpacking(call: Node): boolean {
  return call.childForFieldName("arguments")?.namedChildren.some(
    child => child.type === "list_splat" || child.type === "dictionary_splat",
  ) ?? false;
}

export function pythonLiteralMethods(methods: Node): string[] | undefined {
  if (!["list", "tuple", "set"].includes(methods.type)) return undefined;
  const values = methods.namedChildren.filter(child => child.type !== "comment").map(readPythonStaticString);
  if (!values.every((value): value is string => value !== undefined && /^[a-z]+$/i.test(value))) return undefined;
  return [...new Set(values.map(value => value.toUpperCase()))];
}

export type PythonRouterTarget = { key: string } | { module: string; symbol: string };
type RouterNames = Map<string, string>;

export function pythonImportedMember(
  expression: string,
  imports: ReadonlyMap<string, PythonImport>,
): { module: string; symbol: string } | undefined {
  const binding = imports.get(expression);
  if (binding?.symbol) return { module: binding.module, symbol: binding.symbol };
  const imported = pythonImportedName(expression, imports);
  const split = imported?.lastIndexOf(".") ?? -1;
  if (imported && split > 0) return { module: imported.slice(0, split), symbol: imported.slice(split + 1) };
  return undefined;
}

export function resolvePythonRouterTarget(
  target: PythonRouterTarget,
  source: string,
  resolver: ImportResolver,
  exportedRouters: ReadonlyMap<string, RouterNames>,
): string | undefined {
  if ("key" in target) return target.key;
  const module = resolver.resolve(target.module, source);
  if (module.status !== "resolved") return undefined;
  const candidates = module.targets.flatMap(item => item.files)
    .map(file => exportedRouters.get(file)?.get(target.symbol)).filter((key): key is string => !!key);
  return candidates.length === 1 ? candidates[0] : undefined;
}

type RouterCall = {
  key: string;
  receiver: string;
  method: string;
  call: Node;
  line: number;
};

interface PythonRouteVisitor {
  constructorCall: (key: string, name: string, constructor: string, call: Node) => boolean;
  routerCall: (call: RouterCall, targets: {
    router: (expression: string) => PythonRouterTarget | undefined;
    function: (expression: string) => Node | undefined;
  }) => void;
  decorator: (call: RouterCall, handler: Node) => void;
}

export function visitPythonRouterModule(root: Node, file: string, visitor: PythonRouteVisitor, signal?: AbortSignal) {
  const imports = new Map<string, PythonImport>();
  const routers: RouterNames = new Map();
  const functions = new Map<string, Node>();
  const bound = new Set<string>();
  const unbind = (name: string) => {
    bound.add(name);
    routers.delete(name);
    functions.delete(name);
    imports.delete(name);
  };

  const routerTarget = (expression: string): PythonRouterTarget | undefined => {
    const local = routers.get(expression);
    if (local) return { key: local };
    return pythonImportedMember(expression, imports);
  };

  const callOnRouter = (call: Node | null, line: number): RouterCall | undefined => {
    if (call?.type !== "call" || call.hasError) return undefined;
    const attr = call.childForFieldName("function");
    if (attr?.type !== "attribute") return undefined;
    const receiver = attr.childForFieldName("object")?.text ?? "";
    const key = routers.get(receiver);
    const method = attr.childForFieldName("attribute")?.text;
    if (key && method) return { key, receiver, method, call, line };
    return undefined;
  };

  for (const statement of root.namedChildren) {
    signal?.throwIfAborted();
    for (const [name, binding] of pythonImports(statement)) {
      unbind(name);
      imports.set(name, binding);
    }

    const expression = statement.type === "expression_statement" ? statement.namedChild(0) : null;
    if (expression?.type === "assignment") {
      const left = expression.childForFieldName("left");
      const right = expression.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      const router = routers.get(right.text);
      const handler = functions.get(right.text);
      const importAlias = imports.get(right.text);
      const callee = right.childForFieldName("function")?.text ?? "";
      const constructor = pythonImportedName(callee, imports) ?? (!callee.includes(".") && !bound.has(callee) ? callee : "");
      unbind(left.text);
      if (router) routers.set(left.text, router);
      if (handler) functions.set(left.text, handler);
      if (importAlias) imports.set(left.text, importAlias);
      if (right.type !== "call" || right.hasError || !constructor) continue;
      const key = file + "#" + left.text + "@" + left.startIndex;
      if (visitor.constructorCall(key, left.text, constructor, right)) routers.set(left.text, key);
    }

    if (expression?.type === "call") {
      const registration = callOnRouter(expression, expression.startPosition.row + 1);
      if (registration) visitor.routerCall(registration, { router: routerTarget, function: name => functions.get(name) });
    }

    const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
    if (definition?.type !== "function_definition" && definition?.type !== "class_definition") continue;
    const name = definition.childForFieldName("name")?.text;
    if (!name) continue;
    if (definition.type === "function_definition" && !definition.hasError) {
      for (const decorator of statement.namedChildren.filter(child => child.type === "decorator")) {
        const registration = callOnRouter(decorator.namedChild(0), decorator.startPosition.row + 1);
        if (registration) visitor.decorator(registration, definition);
      }
      unbind(name);
      functions.set(name, definition);
    } else unbind(name);
  }
  return { imports, routers };
}

export interface UnwrappedPythonView {
  node: Node;
  methods?: string[];
}

function isAsViewCall(node: Node): boolean {
  if (node.type !== "call") return false;
  const fn = node.childForFieldName("function");
  return fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "as_view";
}

function decoratorMethodConstraint(
  fnNode: Node | null,
  callee: (name: string) => string,
): string[] | undefined {
  if (!fnNode) return undefined;
  if (fnNode.type === "call") {
    const innerName = callee(fnNode.childForFieldName("function")?.text ?? "");
    if (/^(?:django\.views\.decorators\.http\.)?require_http_methods$/.test(innerName)) {
      const arg = pythonCallArgument(fnNode, "request_method_list", 0);
      return arg ? pythonLiteralMethods(arg) : undefined;
    }
    return undefined;
  }
  const qualified = callee(fnNode.text);
  if (/^(?:django\.views\.decorators\.http\.)?require_GET$/.test(qualified)) return ["GET"];
  if (/^(?:django\.views\.decorators\.http\.)?require_POST$/.test(qualified)) return ["POST"];
  if (/^(?:django\.views\.decorators\.http\.)?require_safe$/.test(qualified)) return ["GET", "HEAD"];
  return undefined;
}

/**
 * Unwraps decorator/middleware wrapper calls (e.g. `csrf_exempt(View.as_view(...))`,
 * `login_required(fn)`, `cache_page(60)(View.as_view(...))`) to the underlying view expression.
 */
export function unwrapPythonCallWrapper(
  viewNode: Node,
  callee: (name: string) => string = (name) => name,
): UnwrappedPythonView {
  let current = viewNode;
  let methods: string[] | undefined;

  for (let depth = 0; depth < 8; depth++) {
    if (current.type === "parenthesized_expression") {
      const inner = current.namedChildren.find((c) => c.type !== "comment");
      if (!inner) break;
      current = inner;
      continue;
    }
    if (current.type !== "call" || isAsViewCall(current) || pythonCallUsesUnpacking(current)) {
      break;
    }
    const args = current.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "comment") ?? [];
    if (args.length !== 1) break;
    const innerArg = args[0]!;
    if (!["identifier", "attribute", "call", "parenthesized_expression"].includes(innerArg.type)) {
      break;
    }
    const constraint = decoratorMethodConstraint(current.childForFieldName("function"), callee);
    if (constraint) {
      methods = methods ? methods.filter((m) => constraint.includes(m)) : constraint;
    }
    current = innerArg;
  }

  return { node: current, methods };
}
