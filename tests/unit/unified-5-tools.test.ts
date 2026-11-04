import { describe, expect, it } from "bun:test";
import {
  MapToolSchema,
  SymbolToolSchema,
  SliceToolSchema,
  BoundaryToolSchema,
} from "../../src/mcp/schemas.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { handleMapTool } from "../../src/mcp/tools/map.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { handleSliceTool } from "../../src/mcp/tools/slice.ts";
import { handleBoundaryTool } from "../../src/mcp/tools/boundary.ts";

describe("Unified 4 MCP Tools Suite", () => {
  const db = new SeptumDatabase(":memory:");
  const repo = new SeptumRepository(db.raw);
  const config = ConfigLoader.load(undefined, process.cwd());
  const evaluator = new BoundaryEvaluator(repo);

  describe("1. septum_map (catalog, register)", () => {
    it("should parse default action as catalog", () => {
      const parsed = MapToolSchema.parse({});
      expect(parsed.action).toBe("catalog");
      expect(parsed.detail_level).toBe("compact");
    });

    it("should infer register action when root is provided", () => {
      const parsed = MapToolSchema.parse({
        domain: "billing",
        root: "src/billing",
        ingest_now: false,
      });
      expect(parsed.action).toBe("register");
      expect(parsed.domain).toBe("billing");
      expect(parsed.root).toBe("src/billing");
    });

    it("should register domain via handleMapTool", async () => {
      const res = await handleMapTool(repo, config, {
        action: "register",
        domain: "orders",
        root: "src/orders",
      });
      expect(res.content[0].text).toContain('"status": "success"');
      expect(res.content[0].text).toContain('"domain": "orders"');
    });

    it("should retrieve domain catalog via handleMapTool", async () => {
      const res = await handleMapTool(repo, config, {
        action: "catalog",
        domain: "orders",
      });
      expect(res.content[0].text).toBeDefined();
    });
  });

  describe("2. septum_symbol (locate, context, inspect alias, impact)", () => {
    it("should parse default action as locate", () => {
      const parsed = SymbolToolSchema.parse({ query: "OrderService" });
      expect(parsed.action).toBe("locate");
      expect(parsed.query).toBe("OrderService");
    });

    it("should accept inspect action as supported action", () => {
      const parsed = SymbolToolSchema.parse({ action: "inspect", query: "OrderService" });
      expect(parsed.action).toBe("inspect");
    });

    it("should execute locate and impact via handleSymbolTool", async () => {
      const locateRes = await handleSymbolTool(repo, config, {
        action: "locate",
        query: "calculateTotal",
      });
      expect(locateRes.content[0].text).toBeDefined();

      const impactRes = await handleSymbolTool(repo, config, {
        action: "impact",
        query: "calculateTotal",
      });
      expect(impactRes.content[0].text).toBeDefined();
    });
  });

  describe("3. septum_slice", () => {
    it("should parse slice query and clamp depth", () => {
      const parsed = SliceToolSchema.parse({
        query: "POST /orders",
        max_depth: 10,
      });
      expect(parsed.query).toBe("POST /orders");
      expect(parsed.max_depth).toBe(8);
    });

    it("should execute trace slice via handleSliceTool", async () => {
      const res = await handleSliceTool(repo, config, {
        query: "POST /api/orders",
      });
      expect(res.content[0].text).toBeDefined();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.query).toBe("POST /api/orders");
    });
  });

  describe("4. septum_boundary", () => {
    it("should parse boundary check args", () => {
      const parsed = BoundaryToolSchema.parse({
        file_path: "src/orders/service.ts",
        proposed_imports: ["src/billing/service.ts"],
      });
      expect(parsed.file_path).toBe("src/orders/service.ts");
      expect(parsed.proposed_imports).toContain("src/billing/service.ts");
    });

    it("should audit boundaries via handleBoundaryTool", async () => {
      const res = await handleBoundaryTool(evaluator, config, {
        file_path: "src/orders/service.ts",
        proposed_imports: [],
      }, repo);
      expect(res.content[0].text).toBeDefined();
    });
  });
});
