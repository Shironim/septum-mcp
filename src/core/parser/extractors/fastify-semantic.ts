import * as path from "node:path";
import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import { composeMountPrefixes } from "./route-prefixes.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";
import { lineOf, literal, nameText, objectMember, TypeScriptBindings, visitRouteCalls, type Handler } from "./typescript-bindings.ts";

const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace", "all"]);
const instanceMethods = new Set([...verbs, "route", "register", "addSchema", "addHook", "withTypeProvider", "decorate"]);
const hookNames = ["onRequest", "preParsing", "preValidation", "preHandler", "preSerialization", "onSend", "onResponse"];
type Scope = ts.CallExpression | ts.FunctionLikeDeclaration;
type Mount = { parent: Scope; child: ts.FunctionLikeDeclaration; prefix: string | undefined };
type Schema = { id: string; call: ts.CallExpression };
type Route = {
  scope: Scope;
  call: ts.CallExpression;
  uri: string;
  methods: string[];
  handler?: Handler;
  target?: ts.Expression | ts.MethodDeclaration;
  hooks: ts.Expression[];
  schemaRef?: string;
  bodyType?: string;
  rootSlash?: string;
};

export class FastifySemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "fastify";
  public readonly name = "Fastify Plugin Scoping Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "fastify") return true;
    const manifestPath = path.join(projectRoot, "package.json");
    if (probeSourcePath(manifestPath) !== "file") return false;
    try {
      const manifest = JSON.parse(readOptionalSourceFile(manifestPath, "utf-8"));
      return !!(manifest.dependencies?.fastify || manifest.devDependencies?.fastify);
    } catch { return false; }
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
    const roots = new Map<Scope, string>();
    const mounts: Mount[] = [];
    const parents = new Map<Scope, Set<Scope>>();
    const plugins: ts.FunctionLikeDeclaration[] = [];
    const seenPlugins = new Set<Scope>();
    const schemas = new Map<Scope, Map<string, Schema | null>>();
    const routes: Route[] = [];
    const relative = (node: ts.Node) => path.relative(root, node.getSourceFile().fileName).replace(/\\/g, "/");
    const optionsOf = (expression?: ts.Expression) => {
      const node = bindings.value(expression);
      return node && ts.isObjectLiteralExpression(node) ? node : undefined;
    };
    const option = (object: ts.ObjectLiteralExpression | undefined, key: string) => {
      const value = object && objectMember(object, key);
      return value && !ts.isMethodDeclaration(value) ? value : undefined;
    };
    const hasUnknownFields = (opts: ts.ObjectLiteralExpression) => opts.properties.some(property =>
      ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name),
    );

    const resolveScope = (
      expression: ts.Expression,
      plugin?: ts.FunctionLikeDeclaration,
    ): Scope | undefined => {
      let value = bindings.value(expression);
      const inspected = new Set<ts.Node>();
      while (value && !inspected.has(value)) {
        inspected.add(value);
        if (ts.isIdentifier(value) && plugin?.parameters[0] && bindings.declaration(value) === plugin.parameters[0]) {
          return plugin;
        }
        if (!ts.isCallExpression(value) || value.questionDotToken) return undefined;
        const imported = bindings.packageBinding(value.expression);
        if (imported?.module === "fastify" && ["default", "fastify", "Fastify", "*"].includes(imported.name)) {
          roots.set(value, "");
          return value;
        }
        if (!ts.isPropertyAccessExpression(value.expression) || value.expression.questionDotToken ||
            !instanceMethods.has(value.expression.name.text)) return undefined;
        value = bindings.value(value.expression.expression);
      }
      return undefined;
    };

    const readCall = (call: ts.CallExpression, plugin?: ts.FunctionLikeDeclaration) => {
      signal?.throwIfAborted();
      const callee = call.expression;
      if (call.questionDotToken || !ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return;
      const method = callee.name.text;
      if (!instanceMethods.has(method)) return;
      const scope = resolveScope(callee.expression, plugin);
      if (!scope) return;

      if (method === "addSchema") {
        const id = literal(option(optionsOf(call.arguments[0]), "$id"))?.replace(/#$/, "");
        if (!id) return;
        const entries = schemas.get(scope) ?? new Map<string, Schema | null>();
        entries.set(id, entries.has(id) ? null : { id, call });
        schemas.set(scope, entries);
        return;
      }

      if (method === "register") {
        let expression = bindings.value(call.arguments[0]);
        let ignorePrefix = false;
        let unresolvedEncapsulation = false;
        if (expression && ts.isCallExpression(expression) &&
            bindings.packageBinding(expression.expression)?.module === "fastify-plugin") {
          const wrapperOptions = optionsOf(expression.arguments[1]);
          const encapsulate = option(wrapperOptions, "encapsulate");
          unresolvedEncapsulation = Boolean(encapsulate && encapsulate.kind !== ts.SyntaxKind.TrueKeyword &&
            encapsulate.kind !== ts.SyntaxKind.FalseKeyword || expression.arguments[1] && !wrapperOptions ||
            wrapperOptions && !encapsulate && hasUnknownFields(wrapperOptions));
          ignorePrefix = encapsulate?.kind !== ts.SyntaxKind.TrueKeyword;
          expression = expression.arguments[0];
        }
        const target = bindings.handler(expression);
        if (!target?.node.body || target.node === scope) return;
        const opts = optionsOf(call.arguments[1]);
        const prefixArg = option(opts, "prefix");
        const prefix = unresolvedEncapsulation ? undefined : ignorePrefix || !call.arguments[1] ? "" :
          prefixArg ? literal(prefixArg)?.replace(/\/+$/, "") : opts && !hasUnknownFields(opts) ? "" : undefined;
        mounts.push({ parent: scope, child: target.node, prefix });
        const sources = parents.get(target.node) ?? new Set<Scope>();
        sources.add(scope);
        parents.set(target.node, sources);
        if (!seenPlugins.has(target.node)) {
          plugins.push(target.node);
          seenPlugins.add(target.node);
        }
        return;
      }

      if (method !== "route" && !verbs.has(method)) return;
      const opts = optionsOf(call.arguments[method === "route" ? 0 : 1]);
      const target = method !== "route" && call.arguments.length >= 3 ? call.arguments[2] :
        (opts && objectMember(opts, "handler")) ?? (method !== "route" && !opts ? call.arguments[1] : undefined);
      const uri = method === "route" ? literal(option(opts, "url") ?? option(opts, "path")) : literal(call.arguments[0]);
      const methodValue = option(opts, "method");
      const strings = method === "route"
        ? (methodValue && ts.isArrayLiteralExpression(methodValue) ? methodValue.elements.map(literal) : [literal(methodValue)])
        : [method === "all" ? "ANY" : method.toUpperCase()];
      if (uri === undefined || !target || !strings.length ||
          !strings.every((value): value is string => value !== undefined && /^[a-z]+$/i.test(value))) return;
      const hookExpressions = hookNames.flatMap(name => {
        const hint = option(opts, name);
        return !hint ? [] : ts.isArrayLiteralExpression(hint) ? [...hint.elements] : [hint];
      });
      const handler = ts.isMethodDeclaration(target) && target.body
        ? { node: target, name: nameText(target.name) ?? "handler" }
        : ts.isMethodDeclaration(target) ? undefined : bindings.handler(target);
      const schema = optionsOf(option(opts, "schema"));
      const body = optionsOf(option(schema, "body"));
      const schemaRef = literal(option(body ?? schema, "$ref"));
      const type = call.typeArguments?.[0];
      const dto = type && ts.isTypeLiteralNode(type) && type.members.find(member =>
        ts.isPropertySignature(member) && nameText(member.name) === "Body",
      );
      const bodyType = dto && ts.isPropertySignature(dto) ? dto.type?.getText() : undefined;
      routes.push({
        scope, call, uri, methods: [...new Set(strings.map(value => value.toUpperCase()))],
        handler, target, hooks: hookExpressions, schemaRef, bodyType, rootSlash: literal(option(opts, "prefixTrailingSlash")),
      });
    };

    const routeCallHint = /\.(?:route|register|addHook|addSchema|get|post|put|patch|delete|head|options|trace|connect|all)\s*\(/;
    for (const file of files) {
      signal?.throwIfAborted();
      if (!bindings.matches(file, routeCallHint)) continue;
      const unit = bindings.load(file);
      if (unit) visitRouteCalls(unit.source, readCall);
    }
    for (let index = 0; index < plugins.length; index++) {
      signal?.throwIfAborted();
      const plugin = plugins[index]!;
      if (plugin.body) visitRouteCalls(plugin.body, call => readCall(call, plugin));
    }

    const prefixes = composeMountPrefixes(roots, mounts, signal);
    const schemaAt = (scope: Scope, id: string, seen = new Set<Scope>()): Schema | undefined => {
      if (seen.has(scope) || seen.size >= 64) return undefined;
      const local = schemas.get(scope)?.get(id);
      if (local !== undefined) return local ?? undefined;
      const matches = new Set([...parents.get(scope) ?? []].map(parent => schemaAt(parent, id, new Set([...seen, scope]))));
      return matches.size === 1 ? [...matches][0] : undefined;
    };

    const slices: VerticalSliceCandidate[] = [];
    for (const route of routes) {
      signal?.throwIfAborted();
      const routeFile = relative(route.call);
      const routeLine = lineOf(route.call);
      const actionName = route.handler ? (route.handler.name === "callback" ? "closure" : route.handler.name) :
        route.target?.getText() ?? "handler";
      const controllerFile = route.handler ? relative(route.handler.node) : null;
      const controllerLine = route.handler ? lineOf(route.handler.node) : 0;
      const controller = path.basename(controllerFile ?? routeFile).replace(/\.[^.]+$/, "");
      const evidence: ExecutionChainNode[] = [];
      if (route.bodyType) {
        evidence.push({
          stage: "validation", symbol: route.bodyType, file: routeFile, line: routeLine, description: "Fastify Body DTO",
        });
      }
      if (route.schemaRef) {
        const known = schemaAt(route.scope, route.schemaRef.replace(/#$/, ""));
        evidence.push(known ? {
          stage: "validation", symbol: known.id, file: relative(known.call), line: lineOf(known.call),
          description: "Resolved Fastify Schema: " + known.id,
        } : {
          stage: "validation", symbol: "unresolved:$ref", file: routeFile, line: routeLine,
          description: "Unresolved schema reference: " + route.schemaRef,
        });
      }
      for (const hook of route.hooks) {
        evidence.push({
          stage: "middleware", symbol: hook.getText(), file: relative(hook), line: lineOf(hook), description: "Fastify Hook Argument",
        });
      }
      if (controllerFile) {
        const reference = route.target && (ts.isIdentifier(route.target) || ts.isPropertyAccessExpression(route.target))
          ? route.target.getText() : actionName;
        evidence.push({
          stage: "controller", symbol: reference, file: controllerFile, line: controllerLine, description: "Fastify Action Handler",
        });
      }

      for (const prefix of prefixes.get(route.scope) ?? []) {
        const uri = route.uri === "/" && prefix && route.rootSlash !== "slash" ? prefix :
          prefix + "/" + route.uri.replace(/^\/+/, "");
        for (const method of route.methods) {
          const chain: ExecutionChainNode[] = [{
            stage: "ingress", symbol: method + " " + uri, file: routeFile, line: routeLine, description: "Fastify Route Registration",
          }, ...evidence];
          slices.push({
            domain_id: domainId ?? null,
            feature_key: `fastify.${controller.toLowerCase()}.${actionName}`,
            http_method: method, route_uri: uri, route_name: `${controller}.${actionName}`,
            controller_class: controller, action_name: actionName, controller_file: controllerFile,
            controller_line: controllerLine, architecture_style: "mvc", entry_kind: "http_route",
            execution_chain_json: JSON.stringify(chain),
          });
        }
      }
    }
    return slices;
  }
}
