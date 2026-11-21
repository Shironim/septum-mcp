import type Parser from "web-tree-sitter";
import { children, importsFor, literal, phpSections } from "./php-ast-helpers.ts";

type Node = Parser.SyntaxNode;
type Controller = { controllerClass: string; controllerTarget?: string };
export type ParsedRoute = Controller & {
  httpMethod: string;
  uri: string;
  routeName?: string;
  actionName: string;
  line: number;
  handlerLine?: number;
  file?: string;
};

const facade = "illuminate\\support\\facades\\route";
const methods = new Set(["get", "post", "put", "patch", "delete", "any", "options", "head"]);
const groupModifiers = new Set(["prefix", "name", "as", "controller", "middleware", "domain", "where", "scopebindings", "withoutscopedbindings"]);
const resources = [
  ["GET", "", "index"], ["GET", "/create", "create"], ["POST", "", "store"],
  ["GET", "/{id}", "show"], ["GET", "/{id}/edit", "edit"],
  ["PUT", "/{id}", "update"], ["DELETE", "/{id}", "destroy"],
] as const;

type Call = { name: string; args: Array<Node | undefined>; line: number };

function routeCalls(expression: Node, isFacade: (name: string) => boolean): Call[] {
  const chain: Call[] = [];
  let node: Node | null = expression;
  while (node && !node.hasError && ["scoped_call_expression", "member_call_expression"].includes(node.type)) {
    const name: Node | null = node.childForFieldName("name");
    if (name?.type !== "name") break;
    const args = children(node.childForFieldName("arguments")).map(arg => {
      const values = children(arg);
      return arg.type === "argument" && values.length === 1 && values[0]?.type !== "variadic_unpacking" ? values[0] : undefined;
    });
    chain.push({ name: name.text.toLowerCase(), args, line: node.startPosition.row + 1 });
    if (node.type === "scoped_call_expression") {
      return isFacade(node.childForFieldName("scope")?.text ?? "") ? chain.reverse() : [];
    }
    node = node.childForFieldName("object");
  }
  return [];
}

function uriJoin(base: string, uri: string): string {
  return "/" + [base, uri].map(value => value.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function arrayOptions(node?: Node): Map<string, Node> | undefined {
  if (node?.type !== "array_creation_expression") return undefined;
  const options = new Map<string, Node>();
  for (const item of children(node)) {
    const [key, value] = children(item);
    const name = literal(key);
    if (item.type !== "array_element_initializer" || name === undefined || !value) return undefined;
    options.set(name.toLowerCase(), value);
  }
  return options;
}

function actionList(args: Array<Node | undefined>): string[] | undefined {
  const names = args.flatMap(arg => arg?.type === "array_creation_expression"
    ? children(arg).map(element => {
        const values = children(element);
        return values.length === 1 ? literal(values[0]) : undefined;
      })
    : [literal(arg)]);
  return names.every(name => name !== undefined) ? names : undefined;
}

type Group = { prefix: string; name: string; controller?: Controller };

export function readLaravelRoutes(root: Node, signal?: AbortSignal): ParsedRoute[] {
  const routes: ParsedRoute[] = [];
  for (const { namespace, statements } of phpSections(root)) {
    const imports = importsFor(statements);
    const localClasses = new Set(statements.filter(node => node.type === "class_declaration")
      .map(node => node.childForFieldName("name")?.text.toLowerCase()));
    const resolve = (name: string): string | undefined => {
      if (name.startsWith("\\")) return name.slice(1);
      const [head, ...tail] = name.split("\\");
      const key = head!.toLowerCase();
      if (imports.has(key)) {
        const imported = imports.get(key);
        return imported ? [imported, ...tail].join("\\") : undefined;
      }
      if (key === "namespace" && tail.length) return [namespace, ...tail].filter(Boolean).join("\\");
      return [namespace, name].filter(Boolean).join("\\");
    };
    const isFacade = (name: string) => {
      const target = resolve(name)?.toLowerCase();
      return target === facade || (target === "route" && !localClasses.has("route"));
    };
    const classTarget = (name: string): Controller | undefined => {
      if (!/^\\?(?:[a-z_]\w*\\)*[a-z_]\w*$/i.test(name)) return undefined;
      const target = resolve(name);
      // A global short name without an import still supports Laravel's conventional path.
      return { controllerClass: name, controllerTarget: target === name && !namespace && !name.includes("\\")
        && !imports.has(name.toLowerCase()) ? undefined : target ?? "" };
    };
    const controller = (node?: Node): Controller | undefined => {
      if (node?.type !== "class_constant_access_expression") return undefined;
      const [name, constant] = children(node);
      return constant?.text.toLowerCase() === "class" && name ? classTarget(name.text) : undefined;
    };
    const emit = (
      call: Call, group: Group, uri: string, httpMethod: string, target: Controller,
      actionName: string, routeName?: string, handlerLine?: number,
    ) => routes.push({ ...target, httpMethod, uri: uriJoin(group.prefix, uri), actionName,
      routeName: routeName === undefined ? undefined : group.name + routeName, line: call.line, handlerLine });

    const visit = (node: Node, group: Group, depth = 0): void => {
      signal?.throwIfAborted();
      if (depth > 128 || node.type === "ERROR") return;
      if (["if_statement", "else_clause", "else_if_clause", "compound_statement"].includes(node.type)) {
        for (const child of children(node)) visit(child, group, depth + 1);
        return;
      }
      const expression = node.type === "expression_statement" ? children(node)[0] : node.type === "arrow_function" ? node.childForFieldName("body") : null;
      if (!expression) return;
      const calls = routeCalls(expression, isFacade);
      const first = calls[0];
      if (!first) return;
      const groupCall = calls.at(-1)!;
      if (groupCall.name === "group") {
        const [options, callback] = groupCall.args;
        const closure = groupCall.args.length === 1 ? options : callback;
        const next = { ...group };
        const apply = (name: string, arg?: Node): boolean => {
          if (name === "namespace") return false;
          if (name === "prefix" || name === "name" || name === "as") {
            const text = literal(arg);
            if (text === undefined) return false;
            if (name === "prefix") next.prefix = uriJoin(next.prefix, text);
            else next.name += text;
          } else if (name === "controller") {
            next.controller = controller(arg) ?? (literal(arg) ? classTarget(literal(arg)!) : undefined);
            if (!next.controller) return false;
          }
          return true;
        };
        if (groupCall.args.length === 2) {
          const values = arrayOptions(options);
          if (!values || ![...values].every(([name, value]) => apply(name, value))) return;
        }
        if (!calls.slice(0, -1).every(call => groupModifiers.has(call.name) && apply(call.name, call.args[0]))) return;
        if (closure?.type === "anonymous_function_creation_expression") {
          const body = closure.childForFieldName("body");
          if (body) visit(body, next, depth + 1);
        } else if (closure?.type === "arrow_function") {
          visit(closure, next, depth + 1);
        }
        return;
      }

      const [uriNode, targetNode] = first.args;
      const uri = literal(uriNode);
      if (uri === undefined) return;
      if (first.name === "resource" || first.name === "apiresource") {
        const target = controller(targetNode) ?? (literal(targetNode) ? classTarget(literal(targetNode)!) : undefined);
        if (!target) return;
        const options = first.args.length > 2 ? arrayOptions(first.args[2]) : new Map<string, Node>();
        const modifiers = calls.slice(1);
        const unsupported = ["parameter", "parameters", "name", "names", "shallow", "scoped", "singleton"];
        if (!options || unsupported.some(key => options.has(key)) || modifiers.some(call => unsupported.includes(call.name))) return;
        const readFilter = (key: string) => {
          const modifier = modifiers.findLast(call => call.name === key);
          const option = options.get(key);
          if (modifier) return actionList(modifier.args) ?? null;
          if (option) return actionList([option]) ?? null;
          return undefined;
        };
        const only = readFilter("only");
        const except = readFilter("except");
        if (only === null || except === null) return;
        const actions = resources.filter(([, , action]) =>
          (first.name === "resource" || !["create", "edit"].includes(action)) &&
          (!only || only.includes(action)) && !except?.includes(action));
        for (const [method, suffix, action] of actions) {
          const base = uri.replace(/^\/+|\/+$/g, "");
          emit(first, group, base + suffix, method, target, action, base + "." + action);
        }
        return;
      }

      const name = literal(calls.findLast(call => call.name === "name")?.args[0]);
      const text = literal(targetNode);
      if (first.name === "view" && text !== undefined) {
        emit(first, group, uri, "GET", { controllerClass: "View" }, text, name);
        return;
      }
      if (!methods.has(first.name) || !targetNode) return;
      const array = targetNode.type === "array_creation_expression" ? children(targetNode) : [];
      const pair = array.map(item => children(item)).filter(items => items.length === 1);
      const legacy = text?.split("@");
      let target: Controller | undefined;
      let action: string | undefined;
      let handlerLine: number | undefined;
      if (array.length === 2 && pair.length === 2) {
        target = controller(pair[0]?.[0]);
        action = literal(pair[1]?.[0]);
      } else if (legacy?.length === 2) {
        target = classTarget(legacy[0]!);
        action = legacy[1];
      } else if (text !== undefined && group.controller) {
        target = group.controller;
        action = text;
      } else if (["anonymous_function_creation_expression", "arrow_function"].includes(targetNode.type)) {
        target = { controllerClass: "Closure" };
        action = "handle";
        handlerLine = targetNode.startPosition.row + 1;
      } else {
        target = controller(targetNode);
        action = "__invoke";
      }
      if (target && action && /^[a-z_]\w*$/i.test(action)) {
        emit(first, group, uri, first.name.toUpperCase(), target, action, name, handlerLine);
      }
    };
    for (const statement of statements) visit(statement, { prefix: "", name: "" });
  }
  return routes;
}

export type LaravelAction = { line: number; source: string; body: string };
export function readLaravelActions(root: Node): Map<string, Map<string, LaravelAction>> {
  const classes = new Map<string, Map<string, LaravelAction>>();
  for (const { namespace, statements } of phpSections(root)) {
    for (const node of statements) {
      if (node.type !== "class_declaration") continue;
      const className = node.childForFieldName("name")?.text;
      if (!className) continue;
      const methods = new Map<string, LaravelAction>();
      for (const member of children(node.childForFieldName("body"))) {
        if (member.type !== "method_declaration" || member.hasError) continue;
        const name = member.childForFieldName("name");
        const body = member.childForFieldName("body");
        if (name && body) methods.set(name.text.toLowerCase(), {
          line: member.startPosition.row + 1, source: member.text, body: body.text.slice(1, -1),
        });
      }
      classes.set([namespace, className].filter(Boolean).join("\\").toLowerCase(), methods);
    }
  }
  return classes;
}
