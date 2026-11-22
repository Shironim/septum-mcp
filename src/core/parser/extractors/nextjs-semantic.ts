import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";
import { lineOf, TypeScriptBindings } from "./typescript-bindings.ts";

const NEXTJS_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/** Converts an App Router `.../app/.../route.ts` relative path into a normalized URI. */
export function nextAppRouteFileToUri(relPath: string): string | null {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const match = norm.match(/(?:^|.*\/)app\/(?:(.+)\/)?route\.[cm]?[jt]sx?$/i);
  if (!match) return null;
  const rawSegments = (match[1] ?? "").split("/").filter(Boolean);
  const uriSegments: string[] = [];
  for (const seg of rawSegments) {
    // Next.js route groups `(group)` do not appear in URL paths.
    if (/^\([^)]+\)$/.test(seg)) continue;
    const catchAll = seg.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAll) {
      uriSegments.push(`*${catchAll[1]}`);
      continue;
    }
    const optCatchAll = seg.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optCatchAll) {
      uriSegments.push(`*${optCatchAll[1]}`);
      continue;
    }
    const dynamicSeg = seg.match(/^\[([^\]]+)\]$/);
    if (dynamicSeg) {
      uriSegments.push(`:${dynamicSeg[1]}`);
      continue;
    }
    uriSegments.push(seg);
  }
  return "/" + uriSegments.join("/");
}

export class NextJsSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "nextjs";
  public readonly name = "Next.js App Router Semantic Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "nextjs") return true;
    const hasNextInPkg = (manifestFile: string): boolean => {
      if (probeSourcePath(manifestFile) !== "file") return false;
      const manifest = readOptionalSourceFile(manifestFile, "utf-8");
      if (!manifest) return false;
      try {
        const pkg = JSON.parse(manifest);
        return !!(pkg.dependencies?.next || pkg.devDependencies?.next);
      } catch {
        return false;
      }
    };
    if (hasNextInPkg(path.join(projectRoot, "package.json"))) return true;
    for (const group of ["apps", "packages"]) {
      const groupDir = path.join(projectRoot, group);
      if (probeSourcePath(groupDir) === "directory") {
        try {
          for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
            if (entry.isDirectory() && hasNextInPkg(path.join(groupDir, entry.name, "package.json"))) {
              return true;
            }
          }
        } catch {
          // Ignore unreadable directories
        }
      }
    }
    return false;
  }

  public async extractSlices(
    projectRoot: string,
    domainId?: number,
    signal?: AbortSignal,
    inventory?: SourceInventory
  ): Promise<VerticalSliceCandidate[]> {
    const root = path.resolve(projectRoot);
    const allTsFiles = listSourceFiles(root, /\.[cm]?[jt]sx?$/, inventory).filter((f) => !/\.d\.[cm]?ts$/.test(f));
    const routeFiles = allTsFiles.filter((f) => /(?:^|\/)app\/(?:.+\/)?route\.[cm]?[jt]sx?$/i.test(f));
    if (routeFiles.length === 0) return [];

    const bindings = new TypeScriptBindings(root, new Set(allTsFiles), signal);
    const slices: VerticalSliceCandidate[] = [];

    for (const file of routeFiles) {
      signal?.throwIfAborted();
      const relFile = path.relative(root, file).replace(/\\/g, "/");
      const uri = nextAppRouteFileToUri(relFile);
      if (!uri) continue;

      const unit = bindings.load(file);
      if (!unit) continue;

      const exportedHandlers: Array<{ method: string; node: ts.Node; line: number }> = [];
      for (const stmt of unit.source.statements) {
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
        const isExported = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        if (!isExported) continue;

        if (ts.isFunctionDeclaration(stmt) && stmt.name && NEXTJS_HTTP_METHODS.has(stmt.name.text)) {
          exportedHandlers.push({ method: stmt.name.text, node: stmt, line: lineOf(stmt) });
        } else if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && NEXTJS_HTTP_METHODS.has(decl.name.text) && decl.initializer) {
              const handler = bindings.handler(decl.initializer);
              exportedHandlers.push({
                method: decl.name.text,
                node: handler?.node ?? decl.initializer,
                line: handler ? lineOf(handler.node) : lineOf(decl),
              });
            }
          }
        }
      }

      if (exportedHandlers.length === 0) continue;

      const controllerClass = path.basename(path.dirname(relFile)) || "Route";
      for (const entry of exportedHandlers) {
        const chain: ExecutionChainNode[] = [
          {
            stage: "ingress",
            symbol: `${entry.method} ${uri}`,
            file: relFile,
            line: entry.line,
            description: "Next.js App Router Route Handler",
            relationship: { kind: "declares", derivation: "source", reason: "Next.js App Router export" },
          },
          {
            stage: "controller",
            symbol: `${controllerClass}::${entry.method}`,
            file: relFile,
            line: entry.line,
            description: `Next.js ${entry.method} Handler`,
            relationship: { kind: "route_binding", derivation: "source", reason: "Next.js App Router handler" },
          },
        ];

        slices.push({
          domain_id: domainId ?? null,
          feature_key: `nextjs.${controllerClass.toLowerCase()}.${entry.method.toLowerCase()}`,
          http_method: entry.method,
          route_uri: uri,
          route_name: `${controllerClass}.${entry.method}`,
          controller_class: controllerClass,
          action_name: entry.method,
          controller_file: relFile,
          controller_line: entry.line,
          architecture_style: "mvc",
          entry_kind: "http_route",
          execution_chain_json: JSON.stringify(chain),
        });
      }
    }

    return slices;
  }
}
