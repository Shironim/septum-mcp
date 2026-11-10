import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/trace-vertical-slice.ts";
import { handleGetDomainCatalog } from "../../src/mcp/tools/get-domain-catalog.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { SEMANTIC_FINGERPRINT } from "../../src/core/parser/semantic-revision.ts";

describe("Goldilocks Context Repairs Suite", () => {
  let tmpDir: string;
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "septum-goldilocks-"));
    db = new SeptumDatabase(join(tmpDir, ".septum/test.db"));
    repo = new SeptumRepository(db.raw);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("A.1 & A.2: retrieveContext defaults to 16 KB budget and avoids 64 KB default bloat", async () => {
    const config = ConfigLoader.getDefaultConfig();
    config.domains = { app: { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src/entry.ts"),
      "export function runEntry(id: string) { return id.toUpperCase(); }\n"
    );
    const pipeline = new IngestionPipeline(repo, tmpDir);
    await pipeline.run(config);

    const result = await handleSymbolTool(repo, config, { action: "context", query: "runEntry", file_path: "src/entry.ts" }, undefined, tmpDir);
    const json = JSON.parse(result.content[0]!.text);
    expect(json.status).toBe("success");
    expect(json.budget_bytes).toBe(16 * 1024); // 16 KB default
  });

  it("B.3: getSymbolDetails omits raw relationships dump by default unless includeDependencies: true is passed", () => {
    const domainId = repo.upsertDomain("core", { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] });
    const fileId = repo.upsertFile(domainId, "src/service.ts", "service", "hash1", 10, Date.now(), 200);
    repo.replaceFileSymbols(fileId, [
      { name: "processJob", kind: "function", signature: "function processJob()", visibility: "public", line_start: 1, line_end: 10, line_count: 10 },
    ]);
    repo.replaceFileDependencies(fileId, [
      { target: "./helper", statement: 'import { helper } from "./helper";', line_number: 1, is_external: false },
    ]);

    // Default inspect (no includeDependencies)
    const defaultDetails = repo.getSymbolDetails("processJob", { workspaceRoot: tmpDir }) as any;
    expect(defaultDetails).toBeDefined();
    expect(defaultDetails.relationships).toBeUndefined(); // Bloat avoided!
    expect(defaultDetails.connected_files).toBeDefined();

    // Explicit includeDependencies: true
    const withDeps = repo.getSymbolDetails("processJob", { workspaceRoot: tmpDir, includeDependencies: true }) as any;
    expect(withDeps).toBeDefined();
    expect(withDeps.relationships).toBeDefined();
  });

  it("C.2: handleTraceVerticalSlice avoids duplicating full payload in metadata", async () => {
    repo.setMeta("semantic_extractor_revision", SEMANTIC_FINGERPRINT);
    const mockConfig = ConfigLoader.getDefaultConfig();
    repo.upsertVerticalSlice({
      domain_id: null,
      feature_key: null,
      http_method: "GET",
      route_uri: "/ping",
      route_name: "ping",
      controller_class: "PingController",
      action_name: "ping",
      controller_file: "src/ping.ts",
      controller_line: 5,
      architecture_style: "mvc",
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify([
        { stage: "ingress", symbol: "GET /ping", file: "src/routes.ts", line: 1 },
      ]),
    });

    const result = await handleTraceVerticalSlice(repo, mockConfig, { query: "GET /ping" }, tmpDir);
    expect(result.content[0].type).toBe("text");
    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("success");

    // Metadata should be a concise summary, NOT the entire duplicate payload with full chain/summary
    const meta = (result as any).metadata;
    expect(meta).toBeDefined();
    expect(meta.status).toBe("success");
    expect(meta.query).toBe("GET /ping");
    expect(meta.chain).toBeUndefined(); // chain is NOT duplicated in metadata
    expect(meta.summary).toBeUndefined(); // summary is NOT duplicated in metadata
  });

  it("D.1 & D.2: getDomainCatalog caps symbols per file to 25 in compact mode and provides lean index_status", () => {
    const domainId = repo.upsertDomain("core", { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] });
    const fileId = repo.upsertFile(domainId, "src/large-schemas.ts", "service", "hash_schema", 500, Date.now(), 5000);

    // Register 40 symbols in one file
    const symbols = Array.from({ length: 40 }, (_, i) => ({
      name: `Schema${i}`,
      kind: "variable" as const,
      signature: `export const Schema${i} = z.object({});`,
      visibility: "public" as const,
      line_start: i * 10 + 1,
      line_end: i * 10 + 8,
      line_count: 8,
    }));
    repo.replaceFileSymbols(fileId, symbols);

    const catalog = repo.domains.getDomainCatalog("core", undefined, { detailLevel: "compact", workspaceRoot: tmpDir });
    expect(catalog).toBeDefined();
    const file = catalog?.files.find((f) => f.path === "src/large-schemas.ts");
    expect(file).toBeDefined();
    expect(file?.symbols.length).toBe(25); // Capped to 25
    expect(file?.symbols_omitted).toBe(15); // 40 - 25 = 15 omitted

    // In full mode, all symbols are included
    const fullCatalog = repo.domains.getDomainCatalog("core", undefined, { detailLevel: "full", workspaceRoot: tmpDir });
    const fullFile = fullCatalog?.files.find((f) => f.path === "src/large-schemas.ts");
    expect(fullFile?.symbols.length).toBe(40);
    expect(fullFile?.symbols_omitted).toBeUndefined();
  });
});
