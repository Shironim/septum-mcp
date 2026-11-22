import { composeMountPrefixes } from "./route-prefixes.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { readPythonStaticString as cleanLiteral } from "../static-string.ts";
import type Parser from "web-tree-sitter";
import {
  pythonCallArgument, pythonCallUsesUnpacking, pythonLiteralMethods, resolvePythonRouterTarget,
  visitPythonRouterModule, type PythonRouterTarget,
} from "./python-route-ast.ts";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { anyFileContains } from "./manifest-helpers.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

interface ExtractedFlaskRoute {
  file: string;
  relPath: string;
  routerKey: string;
  httpMethods: string[];
  rawPath: string;
  actionName: string;
  endpoint?: string;
  lineIndex: number;
  actionLine: number;
  templateEgress?: string;
}

interface ExtractedBlueprintRegistration {
  file: string;
  parent: string;
  target: PythonRouterTarget;
  // null represents a supplied prefix whose value is unknown. Undefined uses the blueprint default.
  prefix: string | null | undefined;
}

type Blueprint = { name: string; prefix: string | undefined; isApp: boolean };
type Node = Parser.SyntaxNode;
const verbs = /^(get|post|put|patch|delete|options|head)$/;

function routeMethods(call: Node, method: string): string[] {
  if (verbs.test(method)) return [method.toUpperCase()];
  const value = pythonCallArgument(call, "methods");
  return !value || value.type === "none" ? ["GET"] : pythonLiteralMethods(value) ?? [];
}

function normalizeRouteUri(prefix: string, path: string): string {
  if (!path) return prefix || "/";
  return prefix + "/" + path.replace(/^\/+/, "");
}

export class FlaskSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "flask";
  public readonly name = "Flask Semantic Slice Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "flask") return true;

    if (anyFileContains(projectRoot, ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"], ["flask"], true)) {
      return true;
    }

    return anyFileContains(
      projectRoot,
      ["app.py", "main.py", "wsgi.py", "run.py", "server.py", "src/app.py", "app/__init__.py"],
      ["from flask", "import flask"]
    );
  }

  public async extractSlices(
    projectRoot: string,
    domainId?: number,
    signal?: AbortSignal, inventory?: SourceInventory
  ): Promise<VerticalSliceCandidate[]> {
    const slices: VerticalSliceCandidate[] = [];
    const pyFiles = listSourceFiles(projectRoot, /\.py$/, inventory);
    const resolver = new ImportResolver(projectRoot);

    const allRoutes: ExtractedFlaskRoute[] = [];
    const allRegistrations: ExtractedBlueprintRegistration[] = [];
    const blueprints = new Map<string, Blueprint>();
    const fileRouters = new Map<string, Map<string, string>>();

    for (const file of pyFiles) {
      signal?.throwIfAborted();
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content || !/@\s*[A-Za-z_]\w*\.(?:route|get|post|put|patch|delete|options|head|trace)\b|register_blueprint|add_url_rule|Blueprint|Flask/.test(content)) continue;

      const parsed = await parseSourceWithTreeSitter("python", content, root => {
        const readRoute = (key: string, call: Node, method: string, handler: Node, line: number) => {
          if (pythonCallUsesUnpacking(call)) return;
          const rawPath = cleanLiteral(pythonCallArgument(call, "rule", 0));
          const httpMethods = routeMethods(call, method);
          const actionName = handler.childForFieldName("name")?.text;
          if (rawPath === undefined || !httpMethods.length || !actionName) return;

          const endpoint = cleanLiteral(pythonCallArgument(call, "endpoint", method === "add_url_rule" ? 1 : undefined));
          const template = handler.childForFieldName("body")?.descendantsOfType("call").find(node =>
            node.childForFieldName("function")?.text === "render_template",
          );
          allRoutes.push({
            file, relPath, routerKey: key, httpMethods, rawPath, actionName, endpoint,
            lineIndex: line, actionLine: handler.startPosition.row + 1,
            templateEgress: template ? cleanLiteral(pythonCallArgument(template, "template_name_or_list", 0)) : undefined,
          });
        };

        const module = visitPythonRouterModule(root, relPath, {
          constructorCall(key, name, constructor, call) {
            if (!/^(?:flask(?:\.app|\.blueprints)?\.)?(?:Flask|Blueprint)$/.test(constructor)) return false;
            const isApp = constructor.endsWith("Flask");
            const declaredName = isApp ? name : cleanLiteral(pythonCallArgument(call, "name", 0)) ?? name;
            const prefixArg = isApp ? undefined : pythonCallArgument(call, "url_prefix", 5);
            const prefix = !isApp && pythonCallUsesUnpacking(call) ? undefined :
              prefixArg && prefixArg.type !== "none" ? cleanLiteral(prefixArg) : "";
            blueprints.set(key, { name: declaredName, prefix: prefix?.replace(/\/+$/, ""), isApp });
            return true;
          },
          routerCall({ key, call, method, line }, targets) {
            if (method === "add_url_rule") {
              const handler = targets.function(pythonCallArgument(call, "view_func", 2)?.text ?? "");
              if (handler) readRoute(key, call, method, handler, line);
            } else if (method === "register_blueprint") {
              const target = targets.router(pythonCallArgument(call, "blueprint", 0)?.text ?? "");
              if (!target) return;
              const prefixArg = pythonCallArgument(call, "url_prefix");
              const prefix = pythonCallUsesUnpacking(call) ? null :
                prefixArg && prefixArg.type !== "none" ? cleanLiteral(prefixArg)?.replace(/\/+$/, "") ?? null : undefined;
              allRegistrations.push({ file, parent: key, target, prefix });
            }
          },
          decorator({ key, call, method, line }, handler) {
            if (method === "route" || verbs.test(method)) readRoute(key, call, method, handler, line);
          },
        }, signal);
        fileRouters.set(relPath, module.routers);
        return { symbols: [], dependencies: [] };
      });

      if (parsed?.status !== "parsed") {
        throw new Error(`Flask AST parsing degraded in file: ${relPath}`);
      }
    }

    const roots = new Map([...blueprints].map(([key, blueprint]) => [key, blueprint.prefix]));
    const mounts = allRegistrations.flatMap(({ file, parent, target, prefix }) => {
      const child = resolvePythonRouterTarget(target, file, resolver, fileRouters);
      const blueprint = child ? blueprints.get(child) : undefined;
      if (!child || !blueprint || blueprint.isApp) return [];
      return [{ parent, child, prefix: prefix === undefined ? blueprint.prefix : prefix ?? undefined }];
    });
    const prefixesByRouter = composeMountPrefixes(roots, mounts, signal);

    for (const route of allRoutes) {
      const prefixes = prefixesByRouter.get(route.routerKey) ?? [];
      const bpMeta = blueprints.get(route.routerKey);
      const controllerClass = bpMeta?.name || path.basename(route.file, ".py");

      for (const prefix of prefixes) {
        const fullUri = normalizeRouteUri(prefix, route.rawPath);

        for (const httpMethod of route.httpMethods) {
          const chain: Array<{
            stage: string;
            symbol: string;
            file?: string;
            line?: number;
            description?: string;
          }> = [
            {
              stage: "ingress",
              symbol: `${httpMethod} ${fullUri}`,
              file: route.relPath,
              line: route.lineIndex,
              description: `Flask Route: ${httpMethod} ${fullUri}`,
            },
            {
              stage: "controller",
              symbol: `${controllerClass}::${route.actionName}`,
              file: route.relPath,
              line: route.actionLine,
              description: `Flask View Handler: ${route.actionName}`,
            },
          ];

          if (route.templateEgress) {
            chain.push({
              stage: "egress",
              symbol: route.templateEgress,
              description: "Flask Template Render",
            });
          }

          const routeName = route.endpoint || (bpMeta ? `${bpMeta.name}.${route.actionName}` : route.actionName);

          slices.push({
            domain_id: domainId ?? null,
            feature_key: null,
            http_method: httpMethod,
            route_uri: fullUri,
            route_name: routeName,
            controller_class: controllerClass,
            action_name: route.actionName,
            controller_file: route.relPath,
            controller_line: route.actionLine,
            architecture_style: "flask",
            entry_kind: "http_route",
            execution_chain_json: JSON.stringify(chain),
          });
        }
      }
    }

    return slices;
  }
}

