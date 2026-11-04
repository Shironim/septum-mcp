import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { SliceToolSchema } from "../../src/mcp/schemas.ts";

describe("shared slice selection and catalog integrity", () => {
  let db: SeptumDatabase, repo: SeptumRepository, tracer: VerticalSliceTracer;
  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    tracer = new VerticalSliceTracer(repo, "/tmp");
  });
  afterEach(() => db.close());
  it("requires a query separately from its controller filter and preserves legacy file aliases", () => {
    expect(SliceToolSchema.safeParse({ controller_file: "orders.ts" }).success).toBe(false);
    expect(SliceToolSchema.parse({ file_path: "orders.ts" }).query).toBe("orders.ts");
    const parsed = SliceToolSchema.parse({ route: "GET /orders", controller_file: "orders.ts" });
    expect(parsed.query).toBe("GET /orders");
    expect(parsed.controller_file).toBe("orders.ts");
  });
  const add = (file: string, chain = '[{"stage":"controller","symbol":"Handler@run"}]', method = "GET", uri = "/orders") =>
    repo.upsertVerticalSlice({ domain_id: null, feature_key: null, http_method: method, route_uri: uri,
      route_name: "orders.run", controller_class: "Handler", action_name: "run", controller_file: file,
      controller_line: 1, architecture_style: "fixture", entry_kind: "http_route", execution_chain_json: chain });

  it("refuses arbitrary selection for duplicate catalog targets across lookup modes", () => {
    add("admin.ts"); add("public.ts");
    for (const query of ["GET /orders", "/orders", "orders.run", "Handler@run", "Handler", "run", "update orders"]) {
      const result = tracer.trace(query);
      expect(result.found).toBe(false);
      expect(result.diagnostics).toContain("ambiguous_target");
      expect(result.entrypoint).toBeUndefined();
      expect(result.chain).toBeUndefined();
      expect(result.alternatives).toHaveLength(2);
    }
  });

  it("filters by exact controller file without losing the query", () => {
    add("admin/orders.ts"); add("public/orders.ts");
    const result = tracer.trace("GET /orders", 5, "public/orders.ts");
    expect(result.found).toBe(true);
    expect(result.entrypoint?.file).toBe("public/orders.ts");
    expect(tracer.trace("GET /orders", 5, "missing.ts").found).toBe(false);
  });

  it("bounds ambiguity candidates with explicit omissions and allows selection outside the first page", () => {
    for (let i = 0; i < 25; i++) add(`handler-${i.toString().padStart(2, "0")}.ts`);
    const result = tracer.trace("GET /orders");
    expect(result.candidate_count).toBe(25);
    expect(result.alternatives).toHaveLength(20);
    expect(result.alternatives_omitted).toBe(5);
    expect(tracer.trace("GET /orders", 5, "handler-24.ts").found).toBe(true);
  });

  it("reports expansion failures while retaining the selected static chain", () => {
    add("orders.ts");
    const failing = new VerticalSliceTracer({
      getAllVerticalSlices: () => repo.getAllVerticalSlices(),
      getAllFiles: () => [],
      getAllSymbolsWithFiles: () => { throw new Error("unavailable index"); },
    } as unknown as SeptumRepository);
    const result = failing.trace("GET /orders");
    expect(result.diagnostics).toContain("dependency_expansion_failed");
    expect(result.chain).toHaveLength(1);
    expect(result.message).toContain("Analysis incomplete");
  });

  it("requires the HTTP method when one file has several verbs", () => {
    add("orders.ts"); add("orders.ts", undefined, "POST");
    expect(tracer.trace("/orders", 5, "orders.ts").diagnostics).toContain("ambiguous_target");
    expect(tracer.trace("POST /orders", 5, "orders.ts").entrypoint?.method).toBe("POST");
  });

  it("preserves a unique literal route over parameter-normalized alternatives", () => {
    add("literal.ts"); add("parameter.ts", undefined, "GET", "/{id}");
    expect(tracer.trace("GET /orders").entrypoint?.file).toBe("literal.ts");
  });

  it("does not hide unreadable chains behind a negative symbol search", () => {
    add("orders.ts", "{");
    const result = tracer.trace("absent_symbol");
    expect(result.found).toBe(false);
    expect(result.diagnostics).toContain("invalid_execution_chain");
  });

  for (const chain of ["", "{", "{}", "null", "[null]", '[{"stage":"controller"}]', '[{"stage":2,"symbol":"run"}]', '[{"stage":"controller","symbol":"run","guards":"wrong"}]']) {
    it(`reports malformed chain ${chain} without crashing or silently succeeding`, () => {
      add("orders.ts", chain);
      const result = tracer.trace("GET /orders");
      expect(result.diagnostics).toContain("invalid_execution_chain");
      expect(result.chain).toEqual([]);
    });
  }
});
