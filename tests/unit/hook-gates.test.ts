import { describe, expect, it } from "bun:test";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";

describe("Septum Active Pre-write Hook AST Boundary Verification", () => {
  const db = new SeptumDatabase(":memory:");
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);
  const astEngine = new ASTParserEngine();

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
  };

  it("should block forbidden cross-domain imports in proposed code", async () => {
    const proposedCode = `
import { OrderProcessor } from "../../orders/processor";
export class PaymentService {
  public pay() {}
}
`;
    const parsed = await astEngine.parseFile(
      "src/domains/billing/services/PaymentService.ts",
      proposedCode
    );
    const proposedImports = parsed.dependencies.map((d) => d.target);

    const violations = evaluator.checkProposedChanges(
      "src/domains/billing/services/PaymentService.ts",
      proposedImports,
      mockConfig
    );

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("forbidden_dependency");
    expect(violations[0].source_domain).toBe("billing");
    expect(violations[0].target_domain).toBe("orders");
  });

  it("should permit approved cross-domain imports", async () => {
    const proposedCode = `
import { User } from "../../identity/user";
export class PaymentService {
  public pay() {}
}
`;
    const parsed = await astEngine.parseFile(
      "src/domains/billing/services/PaymentService.ts",
      proposedCode
    );
    const proposedImports = parsed.dependencies.map((d) => d.target);

    const violations = evaluator.checkProposedChanges(
      "src/domains/billing/services/PaymentService.ts",
      proposedImports,
      mockConfig
    );

    expect(violations.length).toBe(0);
  });

  it("should resolve source domain correctly", () => {
    const domain = evaluator.resolveSourceDomain(
      "src/domains/billing/services/PaymentService.ts",
      mockConfig
    );
    expect(domain).toBe("billing");
  });

  it("should ignore type-only imports during circular dependency detection", () => {
    const deps = [
      {
        source_file: "src/domains/billing/types.ts",
        source_domain: "billing",
        line_number: 1,
        target: "./services/PaymentService",
        statement: "import type { PaymentService } from './services/PaymentService';",
        is_external: false,
      },
      {
        source_file: "src/domains/billing/services/PaymentService.ts",
        source_domain: "billing",
        line_number: 1,
        target: "../types",
        statement: "import { PaymentConfig } from '../types';",
        is_external: false,
      },
    ];

    const violations = evaluator.detectCircularDependencies(mockConfig, deps);
    expect(violations.filter(v => v.rule === "circular_dependency")).toHaveLength(0);
  });

  it("should ignore virtual top-level root domain during domain-to-domain cycle detection", () => {
    const configWithRoot: ValidatedSeptumConfig = {
      ...mockConfig,
      domains: {
        ...mockConfig.domains,
        root: {
          root: "src",
          description: "Root top-level",
          allowed_dependencies: ["billing", "orders"],
          forbidden_dependencies: [],
          archetypes: {},
        },
      },
    };

    const deps = [
      {
        source_file: "src/index.ts",
        source_domain: "root",
        line_number: 1,
        target: "./domains/billing/service",
        statement: "import { BillingService } from './domains/billing/service';",
        is_external: false,
      },
      {
        source_file: "src/domains/billing/service.ts",
        source_domain: "billing",
        line_number: 1,
        target: "../../version",
        statement: "import { VERSION } from '../../version';",
        is_external: false,
      },
    ];

    const violations = evaluator.detectCircularDependencies(configWithRoot, deps);
    const domainCycles = violations.filter(v => v.rule === "circular_dependency" && v.message.includes("Circular domain"));
    expect(domainCycles).toHaveLength(0);
  });
});
