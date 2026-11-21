import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { handleGetSymbol } from "../../src/mcp/tools/symbol.ts";
import { handleLocateSymbol } from "../../src/mcp/tools/symbol.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";

describe("Resolved Outbound Calls & Complexity Smells", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let tmpDir: string;
  let callerFilePath: string;
  let targetFilePath: string;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: ":memory:",
      ignore_patterns: [],
    },
    domains: {
      billing: {
        root: "app",
      },
    },
    features: {},
  };

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-"));
    callerFilePath = path.join(tmpDir, "OrderController.php");
    targetFilePath = path.join(tmpDir, "PaymentService.php");

    // Write source code with outbound static call
    const callerCode = `<?php
class OrderController {
  public function submit() {
    $amount = 100;
    PaymentService::charge($amount);
    return true;
  }
}
`;
    fs.writeFileSync(callerFilePath, callerCode);
    fs.writeFileSync(targetFilePath, "<?php class PaymentService { public static function charge($a) {} }");

    // Seed database
    db.raw.run(
      "INSERT INTO domains (id, name, root_path, allowed_deps_json, forbidden_deps_json, archetypes_json) VALUES (?, ?, ?, ?, ?, ?)",
      [1, "billing", tmpDir, "[]", "[]", "{}"]
    );

    db.raw.run(
      "INSERT INTO files (id, domain_id, path, archetype, content_hash, line_count, mtime_ms, size_bytes, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [1, 1, callerFilePath, "controller", "hash1", 400, Date.now(), 500, new Date().toISOString()]
    );

    db.raw.run(
      "INSERT INTO files (id, domain_id, path, archetype, content_hash, line_count, mtime_ms, size_bytes, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [2, 1, targetFilePath, "service", "hash2", 100, Date.now(), 200, new Date().toISOString()]
    );

    // Caller symbol: OrderController::submit with line_count = 350 (> 300)
    db.raw.run(
      "INSERT INTO symbols (id, file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [1, 1, "OrderController::submit", "method", "public function submit()", "public", 3, 352, 350, 1]
    );

    // Target symbol: PaymentService::charge
    db.raw.run(
      "INSERT INTO symbols (id, file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [2, 2, "PaymentService::charge", "method", "public static function charge($a)", "public", 45, 80, 36, 1]
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves outbound calls to target symbols with exact line ranges", () => {
    const details = repo.getSymbolDetails("OrderController::submit");
    expect(details).toBeDefined();
    expect(details?.symbol).toBe("OrderController::submit");

    // Backward compatibility: outbound_calls as strings
    expect(details?.outbound_calls).toContain("PaymentService::charge");

    // Resolved outbound calls with target line ranges
    expect(details?.resolved_outbound_calls).toBeDefined();
    const resolved = details?.resolved_outbound_calls?.find((c) => c.symbol === "PaymentService::charge");
    expect(resolved).toBeDefined();
    expect(resolved?.is_resolved).toBe(true);
    expect(resolved?.target_file).toBe(targetFilePath);
    expect(resolved?.target_range).toEqual({
      start_line: 45,
      end_line: 80,
      total_lines: 36,
    });
    expect(resolved?.domain).toBe("billing");
  });

  it("detects high-complexity smell when symbol exceeds 300 lines", () => {
    const details = repo.getSymbolDetails("OrderController::submit");
    expect(details?.complexity_smell).toBeDefined();
    expect(details?.complexity_smell?.is_high_complexity).toBe(true);
    expect(details?.complexity_smell?.threshold).toBe(300);
    expect(details?.complexity_smell?.total_lines).toBe(350);
    expect(details?.complexity_smell?.warning).toContain("exceeds 300-line threshold");
  });

  it("propagates complexity smell to locate-symbol MCP handler", async () => {
    const res = await handleLocateSymbol(repo, mockConfig, {
      query: "OrderController::submit",
      workspace_path: tmpDir,
     format: "json"});

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.found).toBe(true);
    expect(parsed.complexity_smell).toBeDefined();
    expect(parsed.complexity_smell?.is_high_complexity).toBe(true);
    expect(parsed.exact_symbol?.total_lines).toBe(350);
    expect(parsed.summary).toContain("High-Complexity Smell");
  });

  it("extracts TypeScript parameter type annotations and resolves typed-parameter and direct function outbound calls", () => {
    const tsCallerPath = path.join(tmpDir, "handler.ts");
    const tsRepoPath = path.join(tmpDir, "repo.ts");
    const tsValidatorPath = path.join(tmpDir, "validator.ts");

    fs.writeFileSync(
      tsCallerPath,
      [
        'import type { OrderRepository } from "./repo";',
        'import { validatePayload, unusedHelper } from "./validator";',
        "export async function handleOrder(repo: OrderRepository, id: string, signal?: AbortSignal) {",
        "  const ok = validatePayload(id);",
        "  if (!ok) return false;",
        "  return repo.saveOrder(id);",
        "}",
      ].join("\n")
    );
    fs.writeFileSync(
      tsRepoPath,
      "export class OrderRepository {\n  saveOrder(id: string) { return true; }\n}\n"
    );
    fs.writeFileSync(
      tsValidatorPath,
      [
        "export function alphaDecoy() { return 0; }",
        "export function validatePayload(id: string) { return id.length > 0; }",
        "export function unusedHelper() { return false; }",
      ].join("\n")
    );

    db.raw.run(
      "INSERT INTO files (id, domain_id, path, archetype, content_hash, line_count, mtime_ms, size_bytes, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [3, 1, tsCallerPath, "controller", "hash3", 8, Date.now(), 240, new Date().toISOString()]
    );
    db.raw.run(
      "INSERT INTO files (id, domain_id, path, archetype, content_hash, line_count, mtime_ms, size_bytes, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [4, 1, tsRepoPath, "repository", "hash4", 3, Date.now(), 100, new Date().toISOString()]
    );
    db.raw.run(
      "INSERT INTO files (id, domain_id, path, archetype, content_hash, line_count, mtime_ms, size_bytes, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [5, 1, tsValidatorPath, "service", "hash5", 3, Date.now(), 140, new Date().toISOString()]
    );

    db.raw.run(
      "INSERT INTO symbols (id, file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [3, 3, "handleOrder", "function", "handleOrder(repo: OrderRepository, id: string, signal?: AbortSignal)", "public", 3, 7, 5, 0]
    );
    db.raw.run(
      "INSERT INTO symbols (id, file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [4, 4, "OrderRepository::saveOrder", "method", "saveOrder(id: string)", "public", 2, 2, 1, 1]
    );
    db.raw.run(
      "INSERT INTO symbols (id, file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [5, 5, "alphaDecoy", "function", "alphaDecoy()", "public", 1, 1, 1, 0]
    );
    db.raw.run(
      "INSERT INTO symbols (id, file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [6, 5, "validatePayload", "function", "validatePayload(id: string)", "public", 2, 2, 1, 0]
    );
    db.raw.run(
      "INSERT INTO symbols (id, file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [7, 5, "unusedHelper", "function", "unusedHelper()", "public", 3, 3, 1, 0]
    );

    repo.replaceFileDependencies(3, [
      { target: "./repo", statement: 'import type { OrderRepository } from "./repo";', line_number: 1, is_external: false },
      { target: "./validator", statement: 'import { validatePayload } from "./validator";', line_number: 2, is_external: false },
    ]);

    const details = repo.getSymbolDetails("handleOrder");
    expect(details).toBeDefined();
    expect(details?.dependencies_injected).toEqual(["OrderRepository"]);
    expect(details?.outbound_calls).toContain("OrderRepository::saveOrder");
    expect(details?.outbound_calls).toContain("validatePayload");
    expect(details?.outbound_calls).not.toContain("unusedHelper");
    expect(details?.resolved_outbound_calls?.find((c) => c.symbol === "OrderRepository::saveOrder")?.is_resolved).toBe(true);
    expect(details?.resolved_outbound_calls?.find((c) => c.symbol === "validatePayload")?.is_resolved).toBe(true);

    // Verify CallGraphTracer selects the imported symbol (validatePayload) instead of first alphabetical (alphaDecoy)
    const tracer = new CallGraphTracer(repo, tmpDir);
    tracer.initMaps();
    const chain = tracer.expandChainFromFile(tsCallerPath, [], 2);
    expect(chain.some((step) => step.symbol === "validatePayload")).toBe(true);
    expect(chain.some((step) => step.symbol === "alphaDecoy")).toBe(false);
  });
});
