import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { evaluateBoundary } from "../../src/core/boundary/audit.ts";
import { pageContext } from "../../src/core/retrieval/context-page.ts";
import { calculateSimilarity } from "../../src/core/resolver/symbol-locator.ts";
import { withSymbolEvidence } from "../../src/core/retrieval/symbol-evidence.ts";
import { detectArchetype } from "../../src/core/parser/extractors/base.ts";
import { buildNavigation } from "../../src/core/discovery/navigation.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { handleLocateSymbol } from "../../src/mcp/tools/symbol.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/symbol.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { retrieveContext } from "../../src/core/retrieval/context.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";

describe("Self-critique improvements", () => {
  it("reports unlisted dependencies as warnings under warn enforcement in scope=all", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-warn-audit-"));
    try {
      mkdirSync(join(root, "src/cli"), { recursive: true });
      mkdirSync(join(root, "src/mcp"), { recursive: true });
      mkdirSync(join(root, "src/core"), { recursive: true });
      writeFileSync(join(root, "src/cli/cmd.ts"), 'import { mcpFn } from "../mcp/tool.ts";\nexport function run() { return mcpFn(); }\n');
      writeFileSync(join(root, "src/mcp/tool.ts"), "export function mcpFn() { return 1; }\n");
      writeFileSync(join(root, "src/core/base.ts"), "export const x = 1;\n");

      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn" },
        domains: {
          cli: { root: "src/cli", allowed_dependencies: ["core"], forbidden_dependencies: [] },
          mcp: { root: "src/mcp", allowed_dependencies: ["core"], forbidden_dependencies: [] },
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: ["mcp", "cli"] },
        },
      };

      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);

      const evaluator = new BoundaryEvaluator(repo);
      const res = await evaluateBoundary(evaluator, config, { scope: "all" , format: "json"}, repo, root);
      expect(res.payload.status).toBe("approved");
      expect((res.payload as any).total_violations).toBe(0);
      expect((res.payload as any).total_warnings).toBe(1);
      expect((res.payload as any).warnings[0]).toMatchObject({
        source_domain: "cli",
        target_domain: "mcp",
        rule: "disallowed_dependency",
      });
      expect(res.payload.message).toContain("1 unlisted dependency warning(s)");
      expect(res.payload.message).not.toContain("All domain boundaries are clean");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snaps pageContext source fragments to newline boundaries instead of cutting mid-identifier", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `export function helperLine${i}(value: number) { return value + ${i}; }`).join("\n");
    const result = pageContext({
      items: [
        {
          kind: "source",
          name: "bigHelper",
          reason: "direct_import_declaration",
          source: {
            file_path: "src/helper.ts",
            indexed_content_hash: "abc",
            start_line: 1,
            end_line: 40,
            text: lines,
          },
        },
      ],
      start: 0,
      sourceOffset: 0,
      budget: 2048,
      incomplete: false,
      base: { query_id: "q1", snapshot_id: "s1" },
      accounting: { omitted_by_capacity: 0, unexpanded_dependency_files: 0 },
    });

    const parsed = JSON.parse(result.content[0]!.text);
    const fragmentText: string = parsed.items[0].source.text;
    expect(fragmentText.endsWith("\n")).toBe(true);
    expect(parsed.items[0].fragment.end_utf16).toBe(fragmentText.length);
  });

  it("dampens unrelated short-word subsequence matches in calculateSimilarity", () => {
    expect(calculateSimilarity("validateProposal", "literal")).toBeLessThan(0.3);
    expect(calculateSimilarity("validateProposal", "ValidatedSeptumConfig")).toBeGreaterThan(0.35);
    expect(calculateSimilarity("recalculateTotal", "recalculateOrder")).toBeGreaterThan(0.6);
  });

  it("omits verbose capabilities by default in withSymbolEvidence and emits compact JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "septum-evidence-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), "export function foo() { return 1; }\n");
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const res = withSymbolEvidence(repo, root, { operation: "locate" }, () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "success",
              found: true,
              symbol_ref: {
                file_path: "src/a.ts",
                language: "typescript",
                name: "foo",
                kind: "function",
                signature: "foo()",
                start_line: 1,
                end_line: 1,
                indexed_content_hash: "deadbeef",
              },
            }),
          },
        ],
      }));
      const raw = res.content[0]!.text;
      expect(raw.includes("\n")).toBe(false);
      const parsed = JSON.parse(raw);
      expect(parsed.capabilities).toBeUndefined();
      expect(parsed.retrieval).toBeDefined();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects multi-language tools/usecases and adapters/providers archetypes", () => {
    expect(detectArchetype("src/mcp/tools/symbol.ts", {})).toBe("action");
    expect(detectArchetype("src/orders/usecases/create_order.py", {})).toBe("action");
    expect(detectArchetype("internal/billing/adapters/stripe.go", {})).toBe("service");
  });

  it("derives navigation health.coverage from actual index diagnostics and counts unique dependent files in impact", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-health-impact-"));
    try {
      mkdirSync(join(root, "src/core"), { recursive: true });
      mkdirSync(join(root, "src/cli"), { recursive: true });
      writeFileSync(join(root, "src/core/target.ts"), "export function targetFn() { return 42; }\n");
      writeFileSync(join(root, "src/cli/caller.ts"), 'import { targetFn } from "../core/target.ts";\nexport function run() { return targetFn(); }\n');

      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn" },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [] },
          cli: { root: "src/cli", allowed_dependencies: ["core"], forbidden_dependencies: [] },
        },
      };

      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);

      const navClean = buildNavigation(repo, {}, root);
      expect(navClean.health!.coverage).toBe("complete");
      expect(navClean.health!.reasons).toEqual([]);

      repo.setMeta("unsupported_files", JSON.stringify(["src/core/binary.kt"]));
      const navPartial = buildNavigation(repo, {}, root);
      expect(navPartial.health!.coverage).toBe("partial");
      expect(navPartial.health!.reasons).toContain("unsupported_files");

      const impact = repo.getSymbolImpact("targetFn", { workspaceRoot: root });
      expect(impact.impact_summary.affected_files_count).toBe(1);
      expect(impact.impact_summary.total_dependents).toBe(1);
      expect(impact.inbound_callers.length).toBeGreaterThanOrEqual(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("provides file-level suggestions on impact miss, supports wildcard file outline in locate, and avoids duplicate exact_symbol.signature", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-phase1-"));
    try {
      mkdirSync(join(root, "src/core"), { recursive: true });
      writeFileSync(
        join(root, "src/core/evaluator.ts"),
        "export class BoundaryEvaluator {\n  evaluate(x: number) { return x + 1; }\n  helper() { return 2; }\n}\n"
      );

      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn" },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [] },
        },
      };
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      repo.setMeta("workspace_root", root);
      const pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);

      const impactMiss = handleGetSymbolImpact(repo, config, {
        symbol: "evaluateBoundary",
        file_path: "src/core/evaluator.ts",
        workspace_path: root,
       format: "json"});
      const impactPayload = JSON.parse(impactMiss.content[0].text);
      expect(impactPayload.found_in_index).toBe(false);
      expect(impactPayload.suggestions).toContain("BoundaryEvaluator::evaluate");

      const wildcardLocate = await handleLocateSymbol(repo, config, {
        query: "*",
        file_path: "src/core/evaluator.ts",
        workspace_path: root,
       format: "json"});
      const wildcardPayload = JSON.parse(wildcardLocate.content[0].text);
      expect(wildcardPayload.found).toBe(true);
      expect(wildcardPayload.candidates.length).toBeGreaterThanOrEqual(2);

      const exactLocate = await handleLocateSymbol(repo, config, {
        query: "BoundaryEvaluator::evaluate",
        file_path: "src/core/evaluator.ts",
        workspace_path: root,
       format: "json"});
      const exactPayload = JSON.parse(exactLocate.content[0].text);
      expect(exactPayload.found).toBe(true);
      expect(exactPayload.symbol_ref.signature).toBeTruthy();
      expect(exactPayload.exact_symbol.signature).toBeUndefined();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("traces AST-verified multi-hop calls without string/type context poison and prioritizes smaller direct dependencies in deep context", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-phase2-"));
    try {
      mkdirSync(join(root, "src/core"), { recursive: true });
      writeFileSync(join(root, "src/core/types.ts"), "export interface TypeOnly { id: string }\n");
      writeFileSync(join(root, "src/core/decoy.ts"), "export function decoyFn() { return 'decoy'; }\n");
      writeFileSync(join(root, "src/core/repo.ts"), "export function repoSave(x: number) { return x * 2; }\n");
      writeFileSync(
        join(root, "src/core/service.ts"),
        'import { repoSave } from "./repo.ts";\nexport function serviceA(x: number) { return repoSave(x); }\n'
      );
      writeFileSync(
        join(root, "src/core/big.ts"),
        "export function bigFn(x: number) {\n" +
          Array.from({ length: 120 }, (_, i) => `  const v${i} = x + ${i};`).join("\n") +
          "\n  return v0;\n}\n"
      );
      writeFileSync(
        join(root, "src/core/handler.ts"),
        [
          'import type { TypeOnly } from "./types.ts";',
          'import { decoyFn } from "./decoy.ts";',
          'import { serviceA } from "./service.ts";',
          'import { bigFn } from "./big.ts";',
          "export function handleReq(input: TypeOnly) {",
          "  // decoyFn mentioned in comment only; local decoyFn shadows import",
          "  const decoyFn = () => 'shadow';",
          "  decoyFn();",
          "  const a = bigFn(1);",
          "  return a + serviceA(input.id.length);",
          "}",
        ].join("\n")
      );

      const config: ValidatedSeptumConfig = {
        version: "1.0",
        settings: { enforcement: "warn" },
        domains: {
          core: { root: "src/core", allowed_dependencies: [], forbidden_dependencies: [] },
        },
      };
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      repo.setMeta("workspace_root", root);
      const pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);

      const tracer = new CallGraphTracer(repo, root);
      const handlerFile = repo.getFileByPath("src/core/handler.ts")!;
      const handlerSym = repo.getSymbolsByFileId(handlerFile.id).find((s) => s.name === "handleReq")!;
      const chain: any[] = [{ stage: "controller", symbol: "handleReq", file: "src/core/handler.ts", line: 5, description: "handler" }];
      tracer.traverseMethodScopedDependencies(handlerFile, "", handlerSym, chain, 3);
      const symbols = chain.map((n) => n.symbol);
      expect(symbols).toContain("serviceA");
      expect(symbols).toContain("repoSave");
      expect(symbols).not.toContain("decoyFn");
      expect(symbols).not.toContain("TypeOnly");
      const serviceNode = chain.find((n) => n.symbol === "serviceA");
      expect(serviceNode?.relationship?.kind).toBe("calls");
      expect(serviceNode?.relationship?.reason).toBe("ast_call_site");

      const ctxRes = await retrieveContext(repo, config, { query: "handleReq", file_path: "src/core/handler.ts", budget_bytes: 16384 }, root);
      const ctxPayload = JSON.parse(ctxRes.content[0].text);
      const itemNames = ctxPayload.items.filter((i: any) => i.kind === "source").map((i: any) => i.name);
      expect(itemNames[0]).toBe("handleReq");
      expect(itemNames.indexOf("serviceA")).toBeLessThan(itemNames.indexOf("bigFn"));
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
