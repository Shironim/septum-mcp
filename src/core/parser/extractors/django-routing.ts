import type Parser from "web-tree-sitter";
import { readPythonStaticString as literal } from "../static-string.ts";
import {
  pythonCallArgument, pythonCallUsesUnpacking, pythonImportedMember, pythonImportedName, pythonImports,
  type PythonImport,
} from "./python-route-ast.ts";

type Node = Parser.SyntaxNode;
export type DjangoViewTarget = { symbol: string; module?: string; line?: number };
type PathEntry = { kind: "path"; pattern: string; target: DjangoViewTarget; name?: string; line: number;
  actionMap?: Map<string, string>; dispatch: "function" | "class" };
type RouterEntry = { kind: "router"; pattern: string; target: DjangoViewTarget; line: number };
type Inclusion = { kind: "include"; pattern: string | undefined; module: string };
export type DjangoUrlEntry = PathEntry | RouterEntry | Inclusion;

function children(node?: Node | null): Node[] {
  return node?.namedChildren.filter(child => child.type !== "comment") ?? [];
}

function viewActions(node: Node): Map<string, string> | undefined {
  if (node.type !== "dictionary") return undefined;
  const map = new Map<string, string>();
  for (const item of children(node)) {
    const method = literal(item.childForFieldName("key"));
    const action = literal(item.childForFieldName("value"));
    if (!method || !action) return undefined;
    map.set(method.toUpperCase(), action);
  }
  return map;
}

export function readDjangoUrlconf(root: Node, signal?: AbortSignal): DjangoUrlEntry[] {
  const imports = new Map<string, PythonImport>();
  const routers = new Map<string, RouterEntry[]>();
  const patterns = new Map<string, DjangoUrlEntry[]>();
  const declarations = new Map<string, DjangoViewTarget>();
  const bound = new Set<string>();
  const forget = (name: string) => {
    bound.add(name);
    imports.delete(name);
    routers.delete(name);
    patterns.delete(name);
    declarations.delete(name);
  };
  const callee = (name: string): string => pythonImportedName(name, imports) ?? (bound.has(name) ? "" : name);
  const viewTarget = (node?: Node | null): DjangoViewTarget | undefined => {
    if (!node || !["identifier", "attribute"].includes(node.type)) return undefined;
    return pythonImportedMember(node.text, imports) ?? declarations.get(node.text);
  };

  const read = (node?: Node | null): DjangoUrlEntry[] | undefined => {
    if (!node || node.hasError) return undefined;
    if (node.type === "identifier") return patterns.get(node.text);
    if (node.type === "list" || node.type === "tuple") return children(node).flatMap(item => read(item) ?? []);
    if (node.type === "list_splat" || node.type === "parenthesized_expression") return read(children(node)[0]);
    if (node.type === "binary_operator" && node.childForFieldName("operator")?.text === "+") {
      const left = read(node.childForFieldName("left"));
      const right = read(node.childForFieldName("right"));
      return left || right ? [...(left ?? []), ...(right ?? [])] : undefined;
    }
    if (node.type === "attribute" && node.childForFieldName("attribute")?.text === "urls") {
      const object = node.childForFieldName("object");
      if (object?.type === "list_splat") return routers.get(children(object)[0]?.text ?? "")?.slice();
      return routers.get(object?.text ?? "")?.slice();
    }
    if (node.type !== "call" || pythonCallUsesUnpacking(node)) return undefined;
    const callName = callee(node.childForFieldName("function")?.text ?? "");
    if (!/^(?:django\.urls(?:\.conf)?\.)?(?:path|re_path)$/.test(callName)) return undefined;

    const pattern = literal(pythonCallArgument(node, "route", 0));
    const view = pythonCallArgument(node, "view", 1);
    if (!view) return undefined;
    const fn = view.childForFieldName("function");
    if (view.type === "call" && /^(?:django\.urls(?:\.conf)?\.)?include$/.test(callee(fn?.text ?? ""))) {
      const arg = pythonCallArgument(view, "arg", 0);
      const tuple = arg?.type === "tuple" ? children(arg) : [];
      const included = tuple.length === 2 && literal(tuple[1]) !== undefined ? tuple[0] : arg;
      const module = literal(included) ?? (included ? pythonImportedName(included.text, imports) : undefined);
      if (module) return [{ kind: "include", pattern, module }];
      const nested = read(included);
      return nested?.flatMap((entry): DjangoUrlEntry[] => {
        if (entry.kind === "include") {
          return [{ ...entry, pattern: pattern === undefined || entry.pattern === undefined ? undefined : pattern + entry.pattern }];
        }
        return pattern === undefined ? [] : [{ ...entry, pattern: pattern + entry.pattern }];
      });
    }
    if (pattern === undefined) return undefined;

    const asView = view.type === "call" && fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "as_view";
    const target = viewTarget(asView ? fn.childForFieldName("object") : view);
    if (!target) return undefined;
    const mapping = asView ? pythonCallArgument(view, "actions", 0) : undefined;
    const actionMap = mapping ? viewActions(mapping) : undefined;
    if (mapping && !actionMap) return undefined;
    return [{
      kind: "path", pattern, target, name: literal(pythonCallArgument(node, "name", 3)),
      line: node.startPosition.row + 1, actionMap, dispatch: asView ? "class" : "function",
    }];
  };

  for (const stmt of root.namedChildren) {
    signal?.throwIfAborted();
    for (const [name, binding] of pythonImports(stmt)) {
      forget(name);
      imports.set(name, binding);
    }
    const definition = stmt.type === "decorated_definition" ? stmt.childForFieldName("definition") : stmt;
    if (definition?.type === "function_definition" || definition?.type === "class_definition") {
      const name = definition.childForFieldName("name")?.text;
      if (name) {
        forget(name);
        declarations.set(name, { symbol: name, line: definition.startPosition.row + 1 });
      }
    }

    const node = stmt.type === "expression_statement" ? stmt.namedChild(0) : null;
    if (node?.type === "assignment") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      const alias = imports.get(right.text);
      const inherited = routers.get(right.text);
      const declaration = declarations.get(right.text);
      const values = read(right);
      const constructor = right.type === "call" ? callee(right.childForFieldName("function")?.text ?? "") : "";
      forget(left.text);
      if (alias) imports.set(left.text, alias);
      if (inherited) routers.set(left.text, inherited);
      if (declaration) declarations.set(left.text, declaration);
      if (values) patterns.set(left.text, values);
      if (/^(?:rest_framework\.routers\.)?(?:SimpleRouter|DefaultRouter)$/.test(constructor)) routers.set(left.text, []);
    } else if (node?.type === "augmented_assignment" && node.childForFieldName("operator")?.text === "+=") {
      const values = patterns.get(node.childForFieldName("left")?.text ?? "");
      const added = read(node.childForFieldName("right"));
      if (values && added) for (const entry of added.slice()) values.push(entry);
    } else if (node?.type === "call" && !pythonCallUsesUnpacking(node)) {
      const fn = node.childForFieldName("function");
      if (fn?.type !== "attribute") continue;
      const receiver = fn.childForFieldName("object")?.text ?? "";
      const method = fn.childForFieldName("attribute")?.text;
      if (method === "register") {
        const router = routers.get(receiver);
        const pattern = literal(pythonCallArgument(node, "prefix", 0));
        const target = viewTarget(pythonCallArgument(node, "viewset", 1));
        if (router && pattern !== undefined && target) {
          router.push({ kind: "router", pattern, target, line: node.startPosition.row + 1 });
        }
      } else if (method === "append" || method === "extend") {
        const values = patterns.get(receiver);
        const added = read(pythonCallArgument(node, "", 0));
        if (values && added) for (const entry of added.slice()) values.push(entry);
      }
    }
  }
  return patterns.get("urlpatterns") ?? [];
}
