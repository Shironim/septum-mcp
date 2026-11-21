import * as path from "node:path";
import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import { composeMountPrefixes } from "./route-prefixes.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";
import { lineOf, literal, TypeScriptBindings, visitRouteCalls } from "./typescript-bindings.ts";

const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace", "connect", "all"]);

type Receiver = { router: ts.CallExpression; paths?: string[] };
type Mount = { parent: ts.CallExpression; child: ts.CallExpression; prefix: string | undefined };
type Route = {
  router: ts.CallExpression;
  call: ts.CallExpression;
  method: string;
  paths: string[];
  callbacks: ts.Expression[];
};

function stringPaths(value?: ts.Expression): string[] | undefined {
  const single = literal(value);
  if (single !== undefined) return [single];
  if (!value || !ts.isArrayLiteralExpression(value)) return undefined;
  const paths = value.elements.map(literal);
  return paths.every((item): item is string => item !== undefined) ? paths : undefined;
}

function flattenedArguments(argumentsList: readonly ts.Expression[]): ts.Expression[] {
  return argumentsList.flatMap(arg => ts.isArrayLiteralExpression(arg) ? flattenedArguments(arg.elements) : [arg]);
}

function normalizeUri(prefix: string, route: string): string {
  const uri = prefix + (route === "/" && prefix ? "" : "/" + route.replace(/^\/+/, ""));
  return uri || "/";
}

export class ExpressSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "express";
  public readonly name = "Express Router Composition Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "express") return true;
    const manifestFile = path.join(projectRoot, "package.json");
    if (probeSourcePath(manifestFile) !== "file") return false;
    const manifest = readOptionalSourceFile(manifestFile, "utf-8");
    if (!manifest) return false;
    try {
      const pkg = JSON.parse(manifest);
      return !!(pkg.dependencies?.express || pkg.devDependencies?.express);
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
    const routes: Route[] = [];
    const mounts: Mount[] = [];
    const roots = new Map<ts.CallExpression, string>();
    const receivers = new Map<ts.Expression, Receiver | undefined>();
    const relative = (node: ts.Node) => path.relative(root, node.getSourceFile().fileName).replace(/\\/g, "/");

    const receiverOf = (expression: ts.Expression): Receiver | undefined => {
      const node = bindings.value(expression);
      if (!node || !ts.isCallExpression(node) || node.questionDotToken) return undefined;
      if (receivers.has(node)) return receivers.get(node);
      receivers.set(node, undefined);

      const binding = bindings.packageBinding(node.expression);
      if (binding?.module === "express" && ["default", "Router", "*"].includes(binding.name)) {
        const receiver = { router: node };
        roots.set(node, "");
        receivers.set(node, receiver);
        return receiver;
      }

      if (!ts.isPropertyAccessExpression(node.expression) || node.expression.questionDotToken) return undefined;
      const name = node.expression.name.text;
      const parent = receiverOf(node.expression.expression);
      if (!parent) return undefined;
      let receiver: Receiver | undefined;
      if (name === "route" && parent.paths === undefined) {
        const paths = stringPaths(node.arguments[0]);
        if (paths) receiver = { router: parent.router, paths };
      } else if (verbs.has(name) || name === "use" && parent.paths === undefined) receiver = parent;
      receivers.set(node, receiver);
      return receiver;
    };

    for (const file of files) {
      signal?.throwIfAborted();
      const unit = bindings.load(file);
      if (!unit) continue;
      visitRouteCalls(unit.source, call => {
        signal?.throwIfAborted();
        const member = call.expression;
        if (call.questionDotToken || !ts.isPropertyAccessExpression(member) || member.questionDotToken) return;
        const name = member.name.text;
        if (name !== "use" && !verbs.has(name)) return;
        const receiver = receiverOf(member.expression);
        if (!receiver) return;

        if (name === "use") {
          if (receiver.paths !== undefined || !call.arguments.length) return;
          const first = call.arguments[0]!;
          const knownPaths = stringPaths(first);
          const allCallbacks = flattenedArguments(call.arguments);
          const firstRouter = receiverOf(first);
          const implicitPath = firstRouter || bindings.handler(first) ||
            ts.isArrayLiteralExpression(first) && first.elements.some(element => receiverOf(element) || bindings.handler(element));
          const prefixes = knownPaths ? knownPaths.map(value => value.replace(/\/+$/, "")) :
            [implicitPath ? "" : undefined];
          const callbacks = knownPaths ? flattenedArguments(call.arguments.slice(1)) : allCallbacks;
          for (const argument of callbacks) {
            const child = receiverOf(argument);
            if (!child || child.paths !== undefined || child.router === receiver.router) continue;
            for (const prefix of prefixes) mounts.push({ parent: receiver.router, child: child.router, prefix });
          }
          return;
        }

        const paths = receiver.paths ?? stringPaths(call.arguments[0]);
        const callbacks = flattenedArguments(receiver.paths !== undefined ? call.arguments : call.arguments.slice(1));
        if (paths?.length && callbacks.length) {
          routes.push({ router: receiver.router, call, paths, callbacks, method: name === "all" ? "ANY" : name.toUpperCase() });
        }
      });
    }

    const prefixesByRouter = composeMountPrefixes(roots, mounts, signal);
    const slices: VerticalSliceCandidate[] = [];
    for (const route of routes) {
      signal?.throwIfAborted();
      const prefixes = prefixesByRouter.get(route.router) ?? [];
      const registrationFile = relative(route.call);
      const registrationLine = lineOf(route.call);
      const expression = route.callbacks.at(-1)!;
      const handler = bindings.handler(expression);
      const controllerFile = handler ? relative(handler.node) : null;
      const controllerLine = handler ? lineOf(handler.node) : 0;
      const actionName = handler ? (handler.name === "callback" ? "closure" : handler.name) : expression.getText();
      const registrationName = ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
        ? expression.getText() : actionName;
      const controllerClass = ts.isPropertyAccessExpression(expression) ? expression.expression.getText() :
        path.basename(controllerFile ?? registrationFile).replace(/\.[^.]+$/, "");
      const middlewares: ExecutionChainNode[] = route.callbacks.slice(0, -1).map(callback => ({
        stage: "middleware", symbol: callback.getText(), file: relative(callback), line: lineOf(callback),
        description: "Express Middleware Argument",
      }));

      for (const prefix of prefixes) {
        for (const localPath of route.paths) {
          const uri = normalizeUri(prefix, localPath);
          const chain: ExecutionChainNode[] = [{
            stage: "ingress", symbol: route.method + " " + uri, file: registrationFile, line: registrationLine,
            description: "Express Route Registration",
          }, ...middlewares];
          if (handler && controllerFile) {
            chain.push({
              stage: "controller", symbol: registrationName, file: controllerFile, line: controllerLine,
              description: "Express Action Handler",
            });
          }
          slices.push({
            domain_id: domainId ?? null,
            feature_key: `express.${controllerClass.toLowerCase()}.${actionName}`,
            http_method: route.method,
            route_uri: uri,
            route_name: `${controllerClass}.${actionName}`,
            controller_class: controllerClass,
            action_name: actionName,
            controller_file: controllerFile,
            controller_line: controllerLine,
            architecture_style: "mvc",
            entry_kind: "http_route",
            execution_chain_json: JSON.stringify(chain),
          });
        }
      }
    }
    return slices;
  }
}
