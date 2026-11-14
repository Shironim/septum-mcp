import { describe, expect, it } from "bun:test";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";

describe("BoundaryEvaluator", () => {
  const db = new SeptumDatabase(":memory:");
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: ":memory:",
      ignore_patterns: [],
    },
    domains: {
      billing: {
        root: "src/domains/billing",
        description: "Billing domain",
        allowed_dependencies: ["identity"],
        forbidden_dependencies: ["orders"],
        archetypes: {},
      },
      orders: {
        root: "src/domains/orders",
        description: "Orders domain",
        allowed_dependencies: ["billing"],
        forbidden_dependencies: ["identity"],
        archetypes: {},
      },
      identity: {
        root: "src/domains/identity",
        description: "Identity domain",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      },
    },
    features: {
      checkout_flow: {
        domain: "orders",
        description: "Checkout workflow",
        allowed_touchpoints: [
          "src/domains/orders/services/CheckoutService.ts",
          "src/domains/orders/controllers/**",
        ],
        reuse_symbols: ["PaymentService"],
        input_contract: {},
        output_contract: {},
      },
    },
  };

  describe("checkProposedChanges (Import Boundary Rules)", () => {
    it("should block import from an explicitly forbidden domain", () => {
      const violations = evaluator.checkProposedChanges(
        "src/domains/billing/services/PaymentService.ts",
        ["../../orders/OrderProcessor"],
        mockConfig
      );

      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe("forbidden_dependency");
      expect(violations[0].source_domain).toBe("billing");
      expect(violations[0].target_domain).toBe("orders");
    });

    it("should block import from an unlisted domain when strict mode is active", () => {
      const violations = evaluator.checkProposedChanges(
        "src/domains/identity/services/UserService.ts",
        ["../../billing/InvoiceService"],
        mockConfig
      );

      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe("disallowed_dependency");
      expect(violations[0].source_domain).toBe("identity");
      expect(violations[0].target_domain).toBe("billing");
    });

    it("should approve import from an explicitly allowed domain", () => {
      const violations = evaluator.checkProposedChanges(
        "src/domains/billing/services/PaymentService.ts",
        ["src/domains/identity/User"],
        mockConfig
      );

      expect(violations.length).toBe(0);
    });

    it("should catch intra-domain circular dependency introduced by proposed_imports", () => {
      const cycleRepo = {
        getAllFiles: () => [
          { path: "src/domains/billing/services/PaymentService.ts" },
          { path: "src/domains/billing/controllers/PaymentController.ts" },
        ],
        getAllDependenciesWithDomains: () => [
          {
            source_file: "src/domains/billing/controllers/PaymentController.ts",
            source_domain: "billing",
            line_number: 1,
            target: "../services/PaymentService",
            statement: "import { PaymentService } from '../services/PaymentService';",
            is_external: false,
          },
        ],
      } as unknown as SeptumRepository;

      const cycleEvaluator = new BoundaryEvaluator(cycleRepo);
      const violations = cycleEvaluator.evaluate(
        "src/domains/billing/services/PaymentService.ts",
        ["../controllers/PaymentController"],
        mockConfig
      );

      expect(violations.some((v) => v.rule === "circular_dependency")).toBe(true);
    });
  });
});
