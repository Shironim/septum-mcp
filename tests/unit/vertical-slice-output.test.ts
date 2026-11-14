import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/trace-vertical-slice.ts";
import { SEMANTIC_FINGERPRINT } from "../../src/core/parser/semantic-revision.ts";

describe("Vertical Slice Output Standardization (JSON Contracts)", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: ":memory:",
      ignore_patterns: [],
    },
    domains: {},
    features: {},
  };

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    // These tests inject current formatter fixtures rather than running extraction.
    repo.setMeta("semantic_extractor_revision", SEMANTIC_FINGERPRINT);
  });

  afterEach(() => {
    db.close();
  });

  it("keeps Go package imports out of the selected handler chain", async () => {
    repo.upsertVerticalSlice({
      domain_id: null, feature_key: null, http_method: "POST", route_uri: "/orders",
      route_name: null, controller_class: "OrderHandler", action_name: "Create",
      controller_file: "handler/orders.go", controller_line: 1,
      architecture_style: "go-http", entry_kind: "http_route",
      execution_chain_json: JSON.stringify([
        { stage: "controller", symbol: "OrderHandler::Create", file: "handler/orders.go" },
        { stage: "service", symbol: "orders::Checkout", file: "service/orders.go" },
        { stage: "service", symbol: "Unrelated", file: "service/auth.go", relationship: { kind: "imports" } },
      ]),
    });
    // A package import traversal must not be requested for a Go handler.
    repo.getAllFiles = () => { throw new Error("unexpected package expansion"); };
    const result = JSON.parse((await handleTraceVerticalSlice(repo, mockConfig, { query: "POST /orders" })).content[0].text);
    expect(result.status).toBe("success");
    expect(result.chain.map((node: { symbol: string }) => node.symbol)).toEqual(["OrderHandler::Create", "orders::Checkout"]);
    expect(result.message).toContain("Go package import expansion is omitted");
  });

  it("returns parseable JSON string in content[0].text when slice is not found", async () => {
    const result = await handleTraceVerticalSlice(repo, mockConfig, {
      query: "POST /unregistered/order",
    });

    expect(result.content[0].type).toBe("text");
    const json = JSON.parse(result.content[0].text);

    expect(json.status).toBe("not_found");
    expect(json.found).toBe(false);
    expect(json.query).toBe("POST /unregistered/order");
    expect(json.summary).toContain("available static catalog");
    expect(json.summary).toContain("does not prove the route is absent at runtime");
    expect(json.chain).toEqual([]);
    expect(json.alternatives).toEqual([]);
  });

  it("does not label incomplete extraction as not found", async () => {
    repo.setMeta("sync_state", "error");
    const result = await handleTraceVerticalSlice(repo, mockConfig, { query: "GET /orders" });
    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("unknown");
    expect(json.summary).toContain("UNKNOWN");
    expect(json.summary).not.toContain("NOT FOUND");
  });

  it("returns parseable structured JSON with comprehensive metadata when slice is found", async () => {
    repo.upsertVerticalSlice({
      domain_id: null,
      feature_key: null,
      http_method: "POST",
      route_uri: "/orders/{id}/status",
      route_name: "orders.updateStatus",
      controller_class: "OrderController",
      action_name: "updateStatus",
      controller_file: "app/Http/Controllers/OrderController.php",
      controller_line: 42,
      architecture_style: "mvc",
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify([
        { stage: "ingress", symbol: "POST /orders/{id}/status", file: "routes/api.php", line: 10 },
        { stage: "controller", symbol: "OrderController@updateStatus", file: "app/Http/Controllers/OrderController.php", line: 42 },
        { stage: "egress", symbol: "resources/js/Pages/Orders/Show.vue", file: "resources/js/Pages/Orders/Show.vue" },
      ]),
    });

    const result = await handleTraceVerticalSlice(repo, mockConfig, {
      query: "POST /orders/{id}/status",
    });

    const json = JSON.parse(result.content[0].text);

    expect(json.status).toBe("success");
    expect(json.found).toBe(true);
    expect(json.query).toBe("POST /orders/{id}/status");
    expect(json.chain.length).toBe(3);
    expect(json.chain[0].stage).toBe("ingress");
    expect(json.chain[1].symbol).toBe("OrderController@updateStatus");
    expect(json.summary).toBe(
      "[INGRESS] POST /orders/{id}/status [unknown; unknown]\n[CONTROLLER] OrderController@updateStatus [unknown; unknown]\n[EGRESS] resources/js/Pages/Orders/Show.vue [unknown; unknown]"
    );
    expect(json.coverage).toBe("partial");
    expect(json.confidence).toBe("exact");
    expect(json.confidence_scope).toBe("query_to_catalog_target_only");
    expect(json.message).toContain("Vertical slice target match (exact): POST /orders/{id}/status -> OrderController@updateStatus");
    expect(json.relationship_limits).toContain("not a proven sequential execution path");
  });

  it("preserves mixed relationship kinds and derivation in JSON and summary without duplicating nodes in message", async () => {
    repo.upsertVerticalSlice({ domain_id: null, feature_key: null, http_method: "GET", route_uri: "/mixed", route_name: null,
      controller_class: "Handler", action_name: "run", controller_file: null, controller_line: 1,
      architecture_style: "fixture", entry_kind: "http_route", execution_chain_json: JSON.stringify([
        { stage: "ingress", symbol: "GET /mixed", relationship: { kind: "route_binding", derivation: "source", reason: "fixture" } },
        { stage: "service", symbol: "Service.run", relationship: { kind: "calls", derivation: "inferred", reason: "fixture" } },
        { stage: "entity", symbol: "Order", relationship: { kind: "schema_binding", derivation: "source", reason: "fixture" } },
      ]) });
    const result = await handleTraceVerticalSlice(repo, mockConfig, { query: "GET /mixed", max_depth: 1 });
    const payload = JSON.parse(result.content[0].text);
    for (const label of ["route_binding; source", "calls; inferred", "schema_binding; source"]) {
      expect(payload.summary).toContain(label);
    }
    expect(payload.message).toContain("GET /mixed -> Handler@run");
    expect(payload.message).not.toContain("route_binding; source");
    expect(payload.summary).not.toContain("➔");
    expect(payload.max_depth_applied).toBe(1);
    expect(payload.coverage).toBe("partial");
  });

  it("accepts custom workspaceRoot parameter gracefully", async () => {
    const result = await handleTraceVerticalSlice(
      repo,
      mockConfig,
      { query: "GET /health" },
      "/custom/workspace/root"
    );

    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("not_found");
    expect(json.query).toBe("GET /health");
  });

  it("rejects empty query by throwing actionable error", async () => {
    expect(() =>
      handleTraceVerticalSlice(repo, mockConfig, { query: "" })
    ).toThrow("Missing required argument: 'query'");
  });
});

