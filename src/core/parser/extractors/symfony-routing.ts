import type Parser from "web-tree-sitter";
import { children, importsFor, literal, phpSections } from "./php-ast-helpers.ts";

type Node = Parser.SyntaxNode;
type RouteAttribute = { path: string; name?: string; methods: string[] };
type ResolveClass = (name: string) => string | undefined;

const routeClasses = new Set([
  "symfony\\component\\routing\\attribute\\route",
  "symfony\\component\\routing\\annotation\\route",
]);

function routeAttributes(node: Node, resolveClass: ResolveClass): Node[] {
  return children(node.childForFieldName("attributes")).flatMap(group =>
    children(group).filter(attribute => {
      const name = children(attribute)[0];
      return attribute.type === "attribute" && !!name &&
        routeClasses.has(resolveClass(name.text)?.toLowerCase() ?? "");
    })
  );
}

function readAttribute(node: Node): RouteAttribute | undefined {
  if (node.hasError) return undefined;
  const fields = new Map<string, Node>();
  const positional = ["path", "name", "requirements", "options", "defaults", "host", "methods"];
  let position = 0;
  for (const arg of children(node.childForFieldName("parameters"))) {
    const label = arg.childForFieldName("name");
    const key = label?.text ?? positional[position++];
    const values = children(arg).slice(label ? 1 : 0);
    if (arg.type !== "argument" || values.length !== 1 || values[0]?.type === "variadic_unpacking") return undefined;
    if (key && fields.has(key)) return undefined;
    if (key) fields.set(key, values[0]!);
  }

  const pathNode = fields.get("path");
  const nameNode = fields.get("name");
  const path = !pathNode || pathNode.type === "null" ? "" : literal(pathNode);
  const name = literal(nameNode);
  if (path === undefined || (nameNode && nameNode.type !== "null" && name === undefined)) return undefined;

  const methodNode = fields.get("methods");
  const values = methodNode?.type === "array_creation_expression"
    ? children(methodNode).map(item => {
        const parts = children(item);
        return parts.length === 1 ? literal(parts[0]) : undefined;
      })
    : methodNode ? [literal(methodNode)] : [];
  if (!values.every((value): value is string => value !== undefined && /^[a-z][a-z-]*$/i.test(value))) return undefined;
  return { path, name, methods: values.map(value => value.toUpperCase()) };
}

export function visitSymfonyRoutes(
  root: Node,
  visit: (route: {
    uri: string;
    name?: string;
    methods: string[];
    className: string;
    action: Node;
    resolveClass: ResolveClass;
  }) => void,
  signal?: AbortSignal,
): void {
  for (const { namespace, statements } of phpSections(root)) {
    const imports = importsFor(statements);
    const resolveClass: ResolveClass = name => {
      if (name.startsWith("\\")) return name.slice(1);
      const [head, ...tail] = name.split("\\");
      const key = head!.toLowerCase();
      if (key === "namespace" && tail.length) return [namespace, ...tail].filter(Boolean).join("\\");
      if (!imports.has(key)) return [namespace, name].filter(Boolean).join("\\");
      const imported = imports.get(key);
      return imported ? [imported, ...tail].join("\\") : undefined;
    };

    for (const node of statements) {
      signal?.throwIfAborted();
      if (node.type !== "class_declaration" || children(node).some(child => child.type === "abstract_modifier")) continue;
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      const className = [namespace, name].filter(Boolean).join("\\");
      const classAttributes = routeAttributes(node, resolveClass);
      const methods = children(node.childForFieldName("body"))
        .filter(member => member.type === "method_declaration" && member.childForFieldName("body"))
        .map(action => ({ action, attributes: routeAttributes(action, resolveClass) }));

      const emit = (action: Node, attributes: Node[], prefix?: RouteAttribute) => {
        for (const attribute of attributes) {
          signal?.throwIfAborted();
          const route = readAttribute(attribute);
          if (!route) continue;
          const methods = [...new Set([...(prefix?.methods ?? []), ...route.methods])];
          const uri = "/" + [prefix?.path, route.path].filter(Boolean).join("").replace(/^\/+/, "");
          visit({
            uri, name: route.name === undefined ? undefined : (prefix?.name ?? "") + route.name,
            methods: methods.length ? methods : ["ANY"], className, action, resolveClass,
          });
        }
      };

      if (methods.some(method => method.attributes.length)) {
        const prefixAttribute = classAttributes[0];
        const prefix = prefixAttribute && readAttribute(prefixAttribute);
        if (prefixAttribute && !prefix) continue;
        for (const { action, attributes } of methods) emit(action, attributes, prefix);
      } else {
        const invokable = methods.find(({ action }) => action.childForFieldName("name")?.text.toLowerCase() === "__invoke");
        if (invokable) emit(invokable.action, classAttributes);
      }
    }
  }
}
