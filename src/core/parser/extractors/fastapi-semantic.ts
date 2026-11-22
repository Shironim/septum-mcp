import { composeMountPrefixes } from "./route-prefixes.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { readPythonStaticString as cleanLiteral } from "../static-string.ts";
import type Parser from "web-tree-sitter";
import {
  pythonCallArgument, pythonCallUsesUnpacking, pythonLiteralMethods, resolvePythonRouterTarget,
  visitPythonRouterModule, type PythonImport, type PythonRouterTarget,
} from "./python-route-ast.ts";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { anyFileContains } from "./manifest-helpers.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

interface ExtractedRoute {
  file: string;
  relPath: string;
  routerVar: string;
  routerKey: string;
  name?: string;
  httpMethod: string;
  rawPath: string;
  actionName: string;
  lineIndex: number;
  actionLine: number;
  validationSchema?: string;
  guardSymbol?: string;
  dependencies: string[];
  responseModel?: string;
  service?: { symbol: string; line: number };
  model?: string;
}

interface ExtractedInclusion {
  file: string;
  parentKey: string;
  target: PythonRouterTarget;
  prefix: string | undefined;
}

type Router = { prefix: string | undefined; isApp: boolean; guards: string[]; dependencies: string[] };
type Node = Parser.SyntaxNode;

const verbs = /^(get|post|put|patch|delete|options|head|trace)$/;

function routeMethods(call: Node, method: string): string[] {
  if (verbs.test(method)) return [method.toUpperCase()];
  const methods = pythonCallArgument(call, "methods");
  if (!methods || methods.type === "none") return ["GET"];
  const literal = pythonLiteralMethods(methods);
  return literal?.length === 0 ? ["GET"] : literal ?? [];
}

function normalizeRouteUri(prefix: string, rawPath: string): string {
  const p = (prefix ?? "").trim().replace(/\/+$/, "");
  let r = (rawPath ?? "").trim();
  if (!r) return p || "/";
  if (!r.startsWith("/")) r = "/" + r;
  if (r === "/" && p.length > 0) return p + "/";
  if (r === "/" && p.length === 0) return "/";
  const joined = `${p}${r}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function extractSchemaType(rawType: string): string | undefined {
  const clean = rawType.replace(/^(?:typing\.)?(?:Optional|List|Union)\[(.*)\]$/, "$1").trim();
  const name = clean.split(/[\[,|]/)[0].trim().replace(/^.*?\./, "");
  if (!name || !/^[A-Z]/.test(name)) return undefined;
  const builtins = new Set([
    "Str", "Int", "Float", "Bool", "Dict", "List", "Set", "Tuple", "Bytes",
    "Optional", "Any", "Union", "Request", "Response", "BackgroundTasks",
    "UploadFile", "Header", "Query", "Path", "Body", "Cookie", "Security", "Session", "Depends", "None"
  ]);
  if (builtins.has(name)) return undefined;
  return name;
}

function extractDependsFromNode(node: Parser.SyntaxNode | null | undefined, out: Array<{ symbol: string; isGuard: boolean }>): void {
  if (!node) return;
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === "call" && /Depends$/.test(n.childForFieldName("function")?.text ?? "")) {
      const arg = n.childForFieldName("arguments")?.namedChildren[0]?.text?.trim();
      if (arg) {
        const isGuard = /auth|user|token|permission|guard|role|credential/i.test(arg);
        out.push({ symbol: arg, isGuard });
      }
    }
    for (const child of n.namedChildren) walk(child);
  };
  walk(node);
}

export class FastApiSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "fastapi";
  public readonly name = "FastAPI Semantic Slice Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "fastapi") return true;

    if (anyFileContains(projectRoot, ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"], ["fastapi"], true)) {
      return true;
    }

    return anyFileContains(
      projectRoot,
      ["main.py", "app.py", "api.py", "src/main.py", "app/main.py"],
      ["from fastapi", "import fastapi"]
    );
  }

  public async extractSlices(projectRoot: string, domainId?: number, signal?: AbortSignal, inventory?: SourceInventory): Promise<VerticalSliceCandidate[]> {
    const slices: VerticalSliceCandidate[] = [];
    const pyFiles = listSourceFiles(projectRoot, /\.py$/, inventory);
    const resolver = new ImportResolver(projectRoot);

    const allRoutes: ExtractedRoute[] = [];
    const allInclusions: ExtractedInclusion[] = [];
    const localRouters = new Map<string, Router>();
    const fileRouters = new Map<string, Map<string, string>>();
    const fileImports = new Map<string, Map<string, PythonImport>>();

    for (const file of pyFiles) {
      signal?.throwIfAborted();
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content || !/@\s*[A-Za-z_]\w*\.(?:get|post|put|patch|delete|options|head|trace|api_route|route|websocket)\b|include_router|APIRouter|FastAPI|add_api_route/.test(content)) {
        continue;
      }

      const parsed = await parseSourceWithTreeSitter("python", content, (root) => {
        const walk = (node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void) => {
          visit(node);
          for (const child of node.namedChildren) walk(child, visit);
        };

        const readRoute = (call: Node, method: string, receiver: string, routerKey: string, fn: Node, line: number) => {
          if (pythonCallUsesUnpacking(call)) return;
          const rawPath = cleanLiteral(pythonCallArgument(call, "path", 0));
          const methods = routeMethods(call, method);
          const actionName = fn.childForFieldName("name")?.text;
          if (rawPath === undefined || !methods.length || !actionName) return;
          const name = cleanLiteral(pythonCallArgument(call, "name"));
          const args = call.childForFieldName("arguments")?.namedChildren ?? [];
          const paramsText = fn.childForFieldName("parameters")?.text ?? "";

          // Extract Pydantic validation schema from typed parameters
          let validationSchema: string | undefined;
          const paramsNode = fn.childForFieldName("parameters");
          if (paramsNode) {
            for (const param of paramsNode.namedChildren) {
              if (param.type === "typed_parameter" || param.type === "typed_default_parameter") {
                const typeNode = param.childForFieldName("type");
                if (typeNode) {
                  const detected = extractSchemaType(typeNode.text);
                  if (detected && !validationSchema) {
                    validationSchema = detected;
                  }
                }
              }
            }
          }

          // Fallback schema regex
          if (!validationSchema) {
            const schemaMatch = paramsText.match(
              /[a-zA-Z0-9_]+\s*:\s*([A-Z][a-zA-Z0-9_]*(?:Schema|In|Request|Create|Update|DTO|Body))/
            );
            if (schemaMatch) validationSchema = schemaMatch[1];
          }

          // Extract guards and dependencies from Depends(...)
          let guardSymbol: string | undefined;
          const inboundDeps: string[] = [];
          if (paramsNode) {
            for (const param of paramsNode.namedChildren) {
              let valNode: Parser.SyntaxNode | null = null;
              if (param.type === "typed_default_parameter" || param.type === "default_parameter") {
                valNode = param.childForFieldName("value");
              }
              if (valNode?.type === "call" && /Depends$/.test(valNode.childForFieldName("function")?.text ?? "")) {
                const depArg = valNode.childForFieldName("arguments")?.namedChildren[0];
                const sym = depArg?.text?.trim();
                if (sym) {
                  if (/auth|user|token|permission|guard|role|credential/i.test(sym)) {
                    guardSymbol = sym;
                  } else {
                    inboundDeps.push(sym);
                  }
                }
              }
            }
          }

          // Fallback guard regex
          if (!guardSymbol) {
            const guardMatch = paramsText.match(
              /Depends\s*\(\s*([a-zA-Z0-9_]*(?:auth|user|token|permission|guard)[a-zA-Z0-9_]*)\s*\)/i
            );
            if (guardMatch) guardSymbol = guardMatch[1];
          }

          // Extract dependencies from decorator: @router.get("/", dependencies=[Depends(...)])
          const decDepsKw = args.find(
            (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "dependencies"
          );
          if (decDepsKw) {
            const decExtracted: Array<{ symbol: string; isGuard: boolean }> = [];
            extractDependsFromNode(decDepsKw.childForFieldName("value"), decExtracted);
            for (const item of decExtracted) {
              if (item.isGuard && !guardSymbol) guardSymbol = item.symbol;
              else inboundDeps.push(item.symbol);
            }
          }

          // Extract response_model
          const rmKw = args.find(
            (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "response_model"
          );
          const responseModel = rmKw?.childForFieldName("value")?.text?.trim();

          const route: Omit<ExtractedRoute, "httpMethod"> = {
            file,
            relPath,
            routerVar: receiver,
            routerKey,
            name,
            rawPath,
            actionName,
            lineIndex: line,
            actionLine: fn.startPosition.row + 1,
            validationSchema,
            guardSymbol,
            dependencies: inboundDeps,
            responseModel,
          };

          const body = fn.childForFieldName("body");
          if (body) {
            walk(body, (child) => {
              if (child.type !== "call") return;
              const called = child.childForFieldName("function")?.text ?? "";
              const service = called.match(/^([a-zA-Z0-9_]+_service|[A-Z][a-zA-Z0-9_]*Service)\.([a-zA-Z0-9_]+)$/);
              if (service && !route.service) {
                route.service = { symbol: `${service[1]}::${service[2]}`, line: child.startPosition.row + 1 };
              }
              if (/^(db\.(add|query)|session\.query)$/.test(called)) {
                const argument = child.childForFieldName("arguments")?.namedChildren[0];
                if (argument?.type === "identifier" && /^[A-Z]/.test(argument.text)) {
                  route.model = argument.text;
                }
              }
            });
          }

          for (const httpMethod of methods) allRoutes.push({ ...route, httpMethod });
        };

        const module = visitPythonRouterModule(root, relPath, {
          constructorCall(key, _name, constructor, call) {
            if (!/^(?:fastapi(?:\.routing|\.applications)?\.)?(?:APIRouter|FastAPI)$/.test(constructor)) return false;
            const isApp = constructor.endsWith("FastAPI");
            const prefixArg = isApp ? undefined : pythonCallArgument(call, "prefix");
            const prefix = !isApp && pythonCallUsesUnpacking(call) ? undefined : prefixArg ? cleanLiteral(prefixArg) : "";
            const dependencies: Array<{ symbol: string; isGuard: boolean }> = [];
            extractDependsFromNode(pythonCallArgument(call, "dependencies"), dependencies);
            localRouters.set(key, {
              prefix: prefix?.replace(/\/+$/, ""),
              isApp,
              guards: dependencies.filter(item => item.isGuard).map(item => item.symbol),
              dependencies: dependencies.filter(item => !item.isGuard).map(item => item.symbol),
            });
            return true;
          },
          routerCall({ call, key, receiver, method, line }, targets) {
            if (method === "add_api_route") {
              const handler = targets.function(pythonCallArgument(call, "endpoint", 1)?.text ?? "");
              if (handler) readRoute(call, method, receiver, key, handler, line);
            } else if (method === "include_router") {
              const target = targets.router(pythonCallArgument(call, "router", 0)?.text ?? "");
              if (!target) return;
              const pref = pythonCallArgument(call, "prefix");
              const prefix = pythonCallUsesUnpacking(call) ? undefined : pref ? cleanLiteral(pref) : "";
              allInclusions.push({ file, parentKey: key, target, prefix: prefix?.replace(/\/+$/, "") });
            }
          },
          decorator({ call, key, receiver, method, line }, handler) {
            if (method === "api_route" || verbs.test(method)) readRoute(call, method, receiver, key, handler, line);
          },
        }, signal);
        fileRouters.set(relPath, module.routers);
        fileImports.set(relPath, module.imports);
        return { symbols: [], dependencies: [] };
      });

      if (parsed?.status !== "parsed") {
        throw new Error(`FastAPI AST unavailable or degraded: ${relPath}`);
      }
    }

    const roots = new Map([...localRouters].map(([key, router]) => [key, router.prefix]));
    const mounts = allInclusions.flatMap(({ file, parentKey, target, prefix }) => {
      const child = resolvePythonRouterTarget(target, file, resolver, fileRouters);
      const router = child ? localRouters.get(child) : undefined;
      if (!child || !router || router.isApp) return [];
      return [{ parent: parentKey, child, prefix: prefix === undefined || router.prefix === undefined ? undefined : prefix + router.prefix }];
    });
    const prefixesByRouter = composeMountPrefixes(roots, mounts, signal);

    for (const route of allRoutes) {
      const prefixes = prefixesByRouter.get(route.routerKey) ?? [];

      for (const prefix of prefixes) {
        const fullUri = normalizeRouteUri(prefix, route.rawPath);

        const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
          {
            stage: "ingress",
            symbol: `${route.httpMethod} ${fullUri}`,
            file: route.relPath,
            line: route.lineIndex,
            description: `FastAPI Route: ${route.httpMethod} ${fullUri}`,
          },
        ];

        const routerMeta = localRouters.get(route.routerKey);
        const effectiveGuards = Array.from(new Set([
          ...(route.guardSymbol ? [route.guardSymbol] : []),
          ...(routerMeta?.guards ?? []),
        ]));
        const effectiveDeps = Array.from(new Set([
          ...route.dependencies,
          ...(routerMeta?.dependencies ?? []),
        ]));

        for (const guard of effectiveGuards) {
          chain.push({
            stage: "guard",
            symbol: guard,
            description: `Auth / Security Dependency: ${guard}`,
          });
        }

        if (route.validationSchema) {
          chain.push({
            stage: "validation",
            symbol: route.validationSchema,
            description: `Pydantic Schema Validation: ${route.validationSchema}`,
          });
        }

        const controllerSymbol = `${path.basename(route.file, ".py")}::${route.actionName}`;
        chain.push({
          stage: "controller",
          symbol: controllerSymbol,
          file: route.relPath,
          line: route.actionLine,
          description: `FastAPI Route Handler: ${route.actionName}`,
        });

        for (const dep of effectiveDeps) {
          chain.push({
            stage: "dependency",
            symbol: dep,
            description: `FastAPI Inbound Dependency: ${dep}`,
          });
        }

        if (route.service) {
          const serviceName = route.service.symbol.split("::")[0];
          const serviceMethod = route.service.symbol.split("::")[1];
          const importsInFile = fileImports.get(route.relPath);
          const binding = importsInFile?.get(serviceName);
          let serviceFile: string | undefined;
          let serviceLine: number = route.service.line;
          let persistenceModel: { name: string; file?: string; line?: number } | undefined;

          if (binding?.module) {
            const subTarget = binding.symbol ? `${binding.module}.${binding.symbol}` : binding.module;
            let res = resolver.resolve(subTarget, route.file);
            if (res.status !== "resolved" && binding.module) {
              res = resolver.resolve(binding.module, route.file);
            }
            if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
              serviceFile = res.targets[0].files[0];
            }
          }

          if (serviceFile) {
            const fullServicePath = path.resolve(projectRoot, serviceFile);
            const serviceContent = readOptionalSourceFile(fullServicePath, "utf-8");
            if (serviceContent) {
              const fnMatch = new RegExp(`(?:def|async\\s+def)\\s+${serviceMethod}\\s*\\(`).exec(serviceContent);
              if (fnMatch) {
                serviceLine = serviceContent.slice(0, fnMatch.index).split("\n").length;
              }
              // Scan service for ORM persistence (SQLAlchemy, Tortoise, SQLModel)
              let modelName: string | undefined;
              const directOrmMatch =
                serviceContent.match(/(?:db\.(?:add|query)|session\.(?:query|add)|select)\s*\(\s*([A-Z][a-zA-Z0-9_]+)/) ||
                serviceContent.match(/\b([A-Z][a-zA-Z0-9_]+)\.(?:create|filter|get|save|all)\s*\(/);
              if (directOrmMatch) {
                modelName = directOrmMatch[1];
              } else {
                const varAddMatch = serviceContent.match(/(?:db|session)\.add\s*\(\s*([a-zA-Z0-9_]+)\s*\)/);
                if (varAddMatch) {
                  const varName = varAddMatch[1];
                  const instMatch = serviceContent.match(new RegExp(`\\b${varName}\\s*=\\s*([A-Z][a-zA-Z0-9_]+)\\s*\\(`));
                  if (instMatch) {
                    modelName = instMatch[1];
                  }
                }
                if (!modelName) {
                  const impMatch = serviceContent.match(/from\s+[a-zA-Z0-9_.]+\s+import\s+[^\\n]*\b([A-Z][a-zA-Z0-9_]+)\b/);
                  if (impMatch && serviceContent.includes("db.add") && new RegExp(`\\b${impMatch[1]}\\s*\\(`).test(serviceContent)) {
                    modelName = impMatch[1];
                  }
                }
              }

              if (modelName) {
                let modelFile: string | undefined;
                const modelImportMatch = serviceContent.match(
                  new RegExp(`from\\s+([a-zA-Z0-9_.]+)\\s+import\\s+[^\\n]*\\b${modelName}\\b`)
                );
                if (modelImportMatch) {
                  const mRes = resolver.resolve(modelImportMatch[1], fullServicePath);
                  if (mRes.status === "resolved" && mRes.targets[0]?.files?.[0]) {
                    modelFile = mRes.targets[0].files[0];
                  }
                }
                persistenceModel = { name: modelName, file: modelFile };
              }
            }
          }

          chain.push({
            stage: "service",
            symbol: route.service.symbol,
            file: serviceFile || route.relPath,
            line: serviceLine,
            description: serviceFile
              ? "Domain Service Invocation"
              : "Syntactic member call; receiver binding and runtime execution unproven",
          });

          if (persistenceModel) {
            chain.push({
              stage: "model",
              symbol: persistenceModel.name,
              ...(persistenceModel.file ? { file: persistenceModel.file } : {}),
              description: "SQLAlchemy / ORM Model Persistence",
            });
          }
        }

        if (route.model && !chain.some((n) => n.stage === "model")) {
          const importsInFile = fileImports.get(route.relPath);
          const binding = importsInFile?.get(route.model);
          let modelFile: string | undefined;
          if (binding?.module) {
            const mRes = resolver.resolve(binding.module, route.file);
            if (mRes.status === "resolved" && mRes.targets[0]?.files?.[0]) {
              modelFile = mRes.targets[0].files[0];
            }
          }
          chain.push({
            stage: "model",
            symbol: route.model,
            ...(modelFile ? { file: modelFile } : {}),
            description: modelFile ? "SQLAlchemy / ORM Model Persistence" : "ORM argument hint; persistence unproven",
          });
        }

        if (route.responseModel) {
          chain.push({
            stage: "response_schema",
            symbol: route.responseModel,
            description: `FastAPI Response Model: ${route.responseModel}`,
          });
        }

        const evidencedChain = chain.map((node) => ({
          ...node,
          relationship: {
            kind:
              node.stage === "ingress" || node.stage === "controller"
                ? "route_binding"
                : node.stage === "validation" || node.stage === "model" || node.stage === "response_schema"
                ? "schema_binding"
                : "calls",
            derivation: node.file && node.line ? "source" : "inferred",
            source: node.file && node.line ? { file: node.file, line: node.line } : undefined,
            reason: node.description ?? "static adapter evidence",
          },
        }));

        slices.push({
          domain_id: domainId ?? null,
          feature_key: null,
          http_method: route.httpMethod,
          route_uri: fullUri,
          route_name: route.name ?? `${route.routerVar}.${route.actionName}`,
          controller_class: path.basename(route.file, ".py"),
          action_name: route.actionName,
          controller_file: route.relPath,
          controller_line: route.actionLine,
          architecture_style: "fastapi-api",
          entry_kind: "http_route",
          execution_chain_json: JSON.stringify(evidencedChain),
        });
      }
    }

    return slices;
  }
}

