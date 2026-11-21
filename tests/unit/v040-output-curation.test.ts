import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { calculateSimilarity } from "../../src/core/resolver/symbol-locator.ts";
import { selectSliceTarget } from "../../src/core/resolver/slice-selection.ts";
import { handleMapTool } from "../../src/mcp/tools/map.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { handleSliceTool } from "../../src/mcp/tools/slice.ts";
import { handleBoundaryTool } from "../../src/mcp/tools/boundary.ts";
import {
  BoundaryToolSchema,
  MapToolSchema,
  SliceToolSchema,
  SymbolToolSchema,
} from "../../src/mcp/schemas.ts";

function createTempRepo() {
  const root = mkdtempSync(join(tmpdir(), "septum-v040-"));
  const db = new SeptumDatabase(":memory:");
  const repo = new SeptumRepository(db.raw);
  const pipeline = new IngestionPipeline(repo, root);
  const put = (rel: string, content: string) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  };
  return { root, db, repo, pipeline, put, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("v0.4.0 output curation and text-first architecture", () => {
  it("defaults format to 'text' across all 4 MCP tool schemas while allowing explicit 'json'", () => {
    expect(MapToolSchema.parse({}).format).toBe("text");
    expect(SymbolToolSchema.parse({ query: "Foo" }).format).toBe("text");
    expect(SliceToolSchema.parse({ query: "GET /health" }).format).toBe("text");
    expect(BoundaryToolSchema.parse({ scope: "all" }).format).toBe("text");

    expect(MapToolSchema.parse({ format: "json" }).format).toBe("json");
    expect(SymbolToolSchema.parse({ query: "Foo", format: "json" }).format).toBe("json");
    expect(SliceToolSchema.parse({ query: "GET /health", format: "json" }).format).toBe("json");
    expect(BoundaryToolSchema.parse({ scope: "all", format: "json" }).format).toBe("json");
  });

  it("ranks camelCase word-boundary token matches above Levenshtein noise in locate", () => {
    const exactToken1 = calculateSimilarity("Store", "SymbolDetailsStore");
    const exactToken2 = calculateSimilarity("Store", "DependencyQueryStore");
    const noise1 = calculateSimilarity("Store", "Scope");
    const noise2 = calculateSimilarity("Store", "ancestors");
    const noise3 = calculateSimilarity("Store", "close");

    expect(exactToken1).toBeGreaterThan(noise1);
    expect(exactToken2).toBeGreaterThan(noise1);
    expect(exactToken1).toBeGreaterThan(noise2);
    expect(exactToken2).toBeGreaterThan(noise3);
  });

  it("returns exact confidence for MCP and CLI omni-trigger queries in selectSliceTarget", () => {
    const records: any[] = [
      {
        id: 1,
        domain_id: 1,
        feature_key: "mcp:tool:septum_symbol",
        http_method: "MCP",
        route_uri: "tool:septum_symbol",
        route_name: "septum_symbol",
        controller_class: "symbol",
        action_name: "handleSymbolTool",
        controller_file: "src/mcp/tools/symbol.ts",
        controller_line: 17,
        architecture_style: "rpc",
        entry_kind: "mcp_tool",
        execution_chain_json: "[]",
        created_at: "",
      },
      {
        id: 2,
        domain_id: 1,
        feature_key: "cli:command:check",
        http_method: "CLI",
        route_uri: "command:check",
        route_name: "check",
        controller_class: "check",
        action_name: "handleCheckCommand",
        controller_file: "src/cli/commands/check.ts",
        controller_line: 10,
        architecture_style: "cli",
        entry_kind: "cli_command",
        execution_chain_json: "[]",
        created_at: "",
      },
    ];

    const mcpMatch = selectSliceTarget(records, "MCP tool:septum_symbol", 5) as any;
    expect(mcpMatch.confidence).toBe("exact");
    expect(mcpMatch.record.action_name).toBe("handleSymbolTool");

    const cliMatch = selectSliceTarget(records, "CLI command:check", 5) as any;
    expect(cliMatch.confidence).toBe("exact");
    expect(cliMatch.record.action_name).toBe("handleCheckCommand");
  });

  it("separates runtime_imports from type_only_imports in impact and renders compact text by default", async () => {
    const fx = createTempRepo();
    try {
      fx.put("package.json", JSON.stringify({ name: "impact-fixture", type: "module" }));
      fx.put("src/core/repo.ts", "export class CoreRepo {\n  find() { return 1; }\n}\n");
      fx.put("src/app/runtime-user.ts", 'import { CoreRepo } from "../core/repo.ts";\nexport function make() { return new CoreRepo(); }\n');
      fx.put("src/app/type-user.ts", 'import type { CoreRepo } from "../core/repo.ts";\nexport function accept(r: CoreRepo) { return r; }\n');

      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: ["app"], archetypes: {} },
          app: { root: "src/app", allowed_dependencies: ["core"], forbidden_dependencies: [], archetypes: {} },
        },
      };
      await fx.pipeline.run(config);

      // Default text format
      const textRes = await handleSymbolTool(fx.repo, config, SymbolToolSchema.parse({ action: "impact", query: "CoreRepo" }), undefined, fx.root);
      const text = textRes.content[0]!.text;
      expect(text).toContain("# Septum Impact: CoreRepo");
      expect(text).toContain("Runtime imports: 1");
      expect(text).toContain("Type-only imports: 1");
      expect(text).toContain("## Runtime Imports (1)");
      expect(text).toContain("## Type-Only Imports (1)");

      // Explicit JSON format
      const jsonRes = await handleSymbolTool(fx.repo, config, SymbolToolSchema.parse({ action: "impact", query: "CoreRepo", format: "json" }), undefined, fx.root);
      const payload = JSON.parse(jsonRes.content[0]!.text);
      expect(payload.runtime_imports).toHaveLength(1);
      expect(payload.runtime_imports[0].file).toBe("src/app/runtime-user.ts");
      expect(payload.type_only_imports).toHaveLength(1);
      expect(payload.type_only_imports[0].file).toBe("src/app/type-user.ts");
      expect(payload.impact_summary.runtime_imports_count).toBe(1);
      expect(payload.impact_summary.type_only_imports_count).toBe(1);

      // Default text format on boundary & map
      const evaluator = new BoundaryEvaluator(fx.repo, new ModuleResolver(fx.root, fx.repo));
      const boundaryText = (await handleBoundaryTool(evaluator, config, BoundaryToolSchema.parse({ scope: "all" }), fx.repo, fx.root)).content[0]!.text;
      expect(boundaryText).toContain("# Septum Boundary: all [approved]");

      const mapText = (await handleMapTool(fx.repo, config, MapToolSchema.parse({}), fx.root)).content[0]!.text;
      expect(mapText).toContain("# Septum Map: workspace [success]");
    } finally {
      fx.cleanup();
    }
  });

  it("ranks hop-1 direct imported callees ahead of hop-2 transitive local helpers in deep context", async () => {
    const fx = createTempRepo();
    try {
      fx.put("package.json", JSON.stringify({ name: "hop-fixture", type: "module" }));
      fx.put("src/core/helper.ts", "export function directImportedCallee(x: number) { return x + 1; }\n");
      fx.put(
        "src/core/entry.ts",
        [
          'import { directImportedCallee } from "./helper.ts";',
          "export function entryPoint(x: number) {",
          "  const a = directImportedCallee(x);",
          "  return localHop1(a);",
          "}",
          "function localHop1(x: number) {",
          "  return localHop2(x);",
          "}",
          "function localHop2(x: number) {",
          "  return x * 2;",
          "}",
        ].join("\n")
      );
      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: { core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
      };
      await fx.pipeline.run(config);

      const jsonRes = await handleSymbolTool(
        fx.repo,
        config,
        SymbolToolSchema.parse({ action: "context", context_mode: "deep", query: "entryPoint", file_path: "src/core/entry.ts", format: "json" }),
        undefined,
        fx.root
      );
      const payload = JSON.parse(jsonRes.content[0]!.text);
      const sourceItems = payload.items.filter((i: any) => i.kind === "source");
      const names = sourceItems.map((i: any) => i.name);
      const idxImported = names.indexOf("directImportedCallee");
      const idxLocal1 = names.indexOf("localHop1");
      const idxLocal2 = names.indexOf("localHop2");

      expect(idxImported).toBeGreaterThan(0);
      expect(idxLocal1).toBeGreaterThan(0);
      expect(idxLocal2).toBeGreaterThan(idxImported);
      expect(idxLocal2).toBeGreaterThan(idxLocal1);

      // Default text format for deep context
      const textRes = await handleSymbolTool(
        fx.repo,
        config,
        SymbolToolSchema.parse({ action: "context", context_mode: "deep", query: "entryPoint", file_path: "src/core/entry.ts" }),
        undefined,
        fx.root
      );
      expect(textRes.content[0]!.text).toContain("# Septum Deep Context: entryPoint");
      expect(textRes.content[0]!.text).toContain("[hop=1] directImportedCallee");
    } finally {
      fx.cleanup();
    }
  });

  it("aggregates cross-domain dependencies by submodule in large domains (>25 files)", async () => {
    const fx = createTempRepo();
    try {
      fx.put("package.json", JSON.stringify({ name: "submod-fixture", type: "module" }));
      fx.put("src/types/shared.ts", "export type SharedId = string;\n");
      for (let i = 0; i < 16; i++) {
        fx.put(`src/core/parser/p${i}.ts`, `import type { SharedId } from "../../types/shared.ts";\nexport function parse${i}(id: SharedId) { return id; }\n`);
      }
      for (let i = 0; i < 12; i++) {
        fx.put(`src/core/resolver/r${i}.ts`, `import type { SharedId } from "../../types/shared.ts";\nexport function resolve${i}(id: SharedId) { return id; }\n`);
      }
      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: {
          core: { root: "src/core", allowed_dependencies: ["types"], forbidden_dependencies: [], archetypes: {} },
          types: { root: "src/types", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        },
      };
      await fx.pipeline.run(config);

      const jsonRes = await handleMapTool(fx.repo, config, MapToolSchema.parse({ domain: "core", format: "json" }), fx.root);
      const nav = JSON.parse(jsonRes.content[0]!.text);
      expect(nav.submodules).toHaveLength(2);
      // Aggregated into 2 submodule->domain edges instead of 28 raw file-to-file edges
      expect(nav.dependencies).toEqual([
        { from: "src/core/parser", to: "types", relation: "imports", count: 16 },
        { from: "src/core/resolver", to: "types", relation: "imports", count: 12 },
      ]);

      const textRes = await handleMapTool(fx.repo, config, MapToolSchema.parse({ domain: "core" }), fx.root);
      expect(textRes.content[0]!.text).toContain("## Dependencies (aggregated by submodule, 2 groups)");
      expect(textRes.content[0]!.text).toContain("- src/core/parser -> types x16");
    } finally {
      fx.cleanup();
    }
  });
});
