import ts from "typescript";
import { resolve } from "node:path";
import { bindContextFile } from "../retrieval/typescript-references.ts";
import { lineOf, visitRouteCalls } from "../parser/extractors/typescript-bindings.ts";
import { readOptionalSourceFile } from "../resources/source-files.ts";
import type { FileRecord } from "../../types/index.ts";

export interface DiscoveredRoute {
  method: string;
  uri: string;
  file: string;
  line: number;
  middlewareSymbols: string[];
  handlerSymbol?: string;
  handlerClass?: string;
  handlerMethod?: string;
}

/** Discover declarative ambient router calls (app/router/server/api.get/post/...) in JS/TS route modules. */
export function discoverDeclarativeRoutesFromFiles(
  projectRoot: string,
  filesByNormPath: ReadonlyMap<string, FileRecord>,
  excluded?: ReadonlySet<string>
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const [key, file] of filesByNormPath) {
    if (
      excluded?.has(file.path) ||
      !/\.[cm]?[jt]sx?$/.test(key) ||
      (file.archetype !== "route" && !/routes?|router|endpoints?/.test(key))
    ) {
      continue;
    }
    const absolute = resolve(projectRoot, file.path);
    const source = readOptionalSourceFile(absolute, "utf-8");
    if (!source) continue;
    const unit = bindContextFile(absolute, source);
    if (unit.hasErrors) continue;

    visitRouteCalls(unit.source, (call) => {
      const member = call.expression;
      if (
        !ts.isPropertyAccessExpression(member) ||
        !ts.isIdentifier(member.expression) ||
        !/^(app|router|server|api)$/.test(member.expression.text) ||
        unit.checker.getSymbolAtLocation(member.expression) ||
        !/^(get|post|put|patch|delete|options|head)$/.test(member.name.text)
      ) {
        return;
      }
      const uri = call.arguments[0];
      const handler = call.arguments.at(-1);
      if (!uri || !ts.isStringLiteralLike(uri) || call.arguments.length < 2 || !handler) return;
      routes.push({
        method: member.name.text.toUpperCase(),
        uri: uri.text,
        file: file.path,
        line: lineOf(call),
        middlewareSymbols: call.arguments.slice(1, -1).map((arg) => arg.getText()),
        handlerSymbol: handler.getText(),
        ...(ts.isPropertyAccessExpression(handler) && {
          handlerClass: handler.expression.getText(),
          handlerMethod: handler.name.text,
        }),
      });
    });
  }
  return routes;
}
