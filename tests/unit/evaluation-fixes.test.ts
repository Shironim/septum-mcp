import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { handleGetDomainCatalog } from "../../src/mcp/tools/map.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/symbol.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/boundary.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/slice.ts";

async function withFixture(
  domains: Record<string, { root: string; allowed_dependencies: string[]; forbidden_dependencies: string[]; archetypes: Record<string, string> }>,
  run: (
    root: string,
    repo: SeptumRepository,
    config: ReturnType<typeof ConfigLoader.getDefaultConfig>,
    put: (p: string, s: string) => void
  ) => Promise<void>
) {
  const root = mkdtempSync(join(tmpdir(), "septum-eval-fixes-"));
  const db = new SeptumDatabase(":memory:");
  const config = ConfigLoader.getDefaultConfig();
  config.domains = domains;
  const put = (p: string, s: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), s);
  };
  try {
    await run(root, new SeptumRepository(db.raw), config, put);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Evaluation Fixes Regression Suite", () => {
  test("getFileInboundImpact does not falsely match 'server.ts' as a consumer of 'serve.ts'", () =>
    withFixture(
      {
        cli: { root: "src/cli", allowed_dependencies: ["mcp"], forbidden_dependencies: [], archetypes: {} },
        mcp: { root: "src/mcp", allowed_dependencies: [], forbidden_dependencies: ["cli"], archetypes: {} },
      },
      async (root, repo, config, put) => {
        put("src/mcp/server.ts", "export function startServer() { return 1; }\n");
        put("src/cli/serve.ts", "import { startServer } from '../mcp/server.ts';\nexport function runServe() { return startServer(); }\n");
        put("src/cli/index.ts", "import { runServe } from './serve.ts';\nexport function main() { return runServe(); }\n");
        await new IngestionPipeline(repo, root).run(config);

        const impact = repo.getFileInboundImpact("src/cli/serve.ts");
        expect(impact.top_consumers).toEqual(["src/cli/index.ts"]);
        expect(impact.top_consumers).not.toContain("src/mcp/server.ts");
      }
    ));

  test("check-boundary exposes enforcement_mode and clarifies warn mode approval", () =>
    withFixture(
      {
        cli: { root: "src/cli", allowed_dependencies: ["core"], forbidden_dependencies: [], archetypes: {} },
        mcp: { root: "src/mcp", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      },
      async (root, repo, config, put) => {
        config.settings.enforcement = "warn";
        put("src/cli/serve.ts", "export const x = 1;\n");
        put("src/mcp/server.ts", "export const y = 2;\n");
        await new IngestionPipeline(repo, root).run(config);

        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const res = await handleCheckBoundary(
          evaluator,
          config,
          { file_path: "src/cli/serve.ts", proposed_imports: ["../mcp/server.ts"] , format: "json"},
          repo,
          root
        );
        const json = JSON.parse(res.content[0]!.text);
        expect(json.status).toBe("approved");
        expect(json.enforcement_mode).toBe("warn");
        expect(json.message).toContain("warn");
      }
    ));

  test("impact detects class instantiation/heritage, preserves method call_sites, and hoists resolution_metadata", () =>
    withFixture(
      {
        app: { root: "src/app", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      },
      async (root, repo, config, put) => {
        put(
          "src/app/engine.ts",
          "export class Engine {\n  public run() { return 1; }\n}\n"
        );
        put(
          "src/app/consumer.ts",
          "import { Engine } from './engine.ts';\nexport class SubEngine extends Engine {}\nexport function boot() {\n  const e = new Engine();\n  return e.run();\n}\n"
        );
        await new IngestionPipeline(repo, root).run(config);

        const classImpact = JSON.parse(
          handleGetSymbolImpact(repo, config, { symbol: "Engine" , format: "json"}, root).content[0]!.text
        );
        expect(classImpact.call_sites.some((c: any) => c.kind === "instantiation")).toBe(true);
        expect(classImpact.call_sites.some((c: any) => c.kind === "heritage")).toBe(true);
        expect(classImpact.resolution_metadata).toBeDefined();
        expect(classImpact.import_dependents[0].resolution.config_revision).toBeUndefined();

        const methodImpact = JSON.parse(
          handleGetSymbolImpact(repo, config, { symbol: "Engine::run" , format: "json"}, root).content[0]!.text
        );
        expect(methodImpact.call_sites.some((c: any) => c.kind === "call" && c.caller === "boot")).toBe(true);
      }
    ));

  test("septum_map domain compact mode omits intra-domain edges while preserving accounting", () =>
    withFixture(
      {
        app: { root: "src/app", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        shared: { root: "src/shared", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      },
      async (root, repo, config, put) => {
        put("src/shared/util.ts", "export const u = 1;\n");
        put("src/app/a.ts", "export const a = 1;\n");
        put("src/app/b.ts", "import { a } from './a.ts';\nimport { u } from '../shared/util.ts';\nexport const b = a + u;\n");
        await new IngestionPipeline(repo, root).run(config);

        const compact = JSON.parse(
          handleGetDomainCatalog(repo, config, { domain: "app", detail_level: "compact" , format: "json"}, root).content[0]!.text
        );
        expect(compact.dependencies.every((e: any) => !e.from.startsWith("src/app/") || !e.to.startsWith("src/app/"))).toBe(true);
        expect(compact.accounting.total_dependencies).toBe(2);
        expect(compact.accounting.returned_dependencies).toBe(1);
        expect(compact.accounting.omitted_dependencies).toBe(1);

        const full = JSON.parse(
          handleGetDomainCatalog(repo, config, { domain: "app", detail_level: "full" , format: "json"}, root).content[0]!.text
        );
        expect(full.dependencies.length).toBe(2);
      }
    ));

  test("septum_slice Option A stops at 1-hop direct dependencies without pulling transitive utilities", () =>
    withFixture(
      {
        mcp: { root: "src/mcp", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      },
      async (root, repo, config, put) => {
        put("src/mcp/deep-util.ts", "export function deepHelper() { return 42; }\n");
        put("src/mcp/service.ts", "import { deepHelper } from './deep-util.ts';\nexport function runService() { return deepHelper(); }\n");
        put("src/mcp/handler.ts", "import { runService } from './service.ts';\nexport function handleEntry() { return runService(); }\n");
        await new IngestionPipeline(repo, root).run(config);

        repo.upsertVerticalSlice({
          domain_id: null,
          feature_key: null,
          http_method: "MCP",
          route_uri: "tool:test_entry",
          route_name: "test_entry",
          controller_class: "handler",
          action_name: "handleEntry",
          controller_file: "src/mcp/handler.ts",
          controller_line: 2,
          architecture_style: "rpc",
          entry_kind: "mcp_tool",
          execution_chain_json: JSON.stringify([
            { stage: "ingress", symbol: "tool:test_entry", file: "src/mcp/handler.ts", line: 2 },
            { stage: "controller", symbol: "handleEntry", file: "src/mcp/handler.ts", line: 2 },
          ]),
        });

        const res = await handleTraceVerticalSlice(repo, config, { query: "MCP tool:test_entry", max_depth: 5 , format: "json"}, root);
        const json = JSON.parse(res.content[0]!.text);
        const symbols = json.chain.map((n: any) => n.symbol);
        expect(symbols).toContain("runService");
        expect(symbols).not.toContain("deepHelper");
        expect(json.message).not.toContain("runService");
      }
    ));
});
