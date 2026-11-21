import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { handleRegisterDomain } from "../../src/mcp/tools/map.ts";
import { handleGetDomainCatalog } from "../../src/mcp/tools/map.ts";
import { PARSER_FINGERPRINT } from "../../src/core/parser/language-capabilities.ts";
import { SEMANTIC_FINGERPRINT } from "../../src/core/parser/semantic-revision.ts";

describe("index cache lifecycle", () => {
  let root: string, db: SeptumDatabase, repo: SeptumRepository, pipeline: IngestionPipeline;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "septum-cache-regression-"));
    mkdirSync(join(root, "src"));
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    pipeline = new IngestionPipeline(repo, root);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("rebuilds older parser and semantic facts even when source bytes are unchanged", async () => {
    const config = ConfigLoader.getDefaultConfig();
    config.domains = { app: { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };
    writeFileSync(join(root, "requirements.txt"), "fastapi\n");
    writeFileSync(join(root, "src/orders.ts"), "export namespace Billing { export class Order { save() {} } }");
    writeFileSync(join(root, "src/api.py"), 'app = FastAPI()\n@app.get("/static")\ndef handler(): pass\n');
    await pipeline.run(config);
    const file = repo.getFileByPath("src/orders.ts")!;
    repo.replaceFileSymbols(file.id, []);
    repo.upsertVerticalSlice({
      domain_id: file.domain_id, feature_key: null, http_method: "GET", route_uri: "/poison",
      route_name: null, controller_class: "api", action_name: "handler",
      controller_file: "src/api.py", controller_line: 3, architecture_style: "fastapi",
      entry_kind: "http_route", execution_chain_json: "[]",
    });
    repo.setMeta("parser_revision", "5");
    repo.setMeta("semantic_extractor_revision", "7-inputs-previous");
    await pipeline.run(config);
    expect(repo.getMeta("parser_revision")).toBe(PARSER_FINGERPRINT);
    expect(repo.getMeta("semantic_extractor_revision")).toBe(SEMANTIC_FINGERPRINT);
    expect(repo.getSymbolsByFileId(file.id).map(s => s.name)).toContain("Billing::Order::save");
    expect(repo.getAllVerticalSlices().map(s => s.route_uri)).toEqual(["/static"]);
    expect((await pipeline.run(config)).files_updated).toBe(0);
  });

  it("refreshes symbols and imports when content changes with identical size and mtime", async () => {
    const config = ConfigLoader.getDefaultConfig();
    config.domains = { app: { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };
    const file = join(root, "src/a.ts"), time = 1700000000;
    writeFileSync(file, "import './old'; export function before() {}\n");
    utimesSync(file, time, time);
    await pipeline.run(config);
    writeFileSync(file, "import './new'; export function after_() {}\n");
    utimesSync(file, time, time);
    const result = await pipeline.run(config);
    const indexed = repo.getFileByPath("src/a.ts")!;
    expect(result.files_updated).toBe(1);
    expect(repo.getSymbolsByFileId(indexed.id).map(symbol => symbol.name)).toContain("after_");
    expect(repo.getSymbolsByFileId(indexed.id).map(symbol => symbol.name)).not.toContain("before");
    expect(repo.getAllDependenciesWithDomains().map(dependency => dependency.target)).toContain("./new");
    expect(repo.getAllDependenciesWithDomains().map(dependency => dependency.target)).not.toContain("./old");
    expect(repo.getMeta("sync_state")).toBe("complete");
    expect((await pipeline.run(config)).files_updated).toBe(0);
  });

  it("updates and clears archetype mappings through registration without losing symbols", async () => {
    const config = ConfigLoader.getDefaultConfig();
    writeFileSync(join(root, "src/a.ts"), "export function alpha() {}\n");
    await handleRegisterDomain(repo, config, { domain: "app", root: "src", ingest_now: true }, root);
    const file = repo.getFileByPath("src/a.ts")!;
    expect(file.archetype).toBe("unknown");
    await handleRegisterDomain(repo, config, { domain: "app", root: "src", archetypes: { controller: "src/*.ts" }, ingest_now: true }, root);
    const catalog = handleGetDomainCatalog(repo, config, { domain: "app", archetype_filter: "controller" , format: "json"}, root);
    expect(JSON.parse(catalog.content[0].text).files.map((entry: { path: string }) => entry.path)).toEqual(["src/a.ts"]);
    expect(repo.getSymbolsByFileId(file.id).map(symbol => symbol.name)).toContain("alpha");
    expect((await pipeline.run(config, { verifyContent: true })).files_updated).toBe(0);
    config.domains.app.archetypes = { service: "src/*.ts" };
    expect(await pipeline.ingestFile(join(root, "src/a.ts"), config)).toBe(false);
    expect(repo.getFileByPath("src/a.ts")?.archetype).toBe("service");
    await handleRegisterDomain(repo, config, { domain: "app", root: "src", archetypes: {}, ingest_now: true }, root);
    expect(repo.getFileByPath("src/a.ts")?.archetype).toBe("unknown");
  });
});
