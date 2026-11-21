import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { handleGetSymbol } from "../../src/mcp/tools/symbol.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/symbol.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";

describe("symbol retrieval evidence parity", () => {
  let root: string, db: SeptumDatabase, repo: SeptumRepository, pipeline: IngestionPipeline;
  const config = ConfigLoader.getDefaultConfig();
  config.domains = { app: { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };
  const target = "export class Target {\n  run() {\n    return 1;\n  }\n}\n";
  const caller = 'import { Target } from "./target";\nexport function invoke(target: Target) { return target.run(); }\n';
  function put(path: string, content: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "septum-symbol-evidence-"));
    db = new SeptumDatabase(":memory:"); repo = new SeptumRepository(db.raw); pipeline = new IngestionPipeline(repo, root);
    put("src/target.ts", target); put("src/caller.ts", caller);
    await pipeline.run(config);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  async function tool(args: Record<string, unknown>, jit?: IngestionPipeline) {
    return JSON.parse((await handleSymbolTool(repo, config, SymbolToolSchema.parse({
      ...(args.action === "inspect" ? { include_source: true } : {}), format: "json", ...args,
    }), jit, root)).content[0]!.text);
  }

  it("shares one content-bound target identity across locate, inspect, impact and context", async () => {
    const located = await tool({ action: "locate", query: "Target::run", file_path: "src/target.ts" });
    const inspected = await tool({ action: "inspect", symbol_ref: located.symbol_ref, include_source: true });
    const impact = await tool({ action: "impact", symbol_ref: located.symbol_ref });
    const context = await tool({ action: "context", symbol_ref: located.symbol_ref });
    for (const result of [located, inspected, impact]) {
      expect(result.retrieval.target_id).toBe(context.target_id);
      expect(result.retrieval.freshness).toBe("current");
      expect(result.retrieval.freshness_scope).toBe("selected_declaration_source_only");
      expect(result.retrieval.source_version.indexed_hash).toBe(located.symbol_ref.indexed_content_hash);
      expect(result.retrieval.source_version.observed_hash).toBe(located.symbol_ref.indexed_content_hash);
      expect(result.retrieval.completeness).toBe("partial");
      expect(result.retrieval.analysis_freshness).toBe("unavailable");
    }
    const raw = await handleSymbolTool(repo, config, SymbolToolSchema.parse({ action: "locate", symbol_ref: located.symbol_ref, format: "json" }), undefined, root);
    expect((raw as any).metadata.retrieval).toEqual(JSON.parse(raw.content[0]!.text).retrieval);
    expect(await tool({ action: "inspect", symbol_ref: located.symbol_ref, include_source: true })).toEqual(inspected);
  });

  it("labels stale and deleted target sources consistently without promoting indexed coordinates", async () => {
    put("src/target.ts", target.replace("return 1", "return 2"));
    for (const action of ["locate", "inspect", "impact"]) {
      const result = await tool({ action, query: "Target::run", file_path: "src/target.ts", ...(action === "inspect" ? { include_source: true } : {}) });
      expect(result.retrieval.freshness).toBe("stale");
      expect(result.retrieval.reasons).toContain("target_source_differs_from_index");
      if (action === "inspect") expect(result.source_slice.text).toBeUndefined();
      if (action === "locate") expect(result.summary).toContain("SOURCE STALE");
    }
    rmSync(join(root, "src/target.ts"));
    for (const action of ["locate", "inspect", "impact"]) {
      expect((await tool({ action, query: "Target::run", file_path: "src/target.ts" })).retrieval.freshness).toBe("unavailable");
    }
  });

  it("does not bind an ambiguous, missing or stale reference to a selected target", async () => {
    const located = await tool({ action: "locate", query: "Target::run", file_path: "src/target.ts" });
    put("src/other.ts", target);
    await pipeline.run(config);
    for (const action of ["locate", "inspect", "impact"]) {
      const ambiguous = await tool({ action, query: "Target::run" });
      expect(ambiguous.retrieval.target_id).toBeNull();
      expect(ambiguous.retrieval.reasons).toContain("target_ambiguous");
      if (action === "locate") expect(ambiguous.summary).toContain("[AMBIGUOUS]");
      expect((await tool({ action, query: "doesNotExist" })).retrieval.target_id).toBeNull();
    }
    put("src/target.ts", "// moved\n" + target); await pipeline.run(config);
    for (const action of ["locate", "inspect", "impact"]) {
      const stale = await tool({ action, symbol_ref: located.symbol_ref });
      expect(stale.retrieval.target_id).toBeNull();
      expect(stale.retrieval.requested_target_id).toBe(located.retrieval.target_id);
      expect(stale.retrieval.reasons).toContain("stale_reference");
      if (action === "locate") expect(stale.summary).toContain("[STALE REFERENCE]");
    }
  });

  it("makes failed JIT refresh visible while preserving indexed lookup recovery", async () => {
    put("src/target.ts", target.replace("return 1", "return 2"));
    const jit = { ingestFile: async () => { throw new Error("fixture refresh failed"); } } as unknown as IngestionPipeline;
    const result = await tool({ action: "locate", query: "Target::run", file_path: "src/target.ts" }, jit);
    expect(result.found).toBe(true);
    expect(result.retrieval.freshness).toBe("stale");
    expect(result.retrieval.reasons).toContain("target_index_refresh_failed");
  });

  it("keeps current target freshness separate from stale caller analysis", async () => {
    put("src/caller.ts", "// shifted caller\n" + caller);
    const result = await tool({ action: "impact", query: "Target::run", file_path: "src/target.ts" });
    expect(result.retrieval.freshness).toBe("current");
    expect(result.retrieval.analysis_freshness).toBe("unavailable");
    expect(result.retrieval.observed_inputs.stale_indexed_files).toBeGreaterThan(0);
    expect(result.retrieval.reasons).toContain("observed_indexed_inputs_stale");
    rmSync(join(root, "src/caller.ts"));
    const missing = await tool({ action: "impact", query: "Target::run", file_path: "src/target.ts" });
    expect(missing.retrieval.freshness).toBe("current");
    expect(missing.retrieval.observed_inputs.unavailable_indexed_files).toBeGreaterThan(0);
    expect(missing.retrieval.reasons).toContain("observed_indexed_inputs_unavailable");
  });

  it("rejects source mutation after inspect inference and before returning its evidence", () => {
    const original = repo.getSymbolDetails.bind(repo);
    const intercepted = spyOn(repo, "getSymbolDetails").mockImplementation((...args) => {
      const result = original(...args); put("src/target.ts", target.replace("return 1", "return 2")); return result;
    });
    try {
      expect(() => handleGetSymbol(repo, config, { symbol: "Target::run", file_path: "src/target.ts", include_dependencies: true }, root))
        .toThrow("Source changed during synchronization:");
    } finally { intercepted.mockRestore(); }
  });

  it("rejects caller mutation after impact inference even when the selected source is unchanged", () => {
    const original = repo.getSymbolImpact.bind(repo);
    const intercepted = spyOn(repo, "getSymbolImpact").mockImplementation((...args) => {
      const result = original(...args); put("src/caller.ts", "// shifted\n" + caller); return result;
    });
    try {
      expect(() => handleGetSymbolImpact(repo, config, { symbol: "Target::run", file_path: "src/target.ts" }, root))
        .toThrow("Source changed during synchronization:");
    } finally { intercepted.mockRestore(); }
  });

  it("reports incomplete index state without conflating it with target source freshness", async () => {
    repo.setMeta("sync_state", "error");
    for (const action of ["locate", "inspect", "impact"]) {
      const result = await tool({ action, query: "Target::run", file_path: "src/target.ts" });
      expect(result.retrieval.freshness).toBe("current");
      expect(result.retrieval.completeness).toBe("partial");
      expect(result.retrieval.reasons).toContain("index_completeness_unverified");
    }
  });
});
