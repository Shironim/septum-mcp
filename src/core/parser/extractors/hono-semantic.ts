import * as path from "node:path";
import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import { hasPackageJsonDependency } from "./manifest-helpers.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";
import { lineOf, literal, TypeScriptBindings, visitRouteCalls } from "./typescript-bindings.ts";
import { routeContext } from "./typescript-route-context.ts";

const verbs = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const instanceMethods = new Set([...verbs, "on", "use", "route", "onError", "notFound", "mount"]);
type Receiver = { root: ts.NewExpression; base: string | undefined };
type Route = { method: string; uri: string; registration: ts.CallExpression; handlers: readonly ts.Expression[] };

function literals(expression?: ts.Expression): string[] {
  if (!expression) return [];
  const values = ts.isArrayLiteralExpression(expression) ? expression.elements.map(literal) : [literal(expression)];
  return values.every((value): value is string => value !== undefined) ? values : [];
}

function join(base: string, sub: string): string {
  if (sub === "/") return base;
  const separator = base.endsWith("/") ? "" : "/";
  return base + separator + (sub.startsWith("/") ? sub.slice(1) : sub);
}

export class HonoSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "hono";
  public readonly name = "Hono Router & Middleware Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "hono") return true;
    if (hasPackageJsonDependency(projectRoot, ["hono"])) return true;
    for (const entry of ["src/index.ts", "src/app.ts", "index.ts", "app.ts", "src/server.ts"]) {
      const file = path.join(projectRoot, entry);
      if (probeSourcePath(file) === "file" && /(?:from\s*|require\(\s*)['"]hono['"]/.test(readOptionalSourceFile(file))) {
        return true;
      }
    }
    return false;
  }

  public async extractSlices(
    projectRoot: string,
    domainId?: number,
    signal?: AbortSignal,
    inventory?: SourceInventory,
  ): Promise<VerticalSliceCandidate[]> {
    const root = path.resolve(projectRoot);
    const files = listSourceFiles(root, /\.[cm]?[jt]sx?$/, inventory).filter(file => !/\.d\.[cm]?ts$/.test(file));
    const bindings = new TypeScriptBindings(root, new Set(files), signal);
    const tables = new Map<ts.NewExpression, Route[]>();
    const mounted = new Set<ts.NewExpression>();
    const receivers = new Map<ts.Expression, Receiver | undefined>();
    const fileOf = (node: ts.Node) => path.relative(root, node.getSourceFile().fileName).replace(/\\/g, "/");
    const receiverOf = (expression: ts.Expression): Receiver | undefined => {
      const node = bindings.value(expression);
      if (!node) return undefined;
      if (receivers.has(node)) return receivers.get(node);
      receivers.set(node, undefined);
      let receiver: Receiver | undefined;
      if (ts.isNewExpression(node)) {
        const type = bindings.packageBinding(node.expression);
        if (type && /^(?:hono)(?:\/(?:quick|tiny))?$/.test(type.module) && type.name === "Hono") {
          tables.set(node, []);
          receiver = { root: node, base: "/" };
        }
      } else if (ts.isCallExpression(node) && !node.questionDotToken && ts.isPropertyAccessExpression(node.expression) &&
          !node.expression.questionDotToken) {
        const method = node.expression.name.text;
        const parent = receiverOf(node.expression.expression);
        if (parent && method === "basePath") {
          const sub = literal(node.arguments[0]);
          receiver = { root: parent.root, base: sub === undefined || parent.base === undefined ? undefined : join(parent.base, sub) };
        } else if (parent && instanceMethods.has(method)) receiver = parent;
      }
      receivers.set(node, receiver);
      return receiver;
    };

    bindings.visitModules(files, unit => visitRouteCalls(unit.source, call => {
      signal?.throwIfAborted();
      const member = call.expression;
      if (call.questionDotToken || !ts.isPropertyAccessExpression(member) || member.questionDotToken) return;
      const method = member.name.text;
      if (method !== "route" && method !== "on" && !verbs.has(method)) return;
      const receiver = receiverOf(member.expression);
      if (!receiver) return;
      const routes = tables.get(receiver.root)!;

      if (method === "route") {
        const sub = call.arguments[1] && receiverOf(call.arguments[1]);
        if (!sub || sub.root === receiver.root) return;
        mounted.add(sub.root);
        const mount = literal(call.arguments[0]);
        if (mount === undefined || receiver.base === undefined) return;
        const base = join(receiver.base, mount);
        for (const route of tables.get(sub.root) ?? []) {
          routes.push({ ...route, uri: join(base, route.uri) });
        }
        return;
      }
      if (receiver.base === undefined) return;
      const methods = method === "on" ? literals(call.arguments[0]).map(value => value.toUpperCase().replace(/^ALL$/, "ANY")) :
        [method === "all" ? "ANY" : method.toUpperCase()];
      const paths = method === "on" ? literals(call.arguments[1]) : [literal(call.arguments[0])];
      const handlers = call.arguments.slice(method === "on" ? 2 : 1);
      if (!handlers.length) return;
      for (const m of new Set(methods)) {
        if (!/^[A-Z][A-Z0-9-]*$/.test(m)) continue;
        for (const localPath of new Set(paths)) {
          if (localPath !== undefined) routes.push({ method: m, uri: join(receiver.base, localPath), registration: call, handlers });
        }
      }
    }));

    const slices: VerticalSliceCandidate[] = [];
    for (const [instance, routes] of tables) {
      if (mounted.has(instance)) continue;
      for (const route of routes) {
        signal?.throwIfAborted();
        const routeFile = fileOf(route.registration);
        const routeLine = lineOf(route.registration);
        const target = route.handlers.at(-1)!;
        const handler = bindings.handler(target);
        const action = handler ? (handler.name === "callback" ? "closure" : handler.name) : target.getText();
        const controllerFile = handler ? fileOf(handler.node) : null;
        const controllerLine = handler ? lineOf(handler.node) : 0;
        const controller = path.basename(controllerFile ?? routeFile).replace(/\.[^.]+$/, "");
        const chain: ExecutionChainNode[] = [{
          stage: "ingress", symbol: route.method + " " + route.uri, file: routeFile, line: routeLine,
          description: "Hono Route Registration",
        }];
        for (const mw of route.handlers.slice(0, -1)) {
          const validator = ts.isCallExpression(mw) ? bindings.packageBinding(mw.expression) : undefined;
          if (validator && ["@hono/zod-validator", "@hono/valibot-validator", "hono/validator"].includes(validator.module) &&
              ts.isCallExpression(mw) && mw.arguments[1]) {
            const schema = mw.arguments[1];
            const declaration = bindings.definition(schema) ?? schema;
            chain.push({
              stage: "validation", symbol: schema.getText(), file: fileOf(declaration), line: lineOf(declaration),
              description: "Hono Validator Argument",
            });
          }
          chain.push({
            stage: "middleware", symbol: mw.getText(), file: fileOf(mw), line: lineOf(mw),
            description: "Hono Middleware Argument",
          });
        }
        if (handler && controllerFile) {
          chain.push({
            stage: "controller", symbol: action, file: controllerFile, line: controllerLine,
            description: "Hono Action Handler",
          }, ...routeContext(handler, bindings, fileOf));
        }
        slices.push({
          domain_id: domainId ?? null, feature_key: `hono.${controller.toLowerCase()}.${action}`,
          http_method: route.method, route_uri: route.uri, route_name: `${controller}.${action}`,
          controller_class: controller, action_name: action, controller_file: controllerFile,
          controller_line: controllerLine, architecture_style: "mvc", entry_kind: "http_route",
          execution_chain_json: JSON.stringify(chain),
        });
      }
    }
    return slices;
  }
}
