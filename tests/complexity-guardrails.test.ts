import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SeptumDatabase } from "../src/core/database/client.ts";
import { SeptumRepository } from "../src/core/database/repository.ts";
import { ConfigLoader } from "../src/core/config/loader.ts";
import { IngestionPipeline } from "../src/core/ingestion/pipeline.ts";
import { BoundaryEvaluator } from "../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../src/core/resolver/module-resolver.ts";
import { handleCheckBoundary } from "../src/mcp/tools/boundary.ts";
import { auditStagedFiles } from "../src/core/boundary/staged-auditor.ts";

describe("Big-O Complexity & Concurrency Guardrails", () => {
  it("uses idx_symbols_name and idx_symbols_leaf_name in findSymbolsByName (no SCAN symbols)", () => {
    const db = new SeptumDatabase(":memory:");
    try {
      const repo = new SeptumRepository(db.raw);
      const domainId = repo.upsertDomain("app", {
        root: "app",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      });
      const fileId = repo.upsertFile(domainId, "app/service.ts", "service", "hash1", 10, 0, 100);
      repo.replaceFileSymbols(fileId, [
        {
          name: "App\\Services\\OrderService::createOrder",
          kind: "method",
          signature: "createOrder(): void",
          visibility: "public",
          line_start: 1,
          line_end: 5,
        },
      ]);

      const planRows = db.raw
        .query<{ detail: string }, [string, string]>(
          `EXPLAIN QUERY PLAN
           SELECT s.*, f.path AS file_path, f.content_hash AS indexed_content_hash, d.name AS domain_name
           FROM symbols s JOIN files f ON s.file_id = f.id JOIN domains d ON f.domain_id = d.id
           WHERE (s.name = ? OR s.leaf_name = ?)`
        )
        .all("createOrder", "createOrder");

      const details = planRows.map((r) => r.detail).join(" | ");
      expect(details).toContain("idx_symbols_name");
      expect(details).toContain("idx_symbols_leaf_name");
      expect(details).not.toContain("SCAN symbols");
      expect(details).not.toContain("SCAN s");

      const found = repo.findSymbolsByName("createOrder");
      expect(found).toHaveLength(1);
      expect(found[0]!.name).toBe("App\\Services\\OrderService::createOrder");
    } finally {
      db.close();
    }
  });

  it("calls getImportEvidence at most once per septum_boundary(scope='file') invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-guard-evidence-"));
    const db = new SeptumDatabase(":memory:");
    try {
      mkdirSync(join(root, "app"), { recursive: true });
      mkdirSync(join(root, "shared"), { recursive: true });
      writeFileSync(join(root, "app/main.ts"), `import { helper } from "../shared/helper";\nexport function main() { return helper(); }\n`);
      writeFileSync(join(root, "shared/helper.ts"), `export function helper() { return 1; }\n`);

      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "app", allowed_dependencies: ["shared"], forbidden_dependencies: [], archetypes: {} },
        shared: { root: "shared", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);

      const spy = spyOn(repo, "getImportEvidence");
      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
      const res = await handleCheckBoundary(
        evaluator,
        config,
        {
          file_path: "app/main.ts",
          proposed_imports: ["../shared/helper"],
          format: "json",
        },
        repo,
        root
      );
      const payload = JSON.parse(res.content[0]!.text);
      expect(payload.status).toBe("approved");
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      spy.mockRestore();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fast-paths auditStagedFiles when interpretationChanged is false and sync is current", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-staged-fast-"));
    const db = new SeptumDatabase(":memory:");
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });

      const put = (file: string, content: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
      };
      put("app/main.ts", `import { ok } from "../shared/ok";\nexport function main() { return ok(); }\n`);
      put("shared/ok.ts", `export function ok() { return 1; }\n`);
      put("domain_b/b.ts", `export function b() { return 2; }\n`);

      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "app", allowed_dependencies: ["shared"], forbidden_dependencies: ["domain_b"], archetypes: {} },
        shared: { root: "shared", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        domain_b: { root: "domain_b", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };

      const pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);

      // Stage a forbidden import in app/main.ts without touching domain_b/b.ts or shared/ok.ts
      put("app/main.ts", `import { b } from "../domain_b/b";\nexport function main() { return b(); }\n`);
      execFileSync("git", ["add", "app/main.ts"], { cwd: root });

      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
      const result = await auditStagedFiles(evaluator, config, root, repo);
      expect(result.files).toEqual(["app/main.ts"]);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]!.target_domain).toBe("domain_b");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
