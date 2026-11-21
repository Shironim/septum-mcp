import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";

let root: string, db: SeptumDatabase, repo: SeptumRepository, tracer: VerticalSliceTracer;
const put = (file: string, text: string) => writeFileSync(join(root, file), text);
async function sync() {
  const config = ConfigLoader.getDefaultConfig();
  config.domains = { main: { root: ".", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };
  await new IngestionPipeline(repo, root).run(config);
}
beforeEach(() => {
  root = mkdtempSync("/tmp/septum-catalog-registration-");
  db = new SeptumDatabase(":memory:");
  repo = new SeptumRepository(db.raw);
  tracer = new VerticalSliceTracer(repo, root);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("unrelated Express registrations preserve inferred controllers and exclude fake receivers", async () => {
  put("package.json", JSON.stringify({ dependencies: { express: "5" } }));
  put("BookController.ts", "export class BookController { list() { return []; } }");
  put("fake.routes.ts", "const app = { get(path, handler) {} }; app.get('/phantom', () => 1);");
  put("fake.routes.js", "const router = { get() {} }; router.get('/phantom-js', () => 1);");
  await sync();
  expect(tracer.trace("GET /phantom").found).toBe(false);
  expect(tracer.trace("GET /phantom-js").found).toBe(false);
  expect(tracer.trace("GET /books/list").confidence).toBe("inferred");
  put("real.routes.ts", "import express from 'express'; const app = express(); app.get('/valid', () => 1);");
  await sync();
  expect(tracer.trace("GET /valid").confidence).toBe("exact");
  expect(tracer.trace("PURGE /valid").found).toBe(false);
  expect(tracer.trace("GET /books/list").confidence).toBe("inferred");
});

test("catalog preserves competing registrations and binds a tsconfig alias to its handler", async () => {
  put("package.json", JSON.stringify({ dependencies: { express: "5" } }));
  put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@api/*": ["./*"] } } }));
  put("handlers.ts", "export function list() {}");
  put("routes.ts", [
    "import express from 'express'; import { list } from '@api/handlers';",
    "const app = express();",
    "app.get('/valid', list);",
    "app.get('/collision', () => 1);",
    "app.get('/collision', () => 2);",
  ].join("\n"));
  await sync();
  expect(tracer.trace("GET /collision").alternatives?.map(row => row.line)).toEqual([4, 5]);
  const selected = tracer.trace("GET /valid");
  expect(selected.entrypoint?.file).toBe("handlers.ts");
  expect(selected.chain?.some(node => node.stage === "controller" && node.file === "handlers.ts")).toBe(true);
});

test("expansion of same-named NestJS actions uses the selected declaration", async () => {
  put("package.json", JSON.stringify({ dependencies: { "@nestjs/common": "11" } }));
  put("left.service.ts", "export function leftService() {}");
  put("right.service.ts", "export function rightService() {}");
  put("controllers.ts", [
    "import { Controller, Get } from '@nestjs/common';",
    "import { leftService } from './left.service';",
    "import { rightService } from './right.service';",
    "@Controller('left') export class Left {",
    "  @Get() run() { return leftService(); }",
    "}",
    "@Controller('right') export class Right {",
    "  @Get() run() { return rightService(); }",
    "}",
  ].join("\n"));
  await sync();
  for (const [name, other] of [["left", "right"], ["right", "left"]]) {
    const selected = tracer.trace("GET /" + name);
    expect(selected.found).toBe(true);
    const files = selected.chain?.map(node => node.file);
    expect(files).toContain(name + ".service.ts");
    expect(files).not.toContain(other + ".service.ts");
  }
});
