import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { TopologyDetector } from "../../src/core/discovery/topology-detector.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createLaravelFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "septum-ssot-lifecycle-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "app", "Http", "Controllers"), { recursive: true });
  fs.mkdirSync(path.join(root, "app", "Services"), { recursive: true });
  fs.mkdirSync(path.join(root, "app", "Models"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "composer.json"),
    JSON.stringify({ name: "acme/laravel-app", require: { "laravel/framework": "^12.0" } })
  );
  fs.writeFileSync(
    path.join(root, "app", "Http", "Controllers", "OrderController.php"),
    "<?php\nnamespace App\\Http\\Controllers;\nclass OrderController {}\n"
  );
  fs.writeFileSync(
    path.join(root, "app", "Services", "OrderService.php"),
    "<?php\nnamespace App\\Services;\nclass OrderService {}\n"
  );
  fs.writeFileSync(
    path.join(root, "app", "Models", "Order.php"),
    "<?php\nnamespace App\\Models;\nclass Order {}\n"
  );
  return root;
}

describe("Init & Sync SSOT Domain Lifecycle", () => {
  it("prunes stale SQLite domains during IngestionPipeline.run when active config removes a domain", async () => {
    const root = createLaravelFixture();
    const dbPath = path.join(root, ".septum", "septum.db");
    const db = new SeptumDatabase(dbPath);
    try {
      const repo = new SeptumRepository(db.raw);
      // Seed stale auto-discovered domains from an earlier run
      TopologyDetector.discoverAndPersist(repo, root);
      expect(repo.getAllDomains().map((d) => d.name).sort()).toEqual(["http", "models", "services"]);

      // Now switch to explicit septum.config.json with only 'app'
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "app", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      };
      const pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);

      const remaining = repo.getAllDomains();
      expect(remaining.map((d) => d.name)).toEqual(["app"]);
      expect(repo.countFiles()).toBe(3);
    } finally {
      db.close();
    }
  });

  it("prunes stale SQLite domains on forced re-discovery", () => {
    const root = createLaravelFixture();
    const dbPath = path.join(root, ".septum", "septum.db");
    const db = new SeptumDatabase(dbPath);
    try {
      const repo = new SeptumRepository(db.raw);
      repo.upsertDomain("app", { root: "app" }, root);
      const domains = TopologyDetector.discoverAndPersist(repo, root, true);
      expect(Object.keys(domains).sort()).toEqual(["http", "models", "services"]);
      expect(repo.getDomainByName("app")).toBeNull();
    } finally {
      db.close();
    }
  });
});
