import * as path from "node:path";
import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import { hasPackageJsonDependency } from "./manifest-helpers.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";
import { lineOf, literal, objectMember, TypeScriptBindings, visitRouteCalls } from "./typescript-bindings.ts";
import { routeContext } from "./typescript-route-context.ts";

const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "options", "connect", "trace", "all"]);
const instanceMethods = new Set([
  ...verbs, "route", "use", "group", "guard", "decorate", "state", "derive", "resolve",
  "model", "onRequest", "onBeforeHandle", "onAfterHandle", "onError",
]);
type Expression = ts.Expression | ts.MethodDeclaration;
type Route = { method: string; uri: string; call: ts.CallExpression; handler: ts.Expression; schema?: Expression };
type Scope = { prefix: string | undefined; routes: Map<string, Route>; schema?: Expression };
type Frames = ReadonlyMap<ts.ParameterDeclaration, Scope>;

function leadingSlash(value: string): string {
  return value && !value.startsWith("/") ? "/" + value : value;
}

export class ElysiaSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "elysia";
  public readonly name = "Elysia TypeBox Composition Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "elysia") return true;
    if (hasPackageJsonDependency(projectRoot, ["elysia"])) return true;
    for (const entry of ["src/index.ts", "src/app.ts", "index.ts", "app.ts", "src/server.ts"]) {
      const file = path.join(projectRoot, entry);
      if (probeSourcePath(file) === "file" && /(?:from\s*|require\(\s*)['"]elysia['"]/.test(readOptionalSourceFile(file))) {
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
    const scopes = new Map<ts.NewExpression, Scope>();
    const mounted = new Set<Scope>();
    const active = new Set<ts.FunctionLikeDeclaration>();
    const fileOf = (node: ts.Node) => path.relative(root, node.getSourceFile().fileName).replace(/\\/g, "/");
    const object = (expression?: ts.Expression) => {
      const value = bindings.value(expression);
      return value && ts.isObjectLiteralExpression(value) ? value : undefined;
    };
    const schemaFor = (expression?: ts.Expression): Expression | undefined => {
      const opts = object(expression);
      if (!opts) return undefined;
      for (const field of ["body", "query", "params", "headers", "cookie", "response"]) {
        const value = objectMember(opts, field);
        if (value) return value;
      }
      return undefined;
    };

    const instanceOf = (expression: ts.Expression, frames: Frames): Scope | undefined => {
      const visited = new Set<ts.Node>();
      let value = bindings.value(expression);
      while (value && !visited.has(value)) {
        visited.add(value);
        if (ts.isIdentifier(value)) {
          const declared = bindings.declaration(value);
          return declared && ts.isParameter(declared) ? frames.get(declared) : undefined;
        }
        if (ts.isNewExpression(value)) {
          const existing = scopes.get(value);
          if (existing) return existing;
          const type = bindings.packageBinding(value.expression);
          if (type?.module !== "elysia" || type.name !== "Elysia" && type.name !== "default") return undefined;
          const opts = object(value.arguments?.[0]);
          const raw = opts && objectMember(opts, "prefix");
          const dynamic = value.arguments?.length && (!opts || opts.properties.some(property =>
            ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name),
          ));
          const prefix = raw && !ts.isMethodDeclaration(raw) ? literal(raw) : raw || dynamic ? undefined : "";
          const scope = { prefix: prefix === undefined ? undefined : leadingSlash(prefix), routes: new Map<string, Route>() };
          scopes.set(value, scope);
          return scope;
        }
        if (!ts.isCallExpression(value) || value.questionDotToken || !ts.isPropertyAccessExpression(value.expression) ||
            value.expression.questionDotToken || !instanceMethods.has(value.expression.name.text)) return undefined;
        value = bindings.value(value.expression.expression);
      }
      return undefined;
    };

    const put = (scope: Scope, route: Route) => scope.routes.set(route.method + "\0" + route.uri, route);
    const copyRoutes = (parent: Scope, child: Scope, subpath: string) => {
      if (parent.prefix === undefined || parent === child) return;
      for (const route of child.routes.values()) {
        signal?.throwIfAborted();
        put(parent, { ...route, uri: parent.prefix + leadingSlash(subpath + route.uri) });
      }
    };

    const visitCallback = (callback: ts.Expression | undefined, scope: Scope, frames: Frames) => {
      const handler = bindings.handler(callback)?.node;
      if (!handler?.body || !handler.parameters[0] || active.has(handler)) return;
      active.add(handler);
      try {
        const locals = new Map(frames).set(handler.parameters[0], scope);
        visitRouteCalls(handler.body, call => readCall(call, locals));
      } finally { active.delete(handler); }
    };

    const readCall = (call: ts.CallExpression, frames: Frames) => {
      signal?.throwIfAborted();
      const member = call.expression;
      if (call.questionDotToken || !ts.isPropertyAccessExpression(member) || member.questionDotToken) return;
      const method = member.name.text;
      if (!["use", "group", "route", "guard"].includes(method) && !verbs.has(method)) return;
      const parent = instanceOf(member.expression, frames);
      if (!parent) return;

      if (method === "use") {
        const use = (argument?: ts.Expression) => {
          const value = bindings.value(argument);
          if (!value) return;
          if (ts.isArrayLiteralExpression(value)) {
            for (const item of value.elements) if (!ts.isSpreadElement(item)) use(item);
            return;
          }
          const plugin = instanceOf(value, frames);
          if (plugin && plugin !== parent) {
            mounted.add(plugin);
            copyRoutes(parent, plugin, "");
          } else if (!plugin) visitCallback(argument, parent, frames);
        };
        use(call.arguments[0]);
        return;
      }

      if (method === "group" || method === "guard") {
        if (method === "guard" && call.arguments.length < 2) {
          parent.schema = schemaFor(call.arguments[0]) ?? parent.schema;
          return;
        }
        const threeArguments = method === "group" && call.arguments.length >= 3;
        const sub = method === "group" ? literal(call.arguments[0]) : "";
        const schema = schemaFor(threeArguments || method === "guard" ? call.arguments[method === "guard" ? 0 : 1] : undefined);
        const child: Scope = { prefix: "", routes: new Map(), schema: schema ?? parent.schema };
        visitCallback(call.arguments[threeArguments ? 2 : 1], child, frames);
        if (sub !== undefined) copyRoutes(parent, child, sub);
        return;
      }

      const rawMethod = method === "route" ? literal(call.arguments[0])?.toUpperCase() : method.toUpperCase();
      if (!rawMethod || !/^[A-Z][A-Z0-9-]*$/.test(rawMethod) || parent.prefix === undefined) return;
      const offset = method === "route" ? 1 : 0;
      const local = literal(call.arguments[offset]);
      const handler = call.arguments[offset + 1];
      if (local === undefined || !handler) return;
      put(parent, {
        method: rawMethod === "ALL" ? "ANY" : rawMethod, uri: parent.prefix + leadingSlash(local),
        call, handler, schema: schemaFor(call.arguments[offset + 2]) ?? parent.schema,
      });
    };

    const rootFrames: Frames = new Map();
    const elysiaRouteHint = /\.(?:use|group|get|post|put|patch|delete|head|options|trace|connect|all|ws|route)\s*\(|\bnew\s+Elysia\b/;
    bindings.visitModules(files, unit => visitRouteCalls(unit.source, call => readCall(call, rootFrames)), elysiaRouteHint);

    const slices: VerticalSliceCandidate[] = [];
    for (const scope of scopes.values()) {
      if (mounted.has(scope)) continue;
      for (const route of scope.routes.values()) {
        signal?.throwIfAborted();
        const routeFile = fileOf(route.call);
        const handler = bindings.handler(route.handler);
        const action = handler ? (handler.name === "callback" ? "closure" : handler.name) : route.handler.getText();
        const controllerFile = handler ? fileOf(handler.node) : null;
        const controllerLine = handler ? lineOf(handler.node) : 0;
        const controller = path.basename(controllerFile ?? routeFile).replace(/\.[^.]+$/, "");
        const uri = route.uri || "/";
        const chain: ExecutionChainNode[] = [{
          stage: "ingress", symbol: route.method + " " + uri, file: routeFile, line: lineOf(route.call),
          description: "Elysia Route Registration",
        }];
        if (route.schema) {
          chain.push({
            stage: "validation", symbol: route.schema.getText(), file: fileOf(route.schema), line: lineOf(route.schema),
            description: "Elysia Route Schema Option",
          });
        }
        if (handler && controllerFile) {
          chain.push({
            stage: "controller", symbol: action, file: controllerFile, line: controllerLine,
            description: "Elysia Action Handler",
          }, ...routeContext(handler, bindings, fileOf));
        }
        slices.push({
          domain_id: domainId ?? null, feature_key: `elysia.${controller.toLowerCase()}.${action}`,
          http_method: route.method, route_uri: uri, route_name: `${controller}.${action}`,
          controller_class: controller, action_name: action, controller_file: controllerFile,
          controller_line: controllerLine, architecture_style: "mvc", entry_kind: "http_route",
          execution_chain_json: JSON.stringify(chain),
        });
      }
    }
    return slices;
  }
}
