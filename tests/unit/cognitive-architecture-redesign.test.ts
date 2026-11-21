import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { buildNavigation } from "../../src/core/discovery/navigation.ts";
import { detectArchetype } from "../../src/core/parser/extractors/base.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { handleMapTool } from "../../src/mcp/tools/map.ts";
import { handleSliceTool } from "../../src/mcp/tools/slice.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { MapToolSchema } from "../../src/mcp/schemas/map.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";

const tempDirs: string[] = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "septum-cognitive-"));
  tempDirs.push(root);
  const db = new SeptumDatabase(":memory:");
  const repo = new SeptumRepository(db.raw);
  const pipeline = new IngestionPipeline(repo, root);
  const put = (relPath: string, content: string) => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  return { root, db, repo, pipeline, put };
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Cognitive Architecture Redesign", () => {
  it("Pillar 1: ranks depth-0/1 direct calls and contracts ahead of tiny depth-2 transitive helpers and defaults max_depth to 2", async () => {
    const { root, db, repo, pipeline, put } = createFixture();
    try {
      put("package.json", JSON.stringify({ name: "fixture", type: "module" }));
      put(
        "src/core/deep-util.ts",
        [
          "export const TINY_FLAG = true;",
          "export function deepLeaf() { return TINY_FLAG ? 1 : 0; }",
        ].join("\n")
      );
      put(
        "src/core/service.ts",
        [
          'import { deepLeaf } from "./deep-util.ts";',
          "export interface CoreRequest { id: string; force?: boolean; }",
          "export function executeCoreAction(req: CoreRequest): number {",
          "  const step1 = req.id.trim().length;",
          "  const step2 = req.force ? 10 : 5;",
          "  const step3 = step1 + step2;",
          "  const step4 = step3 * 2;",
          "  return step4 + deepLeaf();",
          "}",
        ].join("\n")
      );
      put(
        "src/mcp/handler.ts",
        [
          'import { executeCoreAction, type CoreRequest } from "../core/service.ts";',
          "export interface HandlerInput { req: CoreRequest; }",
          "export function handleAction(input: HandlerInput): number {",
          "  return executeCoreAction(input.req);",
          "}",
        ].join("\n")
      );

      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
          mcp: { root: "src/mcp", allowed_dependencies: ["core"], forbidden_dependencies: [], archetypes: {} },
        },
      };
      await pipeline.run(config);

      const res = await handleSymbolTool(
        repo,
        config,
        { action: "context", context_mode: "deep", query: "handleAction", file_path: "src/mcp/handler.ts", include_dependencies: true , format: "json"},
        pipeline,
        root
      );
      const payload = JSON.parse(res.content[0]!.text);
      expect(payload.dependency_depth).toBe(2);

      const sourceItems = payload.items.filter((i: any) => i.kind === "source");
      const names = sourceItems.map((i: any) => i.name);
      // Target first, then depth-0 contract, then depth-1 direct call/contract, BEFORE depth-2 tiny helper/constant
      expect(names[0]).toBe("handleAction");
      expect(names.indexOf("HandlerInput")).toBeLessThan(names.indexOf("deepLeaf"));
      expect(names.indexOf("executeCoreAction")).toBeLessThan(names.indexOf("deepLeaf"));
      expect(sourceItems.every((i: any) => typeof i.depth === "number")).toBe(true);

      // max_depth: 1 stops before depth-2 transitive imports
      const resDepth1 = await handleSymbolTool(
        repo,
        config,
        { action: "context", context_mode: "deep", query: "handleAction", file_path: "src/mcp/handler.ts", max_depth: 1, include_dependencies: true , format: "json"},
        pipeline,
        root
      );
      const payloadDepth1 = JSON.parse(resDepth1.content[0]!.text);
      expect(payloadDepth1.dependency_depth).toBe(1);
      const depth1Names = payloadDepth1.items.filter((i: any) => i.kind === "source").map((i: any) => i.name);
      expect(depth1Names).toContain("executeCoreAction");
      expect(depth1Names).not.toContain("deepLeaf");
    } finally {
      db.close();
    }
  });

  it("Pillar 2: bridges same-file local helper calls in septum_slice AST call graph", async () => {
    const { root, db, repo, pipeline, put } = createFixture();
    try {
      put("package.json", JSON.stringify({ name: "fixture", type: "module" }));
      put(
        "src/core/audit.ts",
        "export function runCoreAudit(target: string) { return { ok: Boolean(target) }; }\n"
      );
      put(
        "src/mcp/boundary.ts",
        [
          'import { runCoreAudit } from "../core/audit.ts";',
          "export function handleBoundary(target: string) {",
          "  return delegateBoundary(target);",
          "}",
          "function delegateBoundary(target: string) {",
          "  return runCoreAudit(target);",
          "}",
        ].join("\n")
      );

      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
          mcp: { root: "src/mcp", allowed_dependencies: ["core"], forbidden_dependencies: [], archetypes: {} },
        },
      };
      await pipeline.run(config);

      // Seed a static MCP entrypoint slice pointing at the thin wrapper handleBoundary
      const mcpDomain = repo.getDomainByName("mcp")!;
      repo.upsertVerticalSlice({
        domain_id: mcpDomain.id,
        feature_key: "mcp:tool:check",
        http_method: "MCP",
        route_uri: "tool:check",
        route_name: "check",
        controller_class: "boundary",
        action_name: "handleBoundary",
        controller_file: "src/mcp/boundary.ts",
        controller_line: 2,
        architecture_style: "rpc",
        entry_kind: "mcp_tool",
        execution_chain_json: JSON.stringify([
          { stage: "ingress", symbol: "tool:check", file: "src/mcp/boundary.ts", line: 2, relationship: { kind: "declares", derivation: "source", reason: "Literal public name" } },
          { stage: "controller", symbol: "handleBoundary", file: "src/mcp/boundary.ts", line: 2, relationship: { kind: "route_binding", derivation: "source", reason: "Registration" } },
        ]),
      });

      const tracer = new VerticalSliceTracer(repo, root);
      const traced = tracer.trace("MCP tool:check", 5, "src/mcp/boundary.ts");
      expect(traced.found).toBe(true);
      const symbols = traced.chain!.map((n) => n.symbol);
      expect(symbols).toContain("handleBoundary");
      expect(symbols).toContain("delegateBoundary");
      expect(symbols).toContain("runCoreAudit");
      const localNode = traced.chain!.find((n) => n.symbol === "delegateBoundary");
      expect(localNode?.relationship?.reason).toBe("ast_local_call_site");
    } finally {
      db.close();
    }
  });

  it("Pillar 3: classifies explicit non-MVC archetypes and returns submodule zoom-in summaries for large domains", async () => {
    expect(detectArchetype("src/core/parser/tree-sitter.ts", {})).toBe("parser");
    expect(detectArchetype("src/core/resolver/call-graph-tracer.ts", {})).toBe("resolver");
    expect(detectArchetype("src/core/ingestion/pipeline.ts", {})).toBe("pipeline");
    expect(detectArchetype("src/core/config/loader.ts", {})).toBe("config");
    expect(detectArchetype("src/mcp/server.ts", {})).toBe("server");
    expect(detectArchetype("src/core/boundary/evaluator.ts", {})).toBe("service");

    const { root, db, repo, pipeline, put } = createFixture();
    try {
      put("package.json", JSON.stringify({ name: "fixture", type: "module" }));
      for (let i = 0; i < 15; i++) {
        put(`src/core/parser/p${i}.ts`, `export function parse${i}() { return ${i}; }\n`);
      }
      for (let i = 0; i < 12; i++) {
        put(`src/core/resolver/r${i}.ts`, `export function resolve${i}() { return ${i}; }\n`);
      }
      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        },
      };
      await pipeline.run(config);

      const nav: any = buildNavigation(repo, { domain: "core", detail_level: "compact" }, root);
      expect(nav.status).toBe("success");
      expect(nav.submodules).toBeDefined();
      expect(nav.submodules.length).toBe(2);
      expect(nav.submodules[0].path).toBe("src/core/parser");
      expect(nav.submodules[0].file_count).toBe(15);
      expect(nav.submodules[1].path).toBe("src/core/resolver");
      expect(nav.submodules[1].file_count).toBe(12);
      expect(nav.files.length).toBe(15);
      expect(nav.next[0]).toEqual({
        tool: "septum_map",
        args: { action: "catalog", domain: "core", file_filter: "src/core/parser" },
      });
    } finally {
      db.close();
    }
  });

  it("Pillar 4a: renders token-efficient format='text' for septum_map and septum_slice while preserving legacy format='compact'", async () => {
    const legacyParsed = MapToolSchema.parse({ domain: "core", format: "compact" });
    expect(legacyParsed.detail_level).toBe("compact");
    expect(legacyParsed.format).toBe("text");

    const { root, db, repo, pipeline, put } = createFixture();
    try {
      put("package.json", JSON.stringify({ name: "fixture", type: "module" }));
      put("src/core/audit.ts", "export function runCoreAudit(x: string) { return Boolean(x); }\n");
      put(
        "src/mcp/boundary.ts",
        [
          'import { runCoreAudit } from "../core/audit.ts";',
          "export function handleBoundary(x: string) { return runCoreAudit(x); }",
        ].join("\n")
      );
      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
          mcp: { root: "src/mcp", allowed_dependencies: ["core"], forbidden_dependencies: [], archetypes: {} },
        },
      };
      await pipeline.run(config);

      const mcpDomain = repo.getDomainByName("mcp")!;
      repo.upsertVerticalSlice({
        domain_id: mcpDomain.id,
        feature_key: "mcp:tool:check",
        http_method: "MCP",
        route_uri: "tool:check",
        route_name: "check",
        controller_class: "boundary",
        action_name: "handleBoundary",
        controller_file: "src/mcp/boundary.ts",
        controller_line: 2,
        architecture_style: "rpc",
        entry_kind: "mcp_tool",
        execution_chain_json: JSON.stringify([
          { stage: "ingress", symbol: "tool:check", file: "src/mcp/boundary.ts", line: 2, relationship: { kind: "declares", derivation: "source", reason: "Literal public name" } },
          { stage: "controller", symbol: "handleBoundary", file: "src/mcp/boundary.ts", line: 2, relationship: { kind: "route_binding", derivation: "source", reason: "Registration" } },
        ]),
      });

      const mapJson = await handleMapTool(repo, config, { action: "catalog", detail_level: "compact", format: "json", ingest_now: false }, root);
      const mapText = await handleMapTool(repo, config, { action: "catalog", detail_level: "compact", format: "text", ingest_now: false }, root);
      expect(mapText.content[0]!.text).toContain("# Septum Map: workspace");
      expect(mapText.content[0]!.text).toContain("## Domains");
      expect(Buffer.byteLength(mapText.content[0]!.text, "utf8")).toBeLessThan(Buffer.byteLength(mapJson.content[0]!.text, "utf8"));

      const sliceJson = await handleSliceTool(repo, config, { query: "MCP tool:check", max_depth: 5, format: "json" }, root);
      const sliceText = await handleSliceTool(repo, config, { query: "MCP tool:check", max_depth: 5, format: "text" }, root);
      expect(sliceText.content[0]!.text).toContain("# Septum Slice: MCP tool:check");
      expect(sliceText.content[0]!.text).toContain("runCoreAudit");
      expect(Buffer.byteLength(sliceText.content[0]!.text, "utf8")).toBeLessThan(Buffer.byteLength(sliceJson.content[0]!.text, "utf8"));
    } finally {
      db.close();
    }
  });

  it("Pillar 4b: bridges same-file local helper calls in polyglot Python slices and source delegator expansion", async () => {
    const { root, db, repo, pipeline, put } = createFixture();
    try {
      put("pyproject.toml", '[project]\nname = "polyglot-fixture"\n');
      put(
        "app/services/order_service.py",
        [
          "class OrderService:",
          "    def process(self, order_id):",
          "        return {'id': order_id, 'status': 'ok'}",
        ].join("\n")
      );
      put(
        "app/handlers/order_handler.py",
        [
          "from app.services.order_service import OrderService",
          "",
          "def handle_order(order_id):",
          "    return _delegate_order(order_id)",
          "",
          "def _delegate_order(order_id):",
          "    svc = OrderService()",
          "    return svc.process(order_id)",
        ].join("\n")
      );
      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn", db_path: ":memory:", ignore_patterns: [] },
        domains: {
          services: { root: "app/services", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
          handlers: { root: "app/handlers", allowed_dependencies: ["services"], forbidden_dependencies: [], archetypes: {} },
        },
      };
      await pipeline.run(config);

      const handlersDomain = repo.getDomainByName("handlers")!;
      repo.upsertVerticalSlice({
        domain_id: handlersDomain.id,
        feature_key: "http:post:/orders",
        http_method: "POST",
        route_uri: "/orders",
        route_name: "create_order",
        controller_class: "order_handler",
        action_name: "handle_order",
        controller_file: "app/handlers/order_handler.py",
        controller_line: 3,
        architecture_style: "fastapi",
        entry_kind: "http_route",
        execution_chain_json: JSON.stringify([
          { stage: "ingress", symbol: "POST /orders", file: "app/handlers/order_handler.py", line: 3, relationship: { kind: "declares", derivation: "source", reason: "Route" } },
          { stage: "controller", symbol: "handle_order", file: "app/handlers/order_handler.py", line: 3, relationship: { kind: "route_binding", derivation: "source", reason: "Handler" } },
        ]),
      });

      const tracer = new VerticalSliceTracer(repo, root);
      const traced = tracer.trace("POST /orders", 5, "app/handlers/order_handler.py");
      expect(traced.found).toBe(true);
      const symbols = traced.chain!.map((n) => n.symbol);
      expect(symbols).toContain("handle_order");
      expect(symbols).toContain("_delegate_order");
      expect(symbols.some((s) => s.includes("OrderService") || s.includes("process"))).toBe(true);

      // Source delegator expansion for thin Python local wrapper
      const symRes = await handleSymbolTool(
        repo,
        config,
        { action: "context", context_mode: "source", query: "handle_order", file_path: "app/handlers/order_handler.py", include_source: true, include_dependencies: true , format: "json"},
        pipeline,
        root
      );
      const symPayload = JSON.parse(symRes.content[0]!.text);
      expect(symPayload.source_slice?.delegated_implementation?.symbol).toBe("_delegate_order");
    } finally {
      db.close();
    }
  });
});
