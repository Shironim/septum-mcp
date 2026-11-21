import { composeMountPrefixes } from "./route-prefixes.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { readPythonStaticString as cleanLiteral } from "../static-string.ts";
import {
  pythonCallArgument, pythonImportedName, pythonImports, pythonLiteralMethods, type PythonImport,
} from "./python-route-ast.ts";
import { readDjangoUrlconf, type DjangoUrlEntry, type DjangoViewTarget } from "./django-routing.ts";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { anyFileContains } from "./manifest-helpers.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

interface ViewMethodInfo {
  method: string;
  action: string;
  line: number;
  isCustomAction?: boolean;
  isDetail?: boolean;
  urlPath?: string;
}

interface ViewInfo {
  name: string;
  relPath: string;
  line: number;
  kind: "cbv" | "fbv" | "viewset";
  serializer?: string;
  model?: string;
  methods: ViewMethodInfo[];
}

function normalizeUri(value: string): string {
  return "/" + value.trim().replace(/^\/+|\/+$/g, "");
}

function cleanRoutePattern(raw: string): string {
  return raw
    .replace(/^\^+|\$+$/g, "")
    .replace(/\(\?P<([a-zA-Z0-9_]+)>[^)]+\)/g, "{$1}")
    .replace(/<([a-zA-Z0-9_]+:[a-zA-Z0-9_]+)>/g, (_match, p) => `{${p.split(":").pop()}}`)
    .replace(/<([a-zA-Z0-9_]+)>/g, "{$1}");
}

export class DjangoSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "django";
  public readonly name = "Django / DRF Semantic Slice Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "django") return true;

    if (
      fs.existsSync(path.join(projectRoot, "manage.py")) ||
      fs.existsSync(path.join(projectRoot, "wsgi.py")) ||
      fs.existsSync(path.join(projectRoot, "asgi.py"))
    ) {
      return true;
    }

    return anyFileContains(
      projectRoot,
      ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"],
      ["django"],
      true
    );
  }

  public async extractSlices(projectRoot: string, domainId?: number, signal?: AbortSignal, inventory?: SourceInventory): Promise<VerticalSliceCandidate[]> {
    const slices: VerticalSliceCandidate[] = [];
    const pyFiles = listSourceFiles(projectRoot, /\.py$/, inventory);
    const resolver = new ImportResolver(projectRoot);

    const viewsMap = new Map<string, ViewInfo>();
    const recordView = (view: ViewInfo) => {
      const key = `${view.relPath}#${view.name}`;
      viewsMap.set(key, view);
      viewsMap.set(`${key}@${view.line}`, view);
    };
    const urlConfs = new Map<string, DjangoUrlEntry[]>();

    for (const file of pyFiles) {
      signal?.throwIfAborted();
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content || !/urlpatterns|\b(?:class|def)\s/.test(content)) continue;
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");

      const parsed = await parseSourceWithTreeSitter("python", content, (root) => {
        const imports = new Map<string, PythonImport>();
        for (const statement of root.namedChildren) {
          signal?.throwIfAborted();
          for (const [name, binding] of pythonImports(statement)) {
            imports.set(name, binding);
            viewsMap.delete(`${relPath}#${name}`);
          }
          if (statement.type === "expression_statement") {
            const expression = statement.namedChild(0);
            if (expression?.type === "assignment") {
              const left = expression.childForFieldName("left");
              if (left?.type === "identifier") {
                const right = expression.childForFieldName("right");
                const alias = right?.type === "identifier" ? viewsMap.get(`${relPath}#${right.text}`) : undefined;
                if (alias) viewsMap.set(`${relPath}#${left.text}`, alias);
                else viewsMap.delete(`${relPath}#${left.text}`);
                imports.delete(left.text);
              }
            }
          }
          const node = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
          if (!node || !["class_definition", "function_definition"].includes(node.type) || node.hasError) continue;
          if (node.type === "function_definition") {
            const name = node.childForFieldName("name")?.text;
            if (!name) continue;
            const line = node.startPosition.row + 1;
            let methods = ["ANY"];
            for (const decorator of statement.namedChildren.filter(child => child.type === "decorator")) {
              const value = decorator.namedChild(0);
              if (!value) continue;
              const nameNode = value.type === "call" ? value.childForFieldName("function") : value;
              const name = nameNode?.text ?? "";
              const qualified = pythonImportedName(name, imports) ?? name;
              if (value.type === "call" && /^(?:rest_framework\.decorators\.)?api_view$/.test(qualified)) {
                const argument = pythonCallArgument(value, "http_method_names", 0);
                methods = argument ? pythonLiteralMethods(argument) ?? [] : ["GET"];
                break;
              }
              if (qualified === "django.views.decorators.http.require_GET") methods = ["GET"];
              if (qualified === "django.views.decorators.http.require_POST") methods = ["POST"];
              if (qualified === "django.views.decorators.http.require_safe") methods = ["GET", "HEAD"];
              if (value.type === "call" && qualified === "django.views.decorators.http.require_http_methods") {
                const argument = pythonCallArgument(value, "request_method_list", 0);
                methods = argument ? pythonLiteralMethods(argument) ?? [] : [];
              }
            }
            recordView({ name, relPath, line, kind: "fbv",
              methods: methods.map(method => ({ method, action: name, line })),
            });
            imports.delete(name);
            continue;
          }
          const nameNode = node.childForFieldName("name");
          if (!nameNode) continue;
          const className = nameNode.text.trim();
          imports.delete(className);
          const classLine = node.startPosition.row + 1;

          const superNode = node.childForFieldName("superclasses");
          const baseClasses: string[] = [];
          if (superNode) {
            for (const child of superNode.namedChildren) {
              baseClasses.push(child.text.trim());
            }
          }

          const isViewSet = baseClasses.some(base => {
            const target = pythonImportedName(base, imports) ?? base;
            return /^(?:rest_framework\.viewsets\.|viewsets\.)?\w*ViewSet$/.test(target);
          });

          let serializer: string | undefined;
          let model: string | undefined;
          const explicitMethods: ViewMethodInfo[] = [];

          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              if (child.type === "expression_statement") {
                const assign = child.namedChildren[0];
                if (assign?.type === "assignment") {
                  const left = assign.childForFieldName("left")?.text?.trim();
                  const right = assign.childForFieldName("right");
                  if (left === "serializer_class") {
                    serializer = right?.text?.trim();
                  } else if (left === "model") {
                    model = right?.text?.trim();
                  } else if (left === "queryset" && right) {
                    let cur = right.type === "call" ? right.childForFieldName("function") : right;
                    while (cur?.type === "attribute") {
                      cur = cur.childForFieldName("object");
                    }
                    if (cur?.type === "identifier" && /^[A-Z]/.test(cur.text)) {
                      model = cur.text;
                    }
                  }
                }
              } else {
                const definition = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
                if (definition?.type !== "function_definition") continue;
                const action = definition.childForFieldName("name")?.text;
                if (!action) continue;
                const line = definition.startPosition.row + 1;

                if (!isViewSet) {
                  if (/^(get|post|put|patch|delete|options|head|trace)$/.test(action)) {
                    explicitMethods.push({ method: action.toUpperCase(), action, line });
                  }
                  continue;
                }

                for (const decorator of child.namedChildren.filter(node => node.type === "decorator")) {
                  const call = decorator.namedChild(0);
                  if (call?.type !== "call") continue;
                  const target = call.childForFieldName("function")?.text ?? "";
                  if (!/^(?:rest_framework\.decorators\.)?action$/.test(pythonImportedName(target, imports) ?? target)) continue;
                  const detail = pythonCallArgument(call, "detail");
                  if (detail?.type !== "true" && detail?.type !== "false") continue;
                  const methodArg = pythonCallArgument(call, "methods", 0);
                  const methods = !methodArg || methodArg.type === "none" ? ["GET"] : pythonLiteralMethods(methodArg) ?? [];
                  const pathArg = pythonCallArgument(call, "url_path");
                  const urlPath = pathArg && pathArg.type !== "none" ? cleanLiteral(pathArg) : action;
                  if (urlPath === undefined) continue;
                  for (const method of methods) {
                    explicitMethods.push({ method, action, line, isCustomAction: true,
                      isDetail: detail.type === "true", urlPath: urlPath || action,
                    });
                  }
                }
                const standardMethod = { list: "GET", create: "POST", retrieve: "GET",
                  update: "PUT", partial_update: "PATCH", destroy: "DELETE",
                }[action];
                if (standardMethod && !explicitMethods.some(method => method.action === action && method.isCustomAction)) {
                  explicitMethods.push({ method: standardMethod, action, line });
                }
              }
            }
          }

          const methods: ViewMethodInfo[] = [];

          if (isViewSet) {
            const canonicalBases = baseClasses.map(base => pythonImportedName(base, imports) ?? base);
            const fullCrud = canonicalBases.some((b) => /\bModelViewSet\b/.test(b));
            const readOnly = canonicalBases.some((b) => /\bReadOnlyModelViewSet\b/.test(b));
            const hasListMixin = canonicalBases.some((b) => /\bListModelMixin\b/.test(b));
            const hasCreateMixin = canonicalBases.some((b) => /\bCreateModelMixin\b/.test(b));
            const hasRetrieveMixin = canonicalBases.some((b) => /\bRetrieveModelMixin\b/.test(b));
            const hasUpdateMixin = canonicalBases.some((b) => /\bUpdateModelMixin\b/.test(b));
            const hasDestroyMixin = canonicalBases.some((b) => /\bDestroyModelMixin\b/.test(b));

            const defaultActions: Array<[string, string, boolean]> = [
              ["GET", "list", fullCrud || readOnly || hasListMixin],
              ["POST", "create", fullCrud || hasCreateMixin],
              ["GET", "retrieve", fullCrud || readOnly || hasRetrieveMixin],
              ["PUT", "update", fullCrud || hasUpdateMixin],
              ["PATCH", "partial_update", fullCrud || hasUpdateMixin],
              ["DELETE", "destroy", fullCrud || hasDestroyMixin],
            ];

            for (const [method, action, allowed] of defaultActions) {
              const explicit = explicitMethods.find((m) => m.action === action && !m.isCustomAction);
              if (explicit) {
                methods.push(explicit);
              } else if (allowed) {
                methods.push({ method, action, line: classLine });
              }
            }

            for (const custom of explicitMethods.filter((m) => m.isCustomAction)) {
              methods.push(custom);
            }
          } else {
            methods.push(...explicitMethods);
          }

          recordView({
            name: className, relPath, line: classLine, kind: isViewSet ? "viewset" : "cbv",
            serializer, model, methods,
          });
        }

        const routes = readDjangoUrlconf(root, signal);
        if (routes.length) urlConfs.set(relPath, routes);
        return { symbols: [], dependencies: [] };
      });

      if (parsed?.status !== "parsed") {
        throw new Error(`Django AST unavailable or degraded: ${relPath}`);
      }
    }

    const roots = new Map([...urlConfs.keys()].map(file => [file, ""]));
    const mounts = [];
    for (const [parent, routes] of urlConfs) {
      for (const route of routes) {
        if (route.kind !== "include") continue;
        const resolved = resolver.resolve(route.module, path.resolve(projectRoot, parent));
        const child = resolved.status === "resolved" ? resolved.targets[0]?.files[0] : undefined;
        if (!child || !urlConfs.has(child)) continue;
        mounts.push({ parent, child, prefix: route.pattern === undefined ? undefined : cleanRoutePattern(route.pattern) });
      }
    }
    const urlPrefixesByFile = composeMountPrefixes(roots, mounts, signal);
    const resolveView = (target: DjangoViewTarget, from: string): ViewInfo | undefined => {
      if (!target.module) return viewsMap.get(`${from}#${target.symbol}@${target.line}`);
      const resolution = resolver.resolve(target.module, path.resolve(projectRoot, from));
      const file = resolution.status === "resolved" ? resolution.targets[0]?.files[0] : undefined;
      return file ? viewsMap.get(`${file}#${target.symbol}`) : undefined;
    };

    for (const [urlFile, routes] of urlConfs) {
      const prefixes = urlPrefixesByFile.get(urlFile) ?? [];
      for (const route of routes) {
        if (route.kind === "include") continue;
        const view = resolveView(route.target, urlFile);
        if (!view?.methods.length) continue;

        let methods = view.methods;
        if (route.kind === "router") {
          if (view.kind !== "viewset") continue;
        } else {
          if ((route.dispatch === "function") !== (view.kind === "fbv")) continue;
          if (view.kind === "viewset") {
            if (!route.actionMap) continue;
            methods = [...route.actionMap].flatMap(([method, action]) => {
              const declared = view.methods.find(candidate => candidate.action === action);
              return declared ? [{ ...declared, method }] : [];
            });
          } else if (route.actionMap) continue;
        }

        for (const prefix of prefixes) {
          const base = normalizeUri(prefix + cleanRoutePattern(route.pattern));
          for (const method of methods) {
            const isRouter = route.kind === "router";
            const architecture = isRouter ? "django-drf" : "django-mvc";
            const suffix = !isRouter ? "" :
              method.isCustomAction ? (method.isDetail ? `/{id}/${method.urlPath}` : `/${method.urlPath}`) :
              method.action === "list" || method.action === "create" ? "" : "/{id}";
            const uri = suffix ? (base === "/" ? suffix : base + suffix) : base;
            const chain: ExecutionChainNode[] = [{
              stage: "ingress", symbol: `${method.method} ${uri}`, file: urlFile, line: route.line,
              description: "Django Route Registration",
            }];
            if (view.serializer) {
              chain.push({ stage: "validation", symbol: view.serializer, description: "DRF Serializer Validation" });
            }

            const inherited = view.kind === "viewset" && method.line === view.line;
            const description = inherited ? "Inherited DRF action (inferred from base class or mixin; line points to class)" :
              method.isCustomAction ? "DRF ViewSet Custom Action" : "Django View Handler";
            chain.push({
              stage: "controller", symbol: `${view.name}::${method.action}`, file: view.relPath, line: method.line, description,
            });
            if (view.model) chain.push({ stage: "model", symbol: view.model, description: "Django ORM Model" });

            const evidencedChain = chain.map(node => ({
              ...node,
              relationship: {
                kind: node.stage === "ingress" || node.stage === "controller" ? "route_binding" : "schema_binding",
                derivation: node.file && node.line && !(inherited && node.stage === "controller") ? "source" : "inferred",
                source: node.file && node.line ? { file: node.file, line: node.line } : undefined,
                reason: node.description,
              },
            }));
            slices.push({
              domain_id: domainId ?? null,
              feature_key: null,
              http_method: method.method,
              route_uri: uri,
              route_name: (route.kind === "path" && route.name) || `${view.name}.${method.action}`,
              controller_class: view.name,
              action_name: method.action,
              controller_file: view.relPath,
              controller_line: method.line,
              architecture_style: architecture,
              entry_kind: "http_route",
              execution_chain_json: JSON.stringify(evidencedChain),
            });
          }
        }
      }
    }

    return slices;
  }
}

