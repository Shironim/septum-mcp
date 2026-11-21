import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { handleGetSymbol } from "../../src/mcp/tools/symbol.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { shouldIgnoreSourcePath } from "../../src/core/resources/ignore.ts";
import { SEPTUM_POST_WRITE_SCRIPT } from "../../src/cli/templates/hooks.ts";

describe("Septum MCP Server Improvements Regression Suite", () => {
  let tempDir: string;
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "septum-improvements-"));
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 1. Hollow Slicing & Transitive Delegator Expansion
  describe("Item 1: Hollow Slicing & Transitive Delegator Expansion", () => {
    it("expands 1-hop transitive delegated implementation for short delegator method", async () => {
      mkdirSync(join(tempDir, "app", "Services"), { recursive: true });
      mkdirSync(join(tempDir, "app", "Actions"), { recursive: true });

      const serviceCode = `<?php
namespace App\\Services;
use App\\Actions\\RecordPembayaranAction;

class PenjualanService {
    public function __construct(
        protected RecordPembayaranAction $recordPembayaranAction
    ) {}

    public function recordPembayaran(int $penjualanId, array $data): PembayaranPenjualan
    {
        $pembayaran = $this->recordPembayaranAction->execute($penjualanId, $data);
        $this->clearSalesCache(null, false);
        return $pembayaran;
    }
}
`;
      const actionCode = `<?php
namespace App\\Actions;

class RecordPembayaranAction {
    public function execute(int $penjualanId, array $data): PembayaranPenjualan
    {
        // Actual core business logic: nominal validation, cash mutation, status update
        $penjualan = Penjualan::findOrFail($penjualanId);
        $pembayaran = PembayaranPenjualan::create($data);
        $penjualan->update(['status' => 'lunas']);
        return $pembayaran;
    }
}
`;
      writeFileSync(join(tempDir, "app", "Services", "PenjualanService.php"), serviceCode);
      writeFileSync(join(tempDir, "app", "Actions", "RecordPembayaranAction.php"), actionCode);

      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "app", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, tempDir);
      await pipeline.run(config);

      const result = handleGetSymbol(
        repo,
        config,
        {
          symbol: "PenjualanService::recordPembayaran",
          include_source: true,
         format: "json"},
        tempDir
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.source_slice).toBeDefined();
      expect(parsed.source_slice.status).toBe("current");
      expect(parsed.source_slice.related_dependency_analysis).toBe("delegated_implementation_expanded");
      expect(parsed.source_slice.delegated_implementation).toBeDefined();
      expect(parsed.source_slice.delegated_implementation.symbol).toContain("RecordPembayaranAction::execute");
      expect(parsed.source_slice.delegated_implementation.text).toContain("Actual core business logic");
    });
  });

  // 2. Eliminasi File-Level Blurring pada septum_slice
  describe("Item 2: Method-scoped Call Tracing on septum_slice", () => {
    it("excludes uncalled static imports from method-scoped execution chain", async () => {
      mkdirSync(join(tempDir, "app", "Http", "Controllers"), { recursive: true });
      mkdirSync(join(tempDir, "app", "Http", "Requests"), { recursive: true });
      mkdirSync(join(tempDir, "app", "Services"), { recursive: true });
      mkdirSync(join(tempDir, "app", "Actions"), { recursive: true });

      const controllerCode = `<?php
namespace App\\Http\\Controllers;

use App\\Http\\Requests\\StorePenjualanRequest;
use App\\Http\\Requests\\UpdatePenjualanRequest;
use App\\Http\\Requests\\BayarRequest;
use App\\Services\\LaptopService;
use App\\Services\\ProductService;
use App\\Actions\\RecordPembayaranAction;

class PenjualanController {
    public function bayar(BayarRequest $request, RecordPembayaranAction $action)
    {
        return $action->execute($request->validated());
    }

    public function store(StorePenjualanRequest $request, LaptopService $laptop)
    {
        return $laptop->create($request->all());
    }
}
`;
      const bayarReq = `<?php namespace App\\Http\\Requests; class BayarRequest {}`;
      const storeReq = `<?php namespace App\\Http\\Requests; class StorePenjualanRequest {}`;
      const laptopSvc = `<?php namespace App\\Services; class LaptopService {}`;
      const actionCode = `<?php namespace App\\Actions; class RecordPembayaranAction { public function execute($data) {} }`;

      writeFileSync(join(tempDir, "app", "Http", "Controllers", "PenjualanController.php"), controllerCode);
      writeFileSync(join(tempDir, "app", "Http", "Requests", "BayarRequest.php"), bayarReq);
      writeFileSync(join(tempDir, "app", "Http", "Requests", "StorePenjualanRequest.php"), storeReq);
      writeFileSync(join(tempDir, "app", "Services", "LaptopService.php"), laptopSvc);
      writeFileSync(join(tempDir, "app", "Actions", "RecordPembayaranAction.php"), actionCode);

      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "app", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, tempDir);
      await pipeline.run(config);

      const tracer = new CallGraphTracer(repo, tempDir);
      tracer.initMaps();

      const bayarChain = tracer.expandChainFromMethod(
        "app/Http/Controllers/PenjualanController.php",
        "bayar",
        [],
        3
      );

      const bayarSymbols = bayarChain.map((node) => node.symbol);
      expect(bayarSymbols.some((s) => s.includes("BayarRequest"))).toBe(true);
      expect(bayarSymbols.some((s) => s.includes("RecordPembayaranAction"))).toBe(true);
      // Must NOT contain uncalled file-level imports:
      expect(bayarSymbols.some((s) => s.includes("StorePenjualanRequest"))).toBe(false);
      expect(bayarSymbols.some((s) => s.includes("UpdatePenjualanRequest"))).toBe(false);
      expect(bayarSymbols.some((s) => s.includes("LaptopService"))).toBe(false);
      expect(bayarSymbols.some((s) => s.includes("ProductService"))).toBe(false);
    });

    it("excludes non-executable symbols (constants, interfaces, types, schemas) from execution chain nodes", async () => {
      mkdirSync(join(tempDir, "src"), { recursive: true });

      writeFileSync(
        join(tempDir, "src", "limits.ts"),
        "export const RESOURCE_LIMITS = { maxBytes: 1024, maxDepth: 5 };\n"
      );
      writeFileSync(
        join(tempDir, "src", "types.ts"),
        "export interface UserInterface { id: string; name: string; }\nexport type UserType = UserInterface;\n"
      );
      writeFileSync(
        join(tempDir, "src", "service.ts"),
        "export class UserService {\n  public getUser(id: string) { return { id, name: 'Alice' }; }\n}\n"
      );
      writeFileSync(
        join(tempDir, "src", "controller.ts"),
        [
          'import { RESOURCE_LIMITS } from "./limits";',
          'import type { UserInterface, UserType } from "./types";',
          'import { UserService } from "./service";',
          "export class UserController {",
          "  constructor(private service: UserService) {}",
          "  public handle(id: string): UserType {",
          "    if (id.length > RESOURCE_LIMITS.maxBytes) throw new Error();",
          "    return this.service.getUser(id);",
          "  }",
          "}",
        ].join("\n")
      );

      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        core: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, tempDir);
      await pipeline.run(config);

      const tracer = new CallGraphTracer(repo, tempDir);
      tracer.initMaps();

      const chain = tracer.expandChainFromMethod("src/controller.ts", "handle", [], 3);
      const chainSymbols = chain.map((n) => n.symbol);
      const chainFiles = chain.map((n) => n.file);

      // Must include the executable UserService class:
      expect(chainSymbols).toContain("UserService");
      expect(chainFiles).toContain("src/service.ts");

      // Must NOT include constants, types, or interfaces:
      expect(chainSymbols).not.toContain("RESOURCE_LIMITS");
      expect(chainSymbols).not.toContain("UserInterface");
      expect(chainSymbols).not.toContain("UserType");
      expect(chainFiles).not.toContain("src/limits.ts");
      expect(chainFiles).not.toContain("src/types.ts");
    });
  });

  // 4. Permission Error Handling & Default Ignored Directories
  describe("Item 4: Permission error handling & Default Ignored Dirs", () => {
    it("ignores storage, public/storage, and .toolbench by default", () => {
      expect(shouldIgnoreSourcePath("storage/framework/cache/data.php")).toBe(true);
      expect(shouldIgnoreSourcePath("public/storage/uploads/img.png")).toBe(true);
      expect(shouldIgnoreSourcePath(".toolbench/state.json")).toBe(true);
    });
  });

  // 5. ConfigLoader disk priority & settings_json sync
  describe("Item 5: ConfigLoader physical file priority", () => {
    it("loads directly from septum.config.json and syncs settings to repo_meta", () => {
      const diskConfig = {
        version: "1.0",
        settings: {
          enforcement: "strict",
          db_path: ".septum/test.db",
          ignore_patterns: ["custom_ignore/**"],
        },
        domains: {
          custom_domain: {
            root: "src/custom",
            allowed_dependencies: [],
            forbidden_dependencies: [],
            archetypes: {},
          },
        },
      };
      writeFileSync(join(tempDir, "septum.config.json"), JSON.stringify(diskConfig, null, 2));

      const loaded = ConfigLoader.load(undefined, tempDir);
      expect(loaded.settings.enforcement).toBe("strict");
      expect(loaded.settings.ignore_patterns).toContain("custom_ignore/**");
      expect(loaded.domains.custom_domain).toBeDefined();
    });
  });

  // 6. Polyglot Delegator Expansion (Python & Go)
  describe("Item 6: Polyglot 1-Hop Delegator Expansion (Python & Go)", () => {
    it("expands 1-hop delegated implementation for Python self.<prop>.<method>(", async () => {
      mkdirSync(join(tempDir, "app", "controllers"), { recursive: true });
      mkdirSync(join(tempDir, "app", "services"), { recursive: true });

      const pyController = [
        "from app.services.order_service import OrderService",
        "",
        "class OrderController:",
        "    def __init__(self, order_service: OrderService):",
        "        self.order_service = order_service",
        "",
        "    def submit(self, payload: dict):",
        "        return self.order_service.create_order(payload)",
      ].join("\n");

      const pyService = [
        "class OrderService:",
        "    def create_order(self, payload: dict):",
        "        # Python core order persistence logic",
        "        return {'status': 'created', 'payload': payload}",
      ].join("\n");

      writeFileSync(join(tempDir, "app", "controllers", "order_controller.py"), pyController);
      writeFileSync(join(tempDir, "app", "services", "order_service.py"), pyService);

      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "app", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, tempDir);
      await pipeline.run(config);

      const result = handleGetSymbol(
        repo,
        config,
        {
          symbol: "OrderController::submit",
          include_source: true,
         format: "json"},
        tempDir
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.source_slice?.status).toBe("current");
      expect(parsed.source_slice?.related_dependency_analysis).toBe("delegated_implementation_expanded");
      expect(parsed.source_slice?.delegated_implementation?.symbol).toContain("OrderService::create_order");
      expect(parsed.source_slice?.delegated_implementation?.text).toContain("Python core order persistence logic");
    });

    it("expands 1-hop delegated implementation for Go receiver.<prop>.<Method>(", async () => {
      mkdirSync(join(tempDir, "internal", "orders"), { recursive: true });

      const goHandler = [
        "package orders",
        "",
        "type OrderHandler struct {",
        "    orderService *OrderService",
        "}",
        "",
        "func (h *OrderHandler) Create(id string) error {",
        "    return h.orderService.ProcessOrder(id)",
        "}",
      ].join("\n");

      const goService = [
        "package orders",
        "",
        "type OrderService struct {}",
        "",
        "func (s *OrderService) ProcessOrder(id string) error {",
        "    // Go core order processing logic",
        "    return nil",
        "}",
      ].join("\n");

      writeFileSync(join(tempDir, "internal", "orders", "handler.go"), goHandler);
      writeFileSync(join(tempDir, "internal", "orders", "service.go"), goService);

      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        orders: { root: "internal/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, tempDir);
      await pipeline.run(config);

      const result = handleGetSymbol(
        repo,
        config,
        {
          symbol: "OrderHandler::Create",
          include_source: true,
         format: "json"},
        tempDir
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.source_slice?.status).toBe("current");
      expect(parsed.source_slice?.related_dependency_analysis).toBe("delegated_implementation_expanded");
      expect(parsed.source_slice?.delegated_implementation?.file_path).toBe("internal/orders/service.go");
      expect(parsed.source_slice?.delegated_implementation?.text).toContain("Go core order processing logic");
    });
  });

  // 7. Same-File & Same-Package Impact Detection
  describe("Item 7: Same-File and Same-Package Inbound Callers in getSymbolImpact", () => {
    it("detects same-file callers outside target declaration and same-package Go/PHP callers without explicit imports", async () => {
      mkdirSync(join(tempDir, "internal", "billing"), { recursive: true });

      const goService = [
        "package billing",
        "",
        "type InvoiceService struct {}",
        "",
        "func (s *InvoiceService) CalculateTax(amount int) int {",
        "    return amount / 10",
        "}",
        "",
        "func (s *InvoiceService) BuildInvoice(amount int) int {",
        "    return amount + s.CalculateTax(amount)",
        "}",
      ].join("\n");

      const goHandler = [
        "package billing",
        "",
        "type InvoiceHandler struct {",
        "    svc *InvoiceService",
        "}",
        "",
        "func (h *InvoiceHandler) HandleCheckout(amount int) int {",
        "    return h.svc.CalculateTax(amount)",
        "}",
      ].join("\n");

      writeFileSync(join(tempDir, "internal", "billing", "service.go"), goService);
      writeFileSync(join(tempDir, "internal", "billing", "handler.go"), goHandler);

      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        billing: { root: "internal/billing", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, tempDir);
      await pipeline.run(config);

      const impact = repo.getSymbolImpact("InvoiceService::CalculateTax", { workspaceRoot: tempDir });
      expect(impact.found_in_index).toBe(true);
      const callerFiles = impact.inbound_callers.map((c) => c.file);
      expect(callerFiles).toContain("internal/billing/service.go");
      expect(callerFiles).toContain("internal/billing/handler.go");

      const sameFileCaller = impact.inbound_callers.find((c) => c.file === "internal/billing/service.go");
      expect(sameFileCaller?.line).toBe(10);
      expect(sameFileCaller?.domain).toBe("billing");

      const samePkgCaller = impact.inbound_callers.find((c) => c.file === "internal/billing/handler.go");
      expect(samePkgCaller?.line).toBe(8);
      expect(samePkgCaller?.domain).toBe("billing");
    });
  });

  // 8. Post-Write Hook Coalescing Lockfile
  describe("Item 8: Post-Write Hook Coalescing Lockfile", () => {
    it("includes non-blocking sync.lock and sync.pending coalescing in SEPTUM_POST_WRITE_SCRIPT", () => {
      expect(SEPTUM_POST_WRITE_SCRIPT).toContain(".septum/sync.lock");
      expect(SEPTUM_POST_WRITE_SCRIPT).toContain(".septum/sync.pending");
      expect(SEPTUM_POST_WRITE_SCRIPT).toContain('mkdir "$LOCK_DIR"');
    });
  });
});
