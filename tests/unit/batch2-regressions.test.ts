import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectArchetype } from "../../src/core/parser/extractors/base.ts";
import { analyzeSymbolImpact } from "../../src/core/resolver/symbol-impact.ts";

describe("Batch 2 regressions: archetype & polyglot impact call_sites", () => {
  it("classifies Models/Service.php, handler.go, and excludes tests/UI components from action/route", () => {
    expect(detectArchetype("app/Models/Service.php", {})).toBe("model");
    expect(detectArchetype("app/Console/Commands/AuditServiceDeposits.php", {})).toBe("action");
    expect(detectArchetype("apps/api/internal/invoice/handler.go", {})).toBe("controller");
    expect(detectArchetype("apps/api/cmd/server/routes_test.go", {})).toBe("unknown");
    expect(detectArchetype("apps/web/tests/cash-actions.test.mjs", {})).toBe("unknown");
    expect(detectArchetype("apps/web/app/components/shared/FormActions.vue", {})).toBe("unknown");
    expect(detectArchetype("app/Actions/Penjualan/CreateSaleAction.php", {})).toBe("action");
  });

  it("extracts PHP method and Go function call_sites when queried by bare symbol name", () => {
    const root = mkdtempSync(join(tmpdir(), "septum-impact-b2-"));
    try {
      const write = (rel: string, content: string) => {
        const full = join(root, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      };

      write("app/Support/ErrorLogger.php", "<?php\nclass ErrorLogger {\n  public static function error() {}\n  public static function warning() {}\n}\n");
      write("app/Services/SaleService.php", "<?php\nuse App\\Support\\ErrorLogger;\nclass SaleService {\n  public function run() {\n    ErrorLogger::error();\n  }\n}\n");
      write("app/Http/Controllers/MetricsController.php", "<?php\nuse App\\Support\\ErrorLogger;\nclass MetricsController {\n  public function index() {\n    ErrorLogger::warning();\n    $this->error();\n  }\n}\n");

      const phpImpact = analyzeSymbolImpact({
        query: "error",
        container: "error",
        method: "",
        targets: [{ name: "App\\Support\\ErrorLogger::error", kind: "method", signature: "public static function error()", line_start: 3, line_end: 3, file_path: "app/Support/ErrorLogger.php" }],
        dependencies: [
          { file: "app/Services/SaleService.php", line_number: 2, domain_name: "app" },
          { file: "app/Http/Controllers/MetricsController.php", line_number: 2, domain_name: "app" },
        ],
        samePackageFiles: new Set(),
        symbolsByFile: new Map([
          ["app/Services/SaleService.php", [{ name: "SaleService::run", kind: "method", signature: "public function run()", line_start: 4, line_end: 6 }]],
          ["app/Http/Controllers/MetricsController.php", [{ name: "MetricsController::index", kind: "method", signature: "public function index()", line_start: 4, line_end: 6 }]],
        ]),
        domainsByFile: new Map([
          ["app/Services/SaleService.php", "app"],
          ["app/Http/Controllers/MetricsController.php", "app"],
        ]),
        workspaceRoot: root,
      });

      const phpCallSites = phpImpact.inbound_callers.filter((c) => c.kind === "call");
      expect(phpCallSites).toEqual([
        { file: "app/Services/SaleService.php", caller: "SaleService::run", line: 5, kind: "call", domain: "app" },
      ]);

      write("internal/response/response.go", "package response\nfunc JSON() {}\nfunc Error() {}\n");
      write("internal/invoice/handler.go", "package invoice\nfunc List() {\n  response.JSON()\n}\n");
      write("internal/auth/middleware.go", "package auth\nfunc Guard() {\n  response.Error()\n}\n");

      const goImpact = analyzeSymbolImpact({
        query: "JSON",
        container: "JSON",
        method: "",
        targets: [{ name: "JSON", kind: "function", line_start: 2, line_end: 2, file_path: "internal/response/response.go" }],
        dependencies: [
          { file: "internal/invoice/handler.go", line_number: 1, domain_name: "api" },
          { file: "internal/auth/middleware.go", line_number: 1, domain_name: "api" },
        ],
        samePackageFiles: new Set(),
        symbolsByFile: new Map([
          ["internal/invoice/handler.go", [{ name: "List", kind: "function", signature: "func List()", line_start: 2, line_end: 4 }]],
          ["internal/auth/middleware.go", [{ name: "Guard", kind: "function", signature: "func Guard()", line_start: 2, line_end: 4 }]],
        ]),
        domainsByFile: new Map([
          ["internal/invoice/handler.go", "api"],
          ["internal/auth/middleware.go", "api"],
        ]),
        workspaceRoot: root,
      });

      const goCallSites = goImpact.inbound_callers.filter((c) => c.kind === "call");
      expect(goCallSites).toEqual([
        { file: "internal/invoice/handler.go", caller: "List", line: 3, kind: "call", domain: "api" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
