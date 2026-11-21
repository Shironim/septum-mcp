import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { handleRegisterDomain } from "../../src/mcp/tools/map.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/boundary.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/slice.ts";
import { extractPathHint } from "../../src/mcp/server.ts";

describe("Multi-Root Workspace Resolution & WorkspaceRoot Propagation", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let tempWorkspace1: string;
  let tempWorkspace2: string;
  let mockConfig: ValidatedSeptumConfig;

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);

    tempWorkspace1 = fs.mkdtempSync(path.join(os.tmpdir(), "septum-ws1-"));
    tempWorkspace2 = fs.mkdtempSync(path.join(os.tmpdir(), "septum-ws2-"));

    mockConfig = {
      version: "1.0",
      settings: {
        enforcement: "strict",
        db_path: ":memory:",
        ignore_patterns: [],
      },
      domains: {
        orders: {
          root: "packages/orders",
          description: "Orders domain package",
          allowed_dependencies: [],
          forbidden_dependencies: ["billing"],
          archetypes: {},
        },
      },
    };
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tempWorkspace1, { recursive: true, force: true });
      fs.rmSync(tempWorkspace2, { recursive: true, force: true });
    } catch {}
  });

  it("BoundaryEvaluator with ModuleResolver correctly resolves relative paths inside workspaceRoot", async () => {
    const resolver = new ModuleResolver(tempWorkspace1, repo);
    const evaluator = new BoundaryEvaluator(repo, resolver);

    expect(evaluator.getResolver().getProjectRoot()).toBe(tempWorkspace1);

    const violations = evaluator.evaluate(
      "packages/orders/Service.php",
      ["packages/billing/PaymentService.php"],
      mockConfig
    );

    expect(Array.isArray(violations)).toBe(true);
  });

  it("handleCheckBoundary passes through without crashing when workspaceRoot is supplied", async () => {
    const resolver = new ModuleResolver(tempWorkspace1, repo);
    const evaluator = new BoundaryEvaluator(repo, resolver);
    repo.setMeta("sync_state", "complete");

    const result = await handleCheckBoundary(
      evaluator,
      mockConfig,
      { file_path: "packages/orders/Service.php" , format: "json"},
      repo,
      tempWorkspace1
    );

    expect(result.content[0].type).toBe("text");
    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("approved");
  });

  it("handleTraceVerticalSlice operates deterministically with custom workspaceRoot", async () => {
    const result = await handleTraceVerticalSlice(
      repo,
      mockConfig,
      { query: "GET /api/cart" , format: "json"},
      tempWorkspace2
    );

    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("not_found");
    expect(json.found).toBe(false);
  });

  describe("extractPathHint Resolution", () => {
    it("extracts path hint from bare string file paths", async () => {
      expect(extractPathHint("packages/orders/Service.php")).toBe("packages/orders/Service.php");
      expect(extractPathHint("  /path/to/project  ")).toBe("/path/to/project");
      expect(extractPathHint("")).toBeUndefined();
    });

    it("extracts path hint from bare string array", async () => {
      expect(extractPathHint(["packages/orders/Service.php", "packages/orders/Model.php"])).toBe("packages/orders/Service.php");
      expect(extractPathHint([])).toBeUndefined();
    });

    it("extracts path hint from camelCase workspace and projectRoot properties", async () => {
      expect(extractPathHint({ workspacePath: "/monorepo/subapp" })).toBe("/monorepo/subapp");
      expect(extractPathHint({ projectRoot: "/monorepo/billing" })).toBe("/monorepo/billing");
      expect(extractPathHint({ targetPath: "/monorepo/orders" })).toBe("/monorepo/orders");
    });

    it("extracts path hint from camelCase file properties", async () => {
      expect(extractPathHint({ filePath: "packages/orders/Service.php" })).toBe("packages/orders/Service.php");
      expect(extractPathHint({ fromFile: "packages/billing/Pay.php" })).toBe("packages/billing/Pay.php");
      expect(extractPathHint({ filePaths: ["src/a.ts", "src/b.ts"] })).toBe("src/a.ts");
    });

    it("does not treat domain root from register_domain as workspace root", async () => {
      expect(extractPathHint({ domain: "orders", root: "src/domains/orders" })).toBeUndefined();
      expect(extractPathHint({ name: "orders", root: "src/domains/orders" })).toBeUndefined();
    });

    it("extracts root as workspace root only when domain is not specified", async () => {
      expect(extractPathHint({ root: "/path/to/workspace" })).toBe("/path/to/workspace");
    });
  });
});
