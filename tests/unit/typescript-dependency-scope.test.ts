import { describe, expect, it } from "bun:test";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";

describe("dependencies inside exported TypeScript declarations", () => {
  const parser = new ASTParserEngine();
  it("retains nonliteral imports inside exported functions, classes and arrows", async () => {
    const ast = await parser.parseFile("fixture.ts", [
      "export function load(path: string) { return import(path); }",
      "export class Loader { read(path: string) { return require(path); } }",
      "export const lazy = (path: string) => import(`${path}/index`);",
    ].join("\n"));
    expect(ast.status).toBe("parsed");
    expect(ast.dependencies.map(edge => [edge.target, edge.line_number])).toEqual([
      ["dynamic:import(path)", 1], ["dynamic:require(path)", 2], ["dynamic:import(`${path}/index`)", 3],
    ]);
  });

  it("captures literal dependencies but ignores comment/string decoys and avoids duplicate reexports", async () => {
    const ast = await parser.parseFile("fixture.ts", [
      'export { Target } from "./target";',
      'export function load() { return require("./dependency"); }',
      'export const decoy = "import(path) require(missing)";',
      '// export function ignored() { return import("./poison"); }',
    ].join("\n"));
    expect(ast.dependencies.map(edge => edge.target)).toEqual(["./target", "./dependency"]);
  });
});
