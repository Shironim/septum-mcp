import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import type Parser from "web-tree-sitter";
import { parseWithTreeSitter } from "../wasm-loader.ts";
import { blankCommentsAndStrings } from "../boundary-tracker.ts";
import { goImports, goKey, goRouteUris, GoRouting, type GoRoute, type GoType } from "./go-routing.ts";
import type { ExecutionChainNode } from "../../../types/index.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { warnIfUnexpectedParserError } from "./manifest-helpers.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

type GoDeclaration = {
  owner: string;
  relPath: string;
  line: number;
  receiver?: string;
  receiverVar?: string;
  body: string;
  params: string;
};
type GoStruct = { relPath: string; line: number; fields: Map<string, GoType> };

export class GoSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "golang";
  public readonly name = "Go HTTP Semantic Slice Extractor (net/http, Gin, Echo, Chi, Fiber)";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (
      framework === "gin" ||
      framework === "echo" ||
      framework === "chi" ||
      framework === "fiber" ||
      framework === "generic-go" ||
      framework === "go" ||
      framework === "net/http"
    ) {
      return true;
    }

    const goMod = path.join(projectRoot, "go.mod");
    if (fs.existsSync(goMod) || listSourceFiles(projectRoot, /(?:^|[\\/])go\.mod$/).length > 0) {
      return true;
    }

    // Check Go source files for HTTP framework or standard library imports
    const goFiles = listSourceFiles(projectRoot, /\.go$/).filter(file => !file.endsWith('_test.go'));
    for (const file of goFiles) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        if (
          content.includes("github.com/gin-gonic/gin") ||
          content.includes("github.com/labstack/echo") ||
          content.includes("github.com/go-chi/chi") ||
          content.includes("github.com/gofiber/fiber") ||
          content.includes('"net/http"')
        ) {
          return true;
        }
      } catch (err: unknown) {
        warnIfUnexpectedParserError(`Failed to inspect Go file ${file}`, err);
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
    const slices: VerticalSliceCandidate[] = [];
    const files = listSourceFiles(projectRoot, /\.go$/, inventory).filter(file => !file.endsWith("_test.go"));
    const visitedDirectories = new Set<string>();
    const manifestFiles = new Set<string>();
    for (const file of files) {
      for (let directory = path.dirname(file); !visitedDirectories.has(directory); directory = path.dirname(directory)) {
        visitedDirectories.add(directory);
        const manifest = path.join(directory, "go.mod");
        if (probeSourcePath(manifest) === "file") manifestFiles.add(manifest);
        if (directory === path.resolve(projectRoot)) break;
      }
    }
    const modules = [...manifestFiles]
      .flatMap(file => {
        const module = readOptionalSourceFile(file, "utf-8").match(/^module\s+(\S+)/m)?.[1];
        return module ? [{ module, directory: path.dirname(file) }] : [];
      })
      .sort((a, b) => b.module.length - a.module.length);
    const routing = new GoRouting(target => {
      const match = modules.find(({ module }) => target === module || target.startsWith(module + "/"));
      return match && path.join(match.directory, target.slice(match.module.length));
    });
    const handlers = new Map<string, GoDeclaration>();
    const structs = new Map<string, GoStruct>();
    const parse = async <T>(file: string, visitor: (root: Parser.SyntaxNode) => T): Promise<T | undefined> => {
      signal?.throwIfAborted();
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content) return undefined;
      let reason: string | undefined;
      const result = await parseWithTreeSitter("go", content, visitor, diagnostic => { reason = diagnostic.message; });
      signal?.throwIfAborted();
      if (result === null) throw new Error(`Could not extract Go AST from '${path.relative(projectRoot, file)}': ${reason}`);
      return result;
    };
    const relative = (file: string) => path.relative(projectRoot, file).replace(/\\/g, "/");

    for (const file of files) {
      const owner = path.dirname(file);
      const relPath = relative(file);
      await parse(file, root => {
        const imports = goImports(root);
        for (const node of root.namedChildren) {
          if (node.hasError) continue;
          if (node.type === "type_declaration") {
            for (const spec of node.namedChildren) {
              const name = spec.childForFieldName("name")?.text;
              const type = spec.childForFieldName("type");
              if (!name || !type || !["struct_type", "interface_type"].includes(type.type)) continue;
              const key = goKey(owner, name);
              const fields = new Map<string, GoType>();
              for (const field of type.descendantsOfType("field_declaration")) {
                const fieldType = routing.readType(field.childForFieldName("type"), imports, owner);
                if (!fieldType) continue;
                for (const id of field.childrenForFieldName("name")) fields.set(id.text, fieldType);
              }
              structs.set(key, { relPath, line: spec.startPosition.row + 1, fields });
              routing.fields.set(key, fields);
            }
          }
          if (!["function_declaration", "method_declaration"].includes(node.type)) continue;
          const name = node.childForFieldName("name")?.text;
          const receiver = node.childForFieldName("receiver")?.namedChild(0);
          const type = routing.readType(receiver?.childForFieldName("type") ?? null, imports, owner);
          const body = node.childForFieldName("body");
          if (!name || !body || (receiver && !type)) continue;
          const key = goKey(owner, type ? `${type.name}.${name}` : name);
          const duplicate = routing.functions.has(key);
          routing.registerFunction(key, node, imports, owner);
          if (duplicate) {
            handlers.delete(key);
            continue;
          }
          handlers.set(key, {
            owner, relPath, line: node.startPosition.row + 1, receiver: type?.name,
            receiverVar: receiver?.childForFieldName("name")?.text,
            params: node.childForFieldName("parameters")?.text ?? "",
            body: blankCommentsAndStrings(body.text),
          });
        }
        return true;
      });
    }

    const routes: Array<{ file: string; route: GoRoute }> = [];
    for (const file of files) {
      const found = await parse(file, root => routing.collect(root, goImports(root), path.dirname(file), signal));
      for (const route of found ?? []) routes.push({ file, route });
    }
    for (const { file, route } of routes) {
      const handler = route.handler.key ? handlers.get(route.handler.key) : undefined;
      for (const uri of goRouteUris(route)) {
        this.pushSlice(slices, relative(file), uri, route, handler, structs, handlers, domainId);
      }
    }
    return slices;
  }

  private pushSlice(
    slices: VerticalSliceCandidate[],
    relPath: string,
    fullUri: string,
    route: GoRoute,
    handler: GoDeclaration | undefined,
    structs: Map<string, GoStruct>,
    declarations: Map<string, GoDeclaration>,
    domainId?: number,
  ): void {
    const { line: routeLine, method: httpMethod } = route;
    const actionName = route.handler.name;
    const controllerClass = handler?.receiver ?? route.handler.receiver ?? path.basename(handler?.relPath ?? relPath, ".go");
    const controllerFile = handler?.relPath ?? relPath;
    const controllerLine = handler?.line ?? route.handler.line ?? routeLine;

    const handlerStruct = handler?.receiver ? structs.get(goKey(handler.owner, handler.receiver)) : undefined;
    const body = handler?.body ?? "";
    const boundVar = body.match(/(?:ShouldBind(?:JSON|Query|URI|XML|YAML|Header)?|Bind(?:JSON)?|Decode|(?:Body|Params|Query)Parser)\s*\(\s*&(\w+)\s*\)/)?.[1];
    const dto = boundVar && new RegExp(
      `(?:var\\s+${boundVar}\\s+(?:\\w+\\.)?([A-Z]\\w*)|` +
      `\\b${boundVar}\\s*:=\\s*&?(?:\\w+\\.)?([A-Z]\\w*)\\s*\\{|` +
      `\\b${boundVar}\\s*:=\\s*new\\s*\\((?:\\w+\\.)?([A-Z]\\w*)\\))`
    ).exec(body);
    const boundType = dto && (dto[1] ?? dto[2] ?? dto[3]);
    const serviceCall = handler && this.findFieldCall(handler, handlerStruct, /(?:Service|Usecase|UC)$/i);
    const repositoryCall = handler && this.findFieldCall(handler, handlerStruct, /(?:Repo|Repository)$/i);

    const registration = { file: relPath, line: routeLine };
    const chain: ExecutionChainNode[] = [
      {
        stage: "ingress",
        symbol: `${httpMethod} ${fullUri}`,
        file: relPath,
        line: routeLine,
        description: `Go Route: ${httpMethod} ${fullUri}`,
        relationship: { kind: "declares", derivation: "source", source: registration, reason: "Go router call" },
      },
    ];

    if (boundType) {
      chain.push({ stage: "validation", symbol: boundType, description: `Request DTO Binding: ${boundType}` });
    }

    if (handler || route.handler.line !== undefined) {
      chain.push({
        stage: "controller",
        symbol: `${controllerClass}::${actionName}`,
        file: controllerFile,
        line: controllerLine,
        description: `Go Route Handler: ${actionName}`,
        relationship: { kind: "route_binding", derivation: "source", source: registration, reason: "Go registration argument" },
      });
    }

    const service = serviceCall && declarations.get(goKey(serviceCall.type.owner, `${serviceCall.type.name}.${serviceCall.method}`));
    if (serviceCall) {
      chain.push({
        stage: "service", symbol: `${serviceCall.field}::${serviceCall.method}`,
        ...(service ? { file: service.relPath, line: service.line } : {}),
        description: "Go Service / Business Logic",
      });
    }

    const serviceStruct = service?.receiver ? structs.get(goKey(service.owner, service.receiver)) : undefined;
    const persistence = repositoryCall ?? (service && this.findFieldCall(service, serviceStruct, /(?:Repo|Repository)$/i));
    const databaseCall = persistence ? undefined : [body, service?.body ?? ""]
      .map(text => text.match(/\bdb\s*\.\s*(?:Create|Save|Find|First|Update|Delete)\s*\(\s*&?([A-Z]\w*)\s*\)/)?.[1])
      .find(Boolean);
    const repository = persistence && declarations.get(goKey(persistence.type.owner, `${persistence.type.name}.${persistence.method}`));
    const repoStruct = persistence && structs.get(goKey(persistence.type.owner, persistence.type.name));
    if (persistence) {
      const location = repository ?? repoStruct;
      chain.push({
        stage: "repository", symbol: `${persistence.field}::${persistence.method}`,
        ...(location ? { file: location.relPath, line: location.line } : {}),
        description: "Go Repository / Persistence Layer",
      });
    } else if (databaseCall) {
      chain.push({
        stage: "repository", symbol: "DB::" + databaseCall, description: "Persistence / Database Operation",
        relationship: { kind: "calls", derivation: "inferred", reason: "Go database call pattern" },
      });
    }

    const entity = databaseCall ?? (repository?.body.match(/&?([A-Z]\w*)\s*\{/) ?? repository?.params.match(/(?:^|[\s*])(?:\w+\.)?([A-Z]\w*)\b/))?.[1]
      ?? boundType?.replace(/(?:Request|Req|DTO|Dto)$/, "");
    const entityOwners = [repository?.owner, handler?.owner];
    const entityLocations = entity
      ? [...new Set([...structs].filter(([key]) => key.endsWith("\0" + entity)).map(([, location]) => location))]
      : [];
    const entityLocation = entity && (entityOwners.map(owner => owner && structs.get(goKey(owner, entity))).find(Boolean) ||
      (entityLocations.length === 1 ? entityLocations[0] : undefined));
    if (entity && entityLocation) {
      chain.push({
        stage: "entity", symbol: entity, file: entityLocation.relPath, line: entityLocation.line,
        description: "Go Database / Domain Entity",
      });
    }

    slices.push({
      domain_id: domainId ?? null,
      feature_key: null,
      http_method: httpMethod,
      route_uri: fullUri,
      route_name: `${controllerClass}.${actionName}`,
      controller_class: controllerClass,
      action_name: actionName,
      controller_file: controllerFile,
      controller_line: controllerLine,
      architecture_style: "go-http",
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify(chain),
    });
  }

  private findFieldCall(
    declaration: GoDeclaration,
    struct: GoStruct | undefined,
    suffix: RegExp,
  ): { field: string; method: string; type: GoType } | undefined {
    for (const call of declaration.body.matchAll(/\b(\w+)\.(\w+)\s*\.\s*([A-Z]\w*)\s*\(/g)) {
      const type = struct?.fields.get(call[2]!);
      if (call[1] === declaration.receiverVar && type && suffix.test(type.name)) {
        return { field: call[2]!, method: call[3]!, type };
      }
    }
    return undefined;
  }
}
