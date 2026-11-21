import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";
import { handleLocateSymbol } from "../../src/mcp/tools/symbol.ts";
import { handleGetSymbol } from "../../src/mcp/tools/symbol.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { evaluateBoundary } from "../../src/mcp/tools/boundary.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";

describe("Batch 3 regressions: locate limit, file_path-only locate, and compact include_source=false", () => {
  it("does not copy file_path into query in SymbolToolSchema", () => {
    const parsed = SymbolToolSchema.parse({
      action: "locate",
      file_path: "apps/api/internal/invoice/service.go",
      limit: 5,
    });
    expect(parsed.query).toBeUndefined();
    expect(parsed.file_path).toBe("apps/api/internal/invoice/service.go");
  });

  it("enforces limit on ambiguous candidates and lists declarations when locate is called with file_path only", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-b3-locate-"));
    try {
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = {
        version: "1.0",
        settings: { enforcement: "strict", db_path: ":memory:", ignore_patterns: [] },
        domains: { app: { root: "app", description: "App", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
      } as ValidatedSeptumConfig;

      const domainId = repo.upsertDomain("app", config.domains.app);
      for (let i = 1; i <= 5; i++) {
        const rel = `app/Controller${i}.php`;
        const abs = join(root, rel);
        mkdirSync(join(root, "app"), { recursive: true });
        writeFileSync(abs, `<?php\nclass Controller${i} { public function store() {} public function index() {} }\n`);
        const fileId = repo.upsertFile(domainId, rel, "controller", `hash-${i}`, 2, Date.now(), 80);
        repo.replaceFileSymbols(fileId, [
          { name: "store", kind: "method", signature: "public function store()", line_start: 2, line_end: 2, is_exported: true, visibility: "public" },
          { name: "index", kind: "method", signature: "public function index()", line_start: 2, line_end: 2, is_exported: true, visibility: "public" },
        ]);
      }

      const limited = await handleLocateSymbol(repo, config, { query: "store", limit: 2 , format: "json"}, undefined, root);
      const limitedPayload = JSON.parse(limited.content[0]!.text);
      expect(limitedPayload.status).toBe("ambiguous");
      expect(limitedPayload.candidates).toHaveLength(2);
      expect(limitedPayload.total_candidates).toBe(5);
      expect(limitedPayload.omitted_candidates).toBe(3);

      const byFile = await handleLocateSymbol(repo, config, { file_path: "app/Controller1.php", limit: 1 , format: "json"}, undefined, root);
      const byFilePayload = JSON.parse(byFile.content[0]!.text);
      expect(byFilePayload.status).toBe("success");
      expect(byFilePayload.candidates).toHaveLength(1);
      expect(byFilePayload.total_candidates).toBe(2);
      expect(byFilePayload.omitted_candidates).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compacts relationships and caps connected_files when include_source is false", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-b3-ctx-"));
    try {
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = {
        version: "1.0",
        settings: { enforcement: "strict", db_path: ":memory:", ignore_patterns: [] },
        domains: { api: { root: "api", description: "API", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
      } as ValidatedSeptumConfig;

      const domainId = repo.upsertDomain("api", config.domains.api);
      mkdirSync(join(root, "api"), { recursive: true });
      writeFileSync(join(root, "api/service.go"), "package api\nfunc Run() {}\n");
      const fileId = repo.upsertFile(domainId, "api/service.go", "service", "hash-s", 2, Date.now(), 25);
      repo.replaceFileSymbols(fileId, [
        { name: "Run", kind: "function", signature: "func Run()", line_start: 2, line_end: 2, is_exported: true, visibility: "public" },
      ]);
      const deps = Array.from({ length: 25 }, (_, i) => ({
        target: `fmt${i}`,
        statement: `import "fmt${i}"`,
        is_external: true,
        line_number: i + 1,
      }));
      repo.replaceFileDependencies(fileId, deps);

      const res = await handleGetSymbol(repo, config, { symbol: "Run", file_path: "api/service.go", include_source: false, include_dependencies: true , format: "json"}, root);
      const payload = JSON.parse(res.content[0]!.text);
      expect(payload.relationships.length).toBeLessThanOrEqual(20);
      expect(payload.relationships_omitted).toBe(5);
      expect(res.content[0]!.text.length).toBeLessThan(6144);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns status unknown instead of approved when scoped domain has 0 indexed files", async () => {
    const db = new SeptumDatabase(":memory:");
    const repo = new SeptumRepository(db.raw);
    const config = {
      version: "1.0",
      settings: { enforcement: "strict", db_path: ":memory:", ignore_patterns: [] },
      domains: {
        app: { root: "app", description: "App", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        http: { root: "app/Http", description: "Http", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      },
    } as ValidatedSeptumConfig;

    const appId = repo.upsertDomain("app", config.domains.app);
    repo.upsertDomain("http", config.domains.http);
    repo.upsertFile(appId, "app/Services/SaleService.php", "service", "hash-1", 10, Date.now(), 100);
    repo.setMeta("sync_state", "complete");

    const evaluator = new BoundaryEvaluator(repo);
    const res = await evaluateBoundary(evaluator, config, { scope: "domain", domain: "http" , format: "json"}, repo, process.cwd());
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.status).toBe("unknown");
  });
});
