import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { lineOf, TypeScriptBindings, nodes } from "./typescript-bindings.ts";
import { cliRegistrations, mcpRegistrations, type Registration } from "./mcp-cli-dispatch.ts";
import { isPathContained } from "../../resolver/path-resolver.ts";
import { readPackageJson } from "./manifest-helpers.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

export class McpCliSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "mcp-cli";
  public readonly name = "MCP Server & CLI Semantic Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "mcp-server" || framework === "cli") return true;

    // Check presence of CLI or MCP directories
    const hasMcp = fs.existsSync(path.join(projectRoot, "src/mcp/tools"));
    const hasCli = fs.existsSync(path.join(projectRoot, "src/cli/commands"));
    if (hasMcp || hasCli) return true;

    // Check package.json for bin or MCP SDK
    const pkg = readPackageJson(projectRoot);
    if (pkg && (pkg.bin || pkg.dependencies?.["@modelcontextprotocol/sdk"])) {
      return true;
    }

    return false;
  }

  public extractSlices(projectRoot: string, domainId?: number, signal?: AbortSignal, inventory?: SourceInventory): VerticalSliceCandidate[] {
    const root = path.resolve(projectRoot);
    const files = new Set(listSourceFiles(root, /\.(?:[cm]?[jt]s|[jt]sx)$/, inventory));
    const bindings = new TypeScriptBindings(root, files, signal);
    const registrations: Registration[] = [];
    const relative = (file: string) => path.relative(root, file).replace(/\\/g, "/");

    for (const file of files) {
      if (!/^src\/mcp\/server\.[cm]?[jt]s$/.test(relative(file))) continue;
      const unit = bindings.load(file);
      if (unit) registrations.push(...mcpRegistrations(unit.source, bindings));
    }
    const bins = new Map<string, string>();
    try {
      const manifest = path.join(root, "package.json");
      const text = probeSourcePath(manifest) === "file" ? readOptionalSourceFile(manifest, "utf-8") : "";
      const pkg = text ? JSON.parse(text) : {};
      const name = typeof pkg.name === "string" ? pkg.name.split("/").at(-1)! : "cli";
      const entries = typeof pkg.bin === "string" ? [[name, pkg.bin]] : Object.entries(pkg.bin ?? {});
      for (const [bin, file] of entries) {
        if (typeof bin !== "string" || typeof file !== "string") continue;
        const target = path.resolve(root, file);
        if (/\.[cm]?[jt]sx?$/.test(target) && isPathContained(target, root) &&
            probeSourcePath(target) === "file" && !bins.has(target)) {
          bins.set(target, bin);
          // package.json is explicit entrypoint evidence even under the default bin/ exclusion.
          files.add(target);
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    for (const [file, bin] of bins) {
      const unit = bindings.load(file);
      if (unit) registrations.push(...cliRegistrations(unit.source, bin, bindings));
    }

    return registrations.map(entry => {
      signal?.throwIfAborted();
      const cli = entry.bin !== undefined;
      const uri = (cli ? "command:" : "tool:") + entry.name;
      const name = cli ? entry.bin + " " + entry.name : entry.name;
      const ingress = { file: relative(entry.node.getSourceFile().fileName), line: lineOf(entry.node) };
      const handler = entry.handler;
      const handlerFile = handler ? relative(handler.node.getSourceFile().fileName) : null;
      const chain: ExecutionChainNode[] = [{
        stage: "ingress", symbol: cli ? name : uri, ...ingress,
        description: cli ? "CLI command case" : "MCP tool registration",
        relationship: { kind: "declares", derivation: "source", source: ingress, reason: "Literal public name" },
      }];
      if (handler && handlerFile) {
        const typeNodes = handler.node.parameters.flatMap(param => param.type ? nodes(param.type).filter(ts.isIdentifier) : []);
        for (const ref of typeNodes) {
          const declaration = bindings.declaration(ref);
          if (declaration && ts.isInterfaceDeclaration(declaration) && /(?:Options|Args)$/.test(ref.text)) {
            chain.push({ stage: "validation", symbol: ref.text, file: handlerFile, line: lineOf(declaration),
              description: "Handler parameter interface",
              relationship: { kind: "schema_binding", derivation: "source", reason: "Parameter type reference" } });
          }
        }
        chain.push({
          stage: "controller", symbol: handler.name, file: handlerFile, line: lineOf(handler.node),
          description: "Statically bound handler",
          relationship: { kind: "route_binding", derivation: "source", source: ingress, reason: "Registration or dispatcher binding" },
        });
      }
      return {
        domain_id: domainId ?? null,
        feature_key: (cli ? "cli." : "mcp.") + entry.name,
        http_method: cli ? "CLI" : "MCP",
        route_uri: uri,
        route_name: name,
        controller_class: handlerFile ? path.basename(handlerFile, path.extname(handlerFile)) : "Unresolved",
        action_name: handler?.name ?? "unresolved_handler",
        controller_file: handlerFile,
        controller_line: handler ? lineOf(handler.node) : 0,
        architecture_style: cli ? "cli" : "rpc",
        entry_kind: cli ? "cli_command" : "mcp_tool",
        execution_chain_json: JSON.stringify(chain),
      };
    });
  }
}
