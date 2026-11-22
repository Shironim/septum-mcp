import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { visitSymfonyRoutes } from "./symfony-routing.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import { hasComposerDependency } from "./manifest-helpers.ts";
import type {
  SemanticSliceExtractor,
  VerticalSliceCandidate,
} from "./semantic-extractor.interface.ts";
import type { ExecutionChainNode } from "../../../types/index.ts";

interface InjectedService {
  symbol: string;
  file?: string;
}

export class SymfonySemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "symfony";
  public readonly name = "Symfony Semantic Extractor";

  constructor(private projectRoot: string = process.cwd()) {}

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "symfony") return true;
    if (
      fs.existsSync(path.join(projectRoot, "bin/console")) ||
      fs.existsSync(path.join(projectRoot, "symfony.lock")) ||
      fs.existsSync(path.join(projectRoot, "config/routes.yaml"))
    ) {
      return true;
    }
    return hasComposerDependency(projectRoot, [
      "symfony/framework-bundle",
      "symfony/symfony",
      "symfony/routing",
    ]);
  }

  public async extractSlices(
    projectRoot: string = this.projectRoot,
    domainId?: number,
    signal?: AbortSignal, inventory?: SourceInventory
  ): Promise<VerticalSliceCandidate[]> {
    const root = path.resolve(projectRoot);
    const controllerFiles = listSourceFiles(fs.existsSync(path.join(root, 'src/Controller')) ? path.join(root, 'src/Controller') : path.join(root, 'src'), /\.php$/, inventory);
    const slices: VerticalSliceCandidate[] = [];
    const resolver = new ImportResolver(root);

    for (const file of controllerFiles) {
      signal?.throwIfAborted();
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content || !/#\[[\s\S]*?\bRoute\b/.test(content)) continue;

      const relPath = path.relative(root, file).replace(/\\/g, "/");

      await parseSourceWithTreeSitter(
        "php",
        content,
        (rootNode) => {
          visitSymfonyRoutes(rootNode, ({ uri, name, methods, className, action, resolveClass }) => {
            const methodName = action.childForFieldName("name")?.text;
            if (!methodName) return;
            const methodLine = (action.children.find(child => child.type === "function") ?? action).startPosition.row + 1;
            const { requestParam, services } = this.extractParameters(action, file, resolver, resolveClass);
            const returnType = action.childForFieldName("return_type")?.text || "Response";

            for (const httpMethod of methods) {
              const chain: ExecutionChainNode[] = [{
                stage: "ingress",
                symbol: `${httpMethod} ${uri}`,
                file: relPath,
                description: name ? `HTTP Ingress: ${name}` : "HTTP Ingress",
              }];

              if (requestParam) {
                chain.push({
                  stage: "validation",
                  symbol: requestParam,
                  file: relPath,
                  description: "Symfony Request Injection",
                });
              }

              chain.push({
                stage: "controller",
                symbol: `${className}::${methodName}`,
                file: relPath,
                line: methodLine,
                description: "Symfony Controller Action",
              });

              for (const service of services) {
                chain.push({
                  stage: "service",
                  symbol: service.symbol,
                  file: service.file,
                  description: "Symfony Action Parameter",
                });
              }

              chain.push({ stage: "egress", symbol: returnType, description: "HTTP Response Egress" });

              slices.push({
                domain_id: domainId ?? null,
                feature_key: name || null,
                http_method: httpMethod,
                route_uri: uri,
                route_name: name || null,
                controller_class: className,
                action_name: methodName,
                controller_file: relPath,
                controller_line: methodLine,
                architecture_style: "mvc",
                entry_kind: "http_route",
                execution_chain_json: JSON.stringify(chain),
              });
            }
          }, signal);
          return { symbols: [], dependencies: [] };
        },
        () => ({ symbols: [], dependencies: [] })
      );
    }

    return slices;
  }

  private extractParameters(
    methodNode: Parser.SyntaxNode,
    currentFile: string,
    resolver: ImportResolver,
    resolveClass: (name: string) => string | undefined
  ): { requestParam?: string; services: InjectedService[] } {
    const services: InjectedService[] = [];
    let requestParam: string | undefined;

    const paramsNode = methodNode.childForFieldName("parameters");
    if (!paramsNode) return { requestParam, services };

    for (const param of paramsNode.namedChildren) {
      if (param.type !== "simple_parameter") continue;
      const typeNode = param.childForFieldName("type");
      if (!typeNode) continue;

      const rawType = typeNode.text.replace(/^\?/, "");
      if (!/^[a-z_\\][a-z0-9_\\]*$/i.test(rawType)) continue;
      const resolvedType = resolveClass(rawType);
      const shortType = (resolvedType ?? rawType).split("\\").at(-1)!;

      if (/Request$/i.test(shortType)) {
        requestParam = shortType;
      } else if (/(Service|Repository|Handler|Manager|Client)$/i.test(shortType)) {
        const resolved = resolvedType ? resolver.resolve(resolvedType, currentFile) : undefined;
        services.push({
          symbol: shortType,
          file: resolved?.status === "resolved" ? resolved.targets[0]?.files[0] : undefined,
        });
      }
    }

    return { requestParam, services };
  }
}
