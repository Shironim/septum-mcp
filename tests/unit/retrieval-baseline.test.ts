import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { computeContentHash } from "../../src/core/ingestion/hasher.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";
import { SemanticSliceExtractorRegistry } from "../../src/core/parser/extractors/registry.ts";
import { readSourceFile } from "../../src/core/resources/source-files.ts";

// Manual oracle: imports are file dependencies, never proof of executed calls.
const target = [
  'import { validate } from "@rules/validator";',
  'import type { Order } from "./contract";',
  "export function submit(order: Order) {",
  "  return validate(order);",
  "}", "",
].join("\n");
const validator = "export function validate(order: { subtotal: number }) {\n  return order.subtotal;\n}\n";
const config = ConfigLoader.getDefaultConfig();
config.domains = { app: { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };

describe("TypeScript selective retrieval manual oracle", () => {
  let root: string, db: SeptumDatabase, repo: SeptumRepository, pipeline: IngestionPipeline;
  function put(path: string, source: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "septum-retrieval-"));
    db = new SeptumDatabase(join(root, ".septum/index.db"));
    repo = new SeptumRepository(db.raw);
    pipeline = new IngestionPipeline(repo, root);
    put("package.json", '{"type":"module"}');
    put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@rules/*": ["src/rules/*"] } } }));
    put("src/submit.ts", target);
    put("src/contract.ts", "export interface Order { subtotal: number }\n");
    put("src/rules/validator.ts", validator);
    put("src/caller.ts", 'import { submit } from "./submit";\nexport function run() { return submit({ subtotal: 12 }); }\n');
    put("src/import-only.ts", 'import { submit } from "./submit";\nexport const unused = true;\n');
    put("src/decoy.ts", 'export function unrelated() { return "submit validate"; }\n');
    put("src/unresolved.ts", 'import missing from "./missing";\nexport function pending() { return missing; }\n');
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  async function tool(args: Parameters<typeof handleSymbolTool>[2]) {
    return JSON.parse((await handleSymbolTool(repo, config, { ...args, format: "json" }, undefined, root)).content[0]!.text);
  }
  function semanticSnapshot(repository: SeptumRepository) {
    return {
      files: repository.getAllFiles().map(file => ({ path: file.path, hash: file.content_hash,
        symbols: repository.getSymbolsByFileId(file.id).map(({ name, kind, signature, line_start, line_end }) =>
          ({ name, kind, signature, line_start, line_end })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      })).sort((a, b) => a.path.localeCompare(b.path)),
      edges: repository.getImportRelationships(root).map(edge => ({ ...edge,
        resolution: { ...edge.resolution, targets: edge.resolution.targets.map(t => ({ ...t, files: [...t.files].sort() })) },
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }
  async function expectColdEquivalent() {
    const expected = semanticSnapshot(repo);
    db.close();
    db = new SeptumDatabase(join(root, ".septum/index.db"));
    repo = new SeptumRepository(db.raw);
    pipeline = new IngestionPipeline(repo, root);
    expect(semanticSnapshot(repo)).toEqual(expected);
    const cold = new SeptumDatabase(":memory:");
    try {
      const coldRepo = new SeptumRepository(cold.raw);
      await new IngestionPipeline(coldRepo, root).run(config, { verifyContent: true });
      expect(semanticSnapshot(coldRepo)).toEqual(expected);
    } finally { cold.close(); }
  }

  it("locates a declaration, retrieves its exact implementation and separates inbound imports from calls", async () => {
    expect((await pipeline.run(config)).parser_invocations).toBe(7);
    expect((await pipeline.run(config)).parser_invocations).toBe(0);
    const located = await tool({ action: "locate", query: "submit", file_path: "src/submit.ts" });
    expect(located.found).toBe(true);
    expect(located.symbol_ref).toMatchObject({ file_path: "src/submit.ts", name: "submit", start_line: 3, end_line: 5,
      indexed_content_hash: computeContentHash(target) });
    const inspected = await tool({ action: "inspect", symbol_ref: located.symbol_ref, include_source: true });
    expect(inspected.source_slice).toMatchObject({ status: "current", start_line: 3, end_line: 5, truncated: false,
      text: "export function submit(order: Order) {\n  return validate(order);\n}" });
    expect(inspected.source_slice.text).not.toContain("unrelated");
    const edges = repo.getImportRelationships(root).filter(edge => edge.source.file === "src/submit.ts");
    expect(edges.map(edge => ({ kind: edge.kind, line: edge.source.line, files: edge.resolution.targets.flatMap(t => t.files) })))
      .toEqual([{ kind: "imports", line: 1, files: ["src/rules/validator.ts"] },
        { kind: "imports", line: 2, files: ["src/contract.ts"] }]);
    const impact = await tool({ action: "impact", symbol_ref: located.symbol_ref });
    expect(impact.import_dependents.map((edge: any) => edge.source.file)).toEqual(["src/caller.ts", "src/import-only.ts"]);
    expect(impact.inbound_callers_complete).toBe(false);
    expect(impact.coverage).toBe("partial");
    expect(impact.relationship_limits).toContain("do not prove executed calls");
  });

  it("keeps the manual alias and negative-resolution oracle after config/create/delete mutations and restart", async () => {
    await pipeline.run(config);
    put("src/alternate/validator.ts", validator.replace("order.subtotal", "order.subtotal * 2"));
    put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@rules/*": ["src/alternate/*"] } } }));
    put("src/missing.ts", "export default 1;\n");
    await pipeline.run(config, { verifyContent: true });
    const imports = repo.getImportRelationships(root);
    expect(imports.find(e => e.source.file === "src/submit.ts" && e.source.line === 1)?.resolution.targets)
      .toEqual([{ kind: "file", files: ["src/alternate/validator.ts"] }]);
    expect(imports.find(e => e.source.file === "src/unresolved.ts")?.resolution.status).toBe("resolved");
    await expectColdEquivalent();
    renameSync(join(root, "src/alternate/validator.ts"), join(root, "src/alternate/renamed.ts"));
    rmSync(join(root, "src/missing.ts"));
    await pipeline.run(config, { verifyContent: true });
    const unresolved = repo.getImportRelationships(root).filter(e => e.resolution.status === "unresolved");
    expect(unresolved.map(e => e.resolution.source.target).sort()).toEqual(["./missing", "@rules/validator"]);
    await expectColdEquivalent();
  });

  it("rejects stale source coordinates and then an old declaration reference after reindex", async () => {
    await pipeline.run(config);
    const located = await tool({ action: "locate", query: "submit", file_path: "src/submit.ts" });
    put("src/submit.ts", "// inserted line\n" + target);
    expect((await tool({ action: "inspect", symbol_ref: located.symbol_ref, include_source: true })).source_slice.status).toBe("stale");
    await pipeline.run(config);
    expect((await tool({ action: "inspect", symbol_ref: located.symbol_ref, include_source: true })).status).toBe("stale_reference");
    await expectColdEquivalent();
  });

  it("returns the required implementation and direct import declarations without caller or decoy source", async () => {
    await pipeline.run(config);
    const args = SymbolToolSchema.parse({ action: "context", query: "submit", file_path: "src/submit.ts" });
    const result = await handleSymbolTool(repo, config, { ...args, format: "json" }, undefined, root);
    const context = JSON.parse(result.content[0]!.text);
    expect(context.status).toBe("success");
    expect(context.freshness).toBe("current");
    expect(context.completeness_scope).toContain("directly imported TypeScript files");
    expect(context.items.filter((item: any) => item.kind === "source").map((item: any) => [item.name, item.source.file_path]))
      .toEqual([["submit", "src/submit.ts"], ["validate", "src/rules/validator.ts"], ["Order", "src/contract.ts"]]);
    expect(context.items.filter((item: any) => item.kind === "relationship").every((item: any) => item.relationship.kind === "imports")).toBe(true);
    expect(context.output_bytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
    expect(context.output_bytes).toBeLessThanOrEqual(context.budget_bytes);
    expect(context.capability_limits).toContain("not calls");
    expect(await tool(args)).toEqual(context);
    await expectColdEquivalent();
    expect(await tool(args)).toEqual(context);
  });

  it("matches an independent task oracle for local helpers, constants and transitive imported bindings", async () => {
    put("src/order.ts", [
      'import { tax as computeTax } from "./rates";',
      'import { emailMarketing } from "./marketing";',
      'const surcharge = 7;',
      'function validateLocal(x: number) { if (x < 0) throw new Error("negative"); return x; }',
      'export function total(x: number) { return validateLocal(x) + surcharge + computeTax(x); }',
      'export function unrelatedCampaign() { return emailMarketing(); }',
    ].join("\n"));
    put("src/rates.ts", 'import { percentage } from "./policy";\nexport function tax(x: number) { return x * percentage; }\nexport function unrelatedRateReport() { return "irrelevant"; }');
    put("src/policy.ts", 'export const percentage = 0.11;');
    put("src/marketing.ts", 'export function emailMarketing() { return "campaign"; }');
    await pipeline.run(config);
    const result = await tool({ action: "context", query: "total" });
    const sources = result.items.filter((i: any) => i.kind === "source");
    // Written from the task's arithmetic, independently of traversal order.
    expect(sources.map((i: any) => i.name).sort()).toEqual(["percentage", "surcharge", "tax", "total", "validateLocal"]);
    expect(sources.map((i: any) => i.source.text).join("\n")).not.toContain("emailMarketing");
    expect(result.task_sufficiency).toBe("unknown");
    expect(result.policy).toBe("referenced-typescript-declarations/v4");
  });

  it("respects shadowed bindings and terminates local recursion without reading string decoys", async () => {
    put("src/shadow.ts", 'import { validate } from "@rules/validator";\nfunction recursive(n: number): number { return n ? recursive(n - 1) : 0; }\nexport function shadow(validate: (n: number) => number) { return validate(recursive(1)) + "unrelated"; }');
    await pipeline.run(config);
    const result = await tool({ action: "context", query: "shadow" });
    expect(result.items.filter((i: any) => i.kind === "source").map((i: any) => i.name).sort()).toEqual(["recursive", "shadow"]);
  });

  it("resolves a default binding and a cross-file reference cycle without unrelated exports", async () => {
    put("src/cycle-a.ts", 'import calculate from "./cycle-b";\nexport function cycleA(n: number): number { return n ? calculate(n - 1) : 0; }');
    put("src/cycle-b.ts", 'import { cycleA } from "./cycle-a";\nexport default function calculate(n: number): number { return cycleA(n); }\nexport function decoyCycle() { return 99; }');
    await pipeline.run(config);
    const result = await tool({ action: "context", query: "cycleA" });
    expect(result.items.filter((i: any) => i.kind === "source").map((i: any) => i.name)).toEqual(["cycleA", "calculate"]);
    expect(result.completeness).toBe("complete");
  });

  it("marks executable module initialization and invalid syntax as partial", async () => {
    put("src/initialization.ts", 'const initialized = setup();\nexport function initializeTarget() { return 1; }');
    await pipeline.run(config);
    const initialization = await tool({ action: "context", query: "initializeTarget" });
    expect(initialization.completeness).toBe("partial");
    expect(initialization.items.some((i: any) => i.reason === "module_execution_or_reexport_not_expanded")).toBe(true);
    put("src/broken-context.ts", 'export function brokenTarget() { return 1; }\nconst broken = ;');
    await pipeline.run(config);
    const afterFailure = await tool({ action: "context", query: "initializeTarget" });
    expect(afterFailure.completeness).toBe("partial");
  });

  it("reports namespace, side effects, reexports and depth exhaustion explicitly", async () => {
    put("src/ns.ts", 'import * as rates from "./rates";\nimport "./marketing";\nexport function namespaced() { return rates.tax(1); }');
    put("src/rates.ts", 'export { validate as tax } from "@rules/validator";');
    put("src/marketing.ts", 'console.log("module initialization");');
    put("src/barrel-user.ts", 'import { tax } from "./rates";\nexport function barrelUser() { return tax(1); }');
    for (let i = 0; i < 5; i++) put(`src/depth${i}.ts`, i === 4 ? 'export function deep4() { return 1; }' : `import { deep${i + 1} } from "./depth${i + 1}";\nexport function deep${i}() { return deep${i + 1}(); }`);
    await pipeline.run(config);
    const ns = await tool({ action: "context", query: "namespaced" });
    expect(ns.completeness).toBe("partial");
    expect(ns.items.some((i: any) => i.reason === "side_effect_import_not_expanded")).toBe(true);
    expect(ns.items.some((i: any) => i.reason === "dependency_depth_or_binding_limit")).toBe(true);
    const barrel = await tool({ action: "context", query: "barrelUser" });
    expect(barrel.items.some((i: any) => i.reason === "export_binding_not_resolved")).toBe(true);
    const deep = await tool({ action: "context", query: "deep0" });
    expect(deep.completeness).toBe("partial");
    expect(deep.items.some((i: any) => i.reason === "dependency_depth_or_binding_limit")).toBe(true);
    expect(deep.items.filter((i: any) => i.kind === "source").map((i: any) => i.name)).toEqual(["deep0", "deep1", "deep2"]);
    const deep3 = await tool({ action: "context", query: "deep0", max_depth: 3 });
    expect(deep3.completeness).toBe("partial");
    expect(deep3.items.filter((i: any) => i.kind === "source").map((i: any) => i.name)).toEqual(["deep0", "deep1", "deep2", "deep3"]);
  });

  it("accounts for complete response bytes and traverses pages without dropping or duplicating items", async () => {
    await pipeline.run(config);
    const base = { action: "context" as const, query: "submit", file_path: "src/submit.ts", budget_bytes: 3500 };
    const complete = await tool({ ...base, budget_bytes: 65536 });
    let continuation: string | undefined;
    const items: any[] = [];
    const snapshots: string[] = [];
    let pages = 0;
    do {
      const result = await handleSymbolTool(repo, config, SymbolToolSchema.parse({ ...base, continuation, format: "json" }), undefined, root);
      const page = JSON.parse(result.content[0]!.text);
      expect(["success", "partial"]).toContain(page.status);
      expect(page.output_bytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
      expect(page.output_bytes).toBeLessThanOrEqual(base.budget_bytes);
      expect(page.accounting.offset).toBe(items.length);
      items.push(...page.items);
      snapshots.push(page.snapshot_id);
      continuation = page.continuation;
      expect(++pages).toBeLessThan(10);
    } while (continuation);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(snapshots).size).toBe(1);
    expect(items).toEqual(complete.items);
  });

  it("refuses continuation when source, configuration, index or budget changes", async () => {
    await pipeline.run(config);
    const base = { action: "context" as const, query: "submit", file_path: "src/submit.ts", budget_bytes: 3500 };
    const first = await tool(base);
    expect(first.continuation).toBeString();
    expect((await tool({ ...base, budget_bytes: 3501, continuation: first.continuation })).status).toBe("invalid_continuation");
    put("src/rules/validator.ts", validator.replace("order.subtotal", "order.subtotal * 2"));
    expect((await tool({ ...base, continuation: first.continuation })).status).toBe("stale_continuation");
    const stale = await tool({ ...base, budget_bytes: 65536 });
    expect(stale.freshness).toBe("stale");
    expect(stale.completeness).toBe("partial");
    expect(stale.items.some((item: any) => item.kind === "source" && item.name === "validate")).toBe(false);
    await pipeline.run(config);
    expect((await tool({ ...base, continuation: first.continuation })).status).toBe("stale_continuation");
    const fresh = await tool(base);
    put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@rules/*": ["src/missing/*"] } } }));
    expect((await tool({ ...base, continuation: fresh.continuation })).status).toBe("stale_continuation");
  });

  it("keeps unresolved imports visible and labels oversized source fragments", async () => {
    await pipeline.run(config);
    const unresolved = await tool({ action: "context", query: "pending", file_path: "src/unresolved.ts" });
    expect(unresolved.completeness).toBe("partial");
    expect(unresolved.items.some((item: any) => item.reason === "referenced_import_not_expanded")).toBe(true);
    repo.setMeta("sync_state", "error");
    const incomplete = await tool({ action: "context", query: "submit", file_path: "src/submit.ts" });
    expect(incomplete.completeness).toBe("partial");
    expect(incomplete.items.some((item: any) => item.reason === "index_not_complete")).toBe(true);
    put("src/large.ts", `export function huge() { return "${"😀".repeat(2000)}"; }\n`);
    await pipeline.run(config);
    const args = SymbolToolSchema.parse({ action: "context", query: "huge", budget_bytes: 3500 });
    const result = await handleSymbolTool(repo, config, { ...args, format: "json" }, undefined, root);
    const oversized = JSON.parse(result.content[0]!.text);
    expect(oversized.status).toBe("partial");
    expect(oversized.items[0].fragment.start_utf16).toBe(0);
    expect(oversized.items[0].source.text.length).toBeGreaterThan(0);
    expect(oversized.continuation).toBeString();
    expect(oversized.accounting.omitted_after).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(3500);
  });

  it("retains ambiguity, rejects unsupported modes and enforces context-only parameters", async () => {
    put("src/duplicate.ts", "export function submit() {}\n");
    put("src/other.py", "def other():\n    return 1\n");
    await pipeline.run(config);
    expect((await tool({ action: "context", query: "submit" })).status).toBe("ambiguous");
    expect((await tool({ action: "context", query: "other", file_path: "src/other.py" })).source_slice.text).toContain("return 1");
    expect((await tool({ action: "context", query: "absent" })).status).toBe("not_found");
    expect((await tool({ action: "context", query: "submit", file_path: "src/submit.ts", continuation: "invalid" })).status).toBe("invalid_continuation");
    expect(SymbolToolSchema.parse({ action: "inspect", query: "submit", budget_bytes: 3500 }).action).toBe("context");
    expect(() => SymbolToolSchema.parse({ action: "context", query: "submit", budget_bytes: 2047 })).toThrow();
  });

  it("does not publish a single-file parse if the source changed while parsing", async () => {
    await pipeline.run(config);
    const before = repo.getFileByPath("src/submit.ts")!.content_hash;
    put("src/submit.ts", target.replace("validate(order)", "validate(order) + 1"));
    const original = ASTParserEngine.prototype.parseFile;
    const parser = spyOn(ASTParserEngine.prototype, "parseFile").mockImplementation(async function (file, content) {
      const result = await original.call(this, file, content);
      if (file === join(root, "src/submit.ts")) put("src/submit.ts", target.replace("validate(order)", "validate(order) + 2"));
      return result;
    });
    try {
      await expect(pipeline.ingestFile(join(root, "src/submit.ts"), config)).rejects.toThrow("Source changed during synchronization:");
      expect(repo.getFileByPath("src/submit.ts")!.content_hash).toBe(before);
      expect(repo.getMeta("sync_state")).toBe("error");
    } finally { parser.mockRestore(); }
    await pipeline.run(config);
    expect(repo.getMeta("sync_state")).toBe("complete");
    expect((await tool({ action: "context", query: "submit", file_path: "src/submit.ts" })).freshness).toBe("current");
  });

  it("retries semantic input changes once, and fails closed when inputs keep changing", async () => {
    let reads = 0;
    let alwaysChange = false;
    const unregister = SemanticSliceExtractorRegistry.register({
      id: "retrieval-race-fixture", name: "input mutation fixture",
      canHandle: path => path === root,
      extractSlices: () => {
        const text = readSourceFile(join(root, "src/contract.ts"));
        if (reads++ === 0 || alwaysChange) put("src/contract.ts", text + "\n");
        return [];
      },
    });
    try {
      const metrics = await pipeline.run(config);
      expect(metrics.parser_invocations).toBe(8); // Seven initial files, then the changed contract on retry.
      expect(reads).toBe(2);
      expect(repo.getMeta("sync_state")).toBe("complete");
      alwaysChange = true;
      repo.setMeta("slices_dirty", "1");
      await expect(pipeline.run(config)).rejects.toThrow("Source changed during synchronization:");
      expect(repo.getMeta("sync_state")).toBe("error");
    } finally { unregister(); }
  });

  it("rejects an index publication that overlaps context retrieval and honors cancellation", async () => {
    await pipeline.run(config);
    const original = repo.getImportRelationships.bind(repo);
    const intercepted = spyOn(repo, "getImportRelationships").mockImplementation(root => {
      const edges = original(root);
      repo.setMeta("sync_state", "running");
      return edges;
    });
    try {
      expect((await tool({ action: "context", query: "submit", file_path: "src/submit.ts" })).status).toBe("index_changed");
    } finally { intercepted.mockRestore(); }
    const abort = new AbortController(); abort.abort(new Error("cancel-context"));
    await expect(handleSymbolTool(repo, config, SymbolToolSchema.parse({ action: "context", query: "submit" }), undefined, root, abort.signal))
      .rejects.toThrow("cancel-context");
  });

  it("preserves Unicode/CRLF slices, terminates a direct-import cycle and reports capacity omissions", async () => {
    put("src/submit.ts", target.replace(/\n/g, "\r\n").replace("validate(order);", "validate(order); // 😀"));
    put("src/rules/validator.ts", 'import type { Order } from "../contract";\n' + validator);
    put("src/contract.ts", 'import { submit } from "./submit";\nexport interface Order { subtotal: number }\n');
    await pipeline.run(config);
    const context = await tool({ action: "context", query: "submit", file_path: "src/submit.ts" });
    expect(context.items[0].source.text).toBe("export function submit(order: Order) {\r\n  return validate(order); // 😀\r\n}");
    expect(context.items.filter((item: any) => item.kind === "source").map((item: any) => item.name)).toEqual(["submit", "validate", "Order"]);
    put("src/contract.ts", "export interface Order extends " + Array.from({ length: 300 }, (_, i) => `Contract${i}`).join(", ") + " {}\n" + Array.from({ length: 300 }, (_, index) => `export interface Contract${index} { value: number }`).join("\n"));
    await pipeline.run(config);
    const bounded = await tool({ action: "context", query: "submit", file_path: "src/submit.ts", budget_bytes: 2 * 1024 * 1024 });
    expect(bounded.completeness).toBe("partial");
    expect(bounded.items).toHaveLength(256);
    expect(bounded.accounting.omitted_by_capacity).toBeGreaterThan(0);
    expect(bounded.items.filter((item: any) => item.kind === "source").length).toBeGreaterThan(200);
  });

  it("reports dynamic and missing-source uncertainty instead of returning empty complete context", async () => {
    put("src/dynamic.ts", "export function load(path: string) { return import(path); }\n");
    await pipeline.run(config);
    const dynamic = await tool({ action: "context", query: "load", file_path: "src/dynamic.ts" });
    expect(dynamic.completeness).toBe("partial");
    expect(dynamic.items.some((item: any) => item.reason === "import_not_fully_resolved")).toBe(true);
    rmSync(join(root, "src/submit.ts"));
    const missing = await tool({ action: "context", query: "submit", file_path: "src/submit.ts" });
    expect(missing.freshness).toBe("unavailable");
    expect(missing.completeness).toBe("partial");
    expect(missing.items.every((item: any) => item.kind !== "source")).toBe(true);
  });

  it("invalidates continuation when a previously missing dependency appears without a sync", async () => {
    put("src/unresolved.ts", 'import missing from "./missing";\nexport function pending() {\n  return missing + "' + "x".repeat(400) + '";\n}\n');
    await pipeline.run(config);
    const query = { action: "context" as const, query: "pending", file_path: "src/unresolved.ts" };
    const whole = await tool(query);
    const base = { ...query, budget_bytes: whole.output_bytes - 20 };
    const first = await tool(base);
    expect(first.continuation).toBeString();
    put("src/missing.ts", "export default 1;\n");
    expect((await tool({ ...base, continuation: first.continuation })).status).toBe("stale_continuation");
  });

  it("rejects context if a resolver config appears after resolution but before publication", async () => {
    await pipeline.run(config);
    const original = repo.getImportRelationships.bind(repo);
    const intercepted = spyOn(repo, "getImportRelationships").mockImplementation(root => {
      const edges = original(root);
      put("src/tsconfig.json", "{}\n");
      return edges;
    });
    try {
      await expect(tool({ action: "context", query: "submit", file_path: "src/submit.ts" }))
        .rejects.toThrow("Source changed during synchronization:");
      expect(repo.getMeta("sync_state")).toBe("complete"); // A read must not mutate session/index state.
    } finally { intercepted.mockRestore(); }
  });

  it("makes inspect and context equivalent and preserves explicit bounded and polyglot source", async () => {
    put("src/python.py", "def python_entry():\n    return 42\n");
    await pipeline.run(config);
    const base = { query: "submit", file_path: "src/submit.ts" };
    const deep = await tool(SymbolToolSchema.parse({ ...base, action: "context" }));
    expect(await tool(SymbolToolSchema.parse({ ...base, action: "inspect" }))).toEqual(deep);
    expect(await tool({ ...base, action: "inspect" })).toEqual(deep);
    expect(deep.items.some((item: any) => item.name === "validate")).toBe(true);
    for (const action of ["context", "inspect"] as const) {
      const bounded = await tool(SymbolToolSchema.parse({ ...base, action, source_line_limit: 1 }));
      expect(bounded.source_slice.text).toBe("export function submit(order: Order) {");
      expect(bounded.source_slice.truncated).toBe(true);
      const python = await tool(SymbolToolSchema.parse({ action, query: "python_entry" }));
      expect(python.source_slice.text).toBe("def python_entry():\n    return 42");
      expect((await tool({ ...base, action, include_source: true, budget_bytes: 4096 })).status).toBe("invalid_context_options");
    }
  });

  it("returns source before provenance and excludes imports used only by unrelated declarations", async () => {
    put("src/focused.ts", [
      'import { unused } from "./unrelated";',
      'import { validate } from "@rules/validator";',
      'function helper(x: number) { return validate({ subtotal: x }); }',
      'export function focused(x: number) { return helper(x); }',
      'export function other() { return unused(); }',
    ].join("\n"));
    put("src/unrelated.ts", 'export function unused() { return "not needed for focused"; }');
    await pipeline.run(config);
    const result = await tool({ action: "context", query: "focused" });
    expect(result.items.filter((item: any) => item.kind === "source").map((item: any) => item.name))
      .toEqual(["focused", "helper", "validate"]);
    expect(result.items.slice(0, 3).every((item: any) => item.kind === "source")).toBe(true);
    expect(result.items.filter((item: any) => item.kind === "relationship").map((item: any) => item.relationship.source.statement))
      .toEqual(['import { validate } from "@rules/validator";']);
    expect(JSON.stringify(result.items)).not.toContain("unrelated");
  });

  it("prioritizes direct value imports over type-only class imports and prunes runtime collaborators of type-only classes", async () => {
    put("src/collab.ts", 'export class HeavyCollaborator {\n  compute() { return "' + "c".repeat(500) + '"; }\n}\n');
    put("src/repo-facade.ts", [
      'import { HeavyCollaborator } from "./collab";',
      "export class RepoFacade {",
      "  private collab = new HeavyCollaborator();",
      "  run() { return this.collab.compute(); }",
      "}",
    ].join("\n"));
    put("src/step-a.ts", "export function stepA(x: number) { return x + 1; }\n");
    put("src/step-b.ts", "export function stepB(x: number) { return x * 2; }\n");
    put("src/orchestrator.ts", [
      'import type { RepoFacade } from "./repo-facade";',
      'import { stepA } from "./step-a";',
      'import { stepB } from "./step-b";',
      "export function orchestrate(repo: RepoFacade, val: number) {",
      "  return stepB(stepA(val)) + (repo ? 0 : 1);",
      "}",
    ].join("\n"));
    await pipeline.run(config);

    // Also verify budget_bytes infers action="context" when action is omitted
    const inferred = SymbolToolSchema.parse({ query: "orchestrate", file_path: "src/orchestrator.ts", budget_bytes: 65536 });
    expect(inferred.action).toBe("context");

    const ctx = await tool(inferred);
    const sourceNames = ctx.items.filter((i: any) => i.kind === "source").map((i: any) => i.name);
    expect(sourceNames).toEqual(["orchestrate", "stepB", "stepA"]);
    expect(sourceNames).not.toContain("HeavyCollaborator");
    const contract = ctx.items.find((i: any) => i.kind === "type_contract");
    expect(contract.name).toBe("RepoFacade");
    expect(contract.projection).toBe("public_instance_signatures");
    expect(contract.text).toContain("run(): unknown;");
    expect(contract.text).not.toContain("HeavyCollaborator");
    expect(contract.text).not.toContain("collab");
    expect(ctx.items.some((i: any) => i.reason === "type_only_class_bodies_omitted")).toBe(true);
    expect(ctx.completeness).toBe("partial");
  });

  it("propagates literal option objects through forwarding calls and keeps unknown and conflicting branches", async () => {
    put("src/choice.ts", 'import { expensive } from "./expensive";\nimport { normal } from "./normal";\nexport function choose(options?: { domainOnly?: boolean }) { let path = "src"; path = String(path); if (options?.domainOnly) { return expensive(); } else { return normal(); } }');
    put("src/forward.ts", 'import { choose } from "./choice";\nexport function forward(options?: { domainOnly?: boolean }) { return choose(options); }');
    put("src/expensive.ts", 'export function expensive() { return "domain detection"; }');
    put("src/normal.ts", 'export function normal() { return "ordinary files"; }');
    put("src/entries.ts", 'import { forward } from "./forward";\nexport function fixed() { return forward({}); }\nexport function dynamic(options: { domainOnly?: boolean }) { return forward(options); }\nexport function both() { return [forward({}), forward({ domainOnly: true })]; }');
    await pipeline.run(config);
    const fixed = await tool({ action: "context", query: "fixed", budget_bytes: 65536, max_depth: 3 });
    expect(fixed.items.filter((i: any) => i.kind === "source").map((i: any) => i.name).sort()).toEqual(["choose", "fixed", "forward", "normal"]);
    expect(fixed.items.some((i: any) => i.kind === "selection" && i.pruned_branches === 1)).toBe(true);
    for (const query of ["dynamic", "both"]) {
      const ctx = await tool({ action: "context", query, budget_bytes: 65536, max_depth: 3 });
      const names = ctx.items.filter((i: any) => i.kind === "source").map((i: any) => i.name);
      expect(names).toContain("expensive");
      expect(names).toContain("normal");
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("keeps type-only signature dependencies projected even when their imports use value syntax", async () => {
    put("src/dependency.ts", 'export class Dependency { read(id: string): number { return Number(id); } private hidden() { return "not a contract"; } }');
    put("src/facade.ts", 'import { Dependency } from "./dependency";\nexport class Facade { constructor(public readonly dependency: Dependency) {} async run(id: string): Promise<number> { return this.dependency.read(id); } }');
    put("src/use-facade.ts", 'import type { Facade } from "./facade";\nexport function useFacade(facade: Facade) { return Boolean(facade); }');
    await pipeline.run(config);
    const ctx = await tool({ action: "context", query: "useFacade", budget_bytes: 65536 });
    const contracts = ctx.items.filter((i: any) => i.kind === "type_contract");
    expect(contracts.map((i: any) => i.name)).toEqual(["Facade", "Dependency"]);
    expect(contracts[0].text).toContain("readonly dependency: Dependency;");
    expect(contracts[0].text).toContain("run(id: string): Promise<number>;");
    expect(contracts[1].text).toContain("read(id: string): number;");
    expect(JSON.stringify(contracts)).not.toContain("Number(id)");
    expect(JSON.stringify(contracts)).not.toContain("hidden");
    expect(ctx.items.filter((i: any) => i.kind === "source").map((i: any) => i.name)).toEqual(["useFacade"]);
  });

  it("does not prune mutable, escaping, spread, callback, or effectful argument contexts", async () => {
    put("src/conditional.ts", 'import { expensive } from "./expensive";\nexport function conditional(opts: { enabled?: boolean }) { if (opts.enabled) return expensive(); return 0; }\nexport function mutated(opts: { enabled?: boolean }) { const alias = opts; alias.enabled = true; if (opts.enabled) return expensive(); return 0; }\nexport function escaped(opts: { enabled?: boolean }) { mutate(opts); if (opts.enabled) return expensive(); return 0; }\nexport function closure(opts: { enabled?: boolean }) { const leak = () => opts; register(leak); if (opts.enabled) return expensive(); return 0; }\nexport function constructed(opts: { enabled?: boolean }) { new Mutator(opts); if (opts.enabled) return expensive(); return 0; }\nexport function unrelated(opts: { enabled?: boolean }) { consume({ name: "x" }); if (opts.enabled) return expensive(); return 0; }');
    put("src/expensive.ts", 'export function expensive() { return "required if unknown"; }');
    put("src/entries.ts", 'import { conditional, mutated, escaped, closure, constructed, unrelated } from "./conditional";\nexport function mutation() { return mutated({}); }\nexport function escape() { return escaped({}); }\nexport function spread(x: object) { return conditional({ ...x }); }\nexport function callback() { return [conditional({}), invoke(conditional)]; }\nexport function effect() { const opts = {}; return conditional((mutate(opts), opts)); }\nexport function capture() { return closure({}); }\nexport function constructorEscape() { return constructed({}); }\nexport function shared() { const opts = {}; const iterator = conditional(opts); opts.enabled = true; return iterator; }\nexport function isolated() { return unrelated({}); }');
    await pipeline.run(config);
    for (const query of ["mutation", "escape", "spread", "callback", "effect", "capture", "constructorEscape", "shared"]) {
      const ctx = await tool({ action: "context", query, budget_bytes: 65536 });
      expect(ctx.items.filter((i: any) => i.kind === "source").map((i: any) => i.name)).toContain("expensive");
    }
    const isolated = await tool({ action: "context", query: "isolated", budget_bytes: 65536 });
    expect(isolated.items.filter((i: any) => i.kind === "source").map((i: any) => i.name)).not.toContain("expensive");
  });

  it("pages a large CRLF Unicode declaration without loss, then reaches later helpers at the same budget", async () => {
    const large = 'export function large() {\r\n  return "' + "😀".repeat(2500) + '";\r\n}';
    put("src/large.ts", large + '\r\nexport function small() { return 7; }');
    put("src/entry-large.ts", 'import { large, small } from "./large";\nexport function entryLarge() { return [large(), small()]; }');
    await pipeline.run(config);
    const base = { action: "context" as const, query: "entryLarge", budget_bytes: 4096 };
    const pieces: string[] = [];
    const names: string[] = [];
    let continuation: string | undefined;
    let snapshot: string | undefined;
    let count = 0;
    do {
      const result = await handleSymbolTool(repo, config, { ...base, continuation, format: "json" }, undefined, root);
      const page = JSON.parse(result.content[0]!.text);
      expect(["partial", "success"]).toContain(page.status);
      if (page.accounting.source_offset > 0) expect(page.completeness).toBe("partial");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(base.budget_bytes);
      snapshot ??= page.snapshot_id;
      expect(page.snapshot_id).toBe(snapshot);
      for (const item of page.items) if (item.kind === "source") {
        names.push(item.name);
        if (item.name === "large") {
          expect(item.fragment.start_utf16).toBe(pieces.join("").length);
          expect(item.source.text).not.toContain("\ufffd");
          pieces.push(item.source.text);
        }
      }
      continuation = page.continuation;
      expect(++count).toBeLessThan(40);
    } while (continuation);
    expect(pieces.join("")).toBe(large);
    expect(names).toContain("small");
    expect(pieces.length).toBeGreaterThan(1);
  });
});
