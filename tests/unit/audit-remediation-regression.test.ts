import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateBoundary } from "../../src/core/boundary/audit.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { registerDomainPolicy } from "../../src/core/config/domain-registration.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { buildNavigation } from "../../src/core/discovery/navigation.ts";
import { TopologyDetector } from "../../src/core/discovery/topology-detector.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { ExpressSemanticExtractor } from "../../src/core/parser/extractors/express-semantic.ts";
import { LaravelSemanticExtractor } from "../../src/core/parser/extractors/laravel-semantic.ts";
import { NextJsSemanticExtractor } from "../../src/core/parser/extractors/nextjs-semantic.ts";
import { TypeScriptExtractor } from "../../src/core/parser/extractors/typescript.ts";
import { ImportResolver } from "../../src/core/resolver/import-resolver.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { shouldIgnoreSourcePath } from "../../src/core/resources/ignore.ts";
import { retrieveContext } from "../../src/core/retrieval/context.ts";
import { formatBoundaryAsText } from "../../src/mcp/formatters/compact-text.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

describe("Audit Remediation Regression Suite (Bagisto, Dub.link, Directus)", () => {
  const tempDirs: string[] = [];

  function trackTemp(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("Phase 1: Resilience, Parser Fault Isolation & Transactional Domain Validation", () => {
    it("rejects file path as domain root BEFORE mutating SQLite or septum.config.json", async () => {
      const root = trackTemp("septum-p1-reg-");
      writeFile(root, "api/src/app.ts", "export function createApp() {}\n");
      writeFile(root, "api/src/services/server.ts", "export class ServerService {}\n");
      writeFile(root, "septum.config.json", JSON.stringify({ domains: { services: { root: "api/src/services" } } }));

      const db = new SeptumDatabase(path.join(root, ".septum", "septum.db"));
      try {
        const repo = new SeptumRepository(db.raw);
        const cfg: ValidatedSeptumConfig = {
          domains: { services: { root: "api/src/services", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
          settings: { db_path: ".septum/septum.db", ignore_patterns: [], enforcement: "strict" },
        };

        await expect(
          registerDomainPolicy(repo, cfg, { domain: "api-entry", root: "api/src/app.ts", ingest_now: true }, root)
        ).rejects.toThrow("is not a directory");

        // Ensure SQLite and septum.config.json were NOT poisoned
        expect(repo.getDomainByName("api-entry")).toBeNull();
        const diskCfg = JSON.parse(fs.readFileSync(path.join(root, "septum.config.json"), "utf8"));
        expect(diskCfg.domains["api-entry"]).toBeUndefined();

        // Subsequent pipeline run on valid domains succeeds cleanly
        const pipeline = new IngestionPipeline(repo, root);
        const metrics = await pipeline.run(cfg);
        expect(metrics.files_scanned).toBe(1);
      } finally {
        db.close();
      }
    });

    it("parses valid TSX with nested template literals and typeof import() via TypeScript compiler fallback", async () => {
      const extractor = new TypeScriptExtractor();

      const dubTsx = `
import Link from "next/link";
export default function CustomerLayout({ customerId }: { customerId: string }) {
  const url = \`\${\`/customers/\${customerId}\`}?tab=all\`;
  return <Link href={url}>Back</Link>;
}
`;
      const resDub = await extractor.extract("apps/web/app/layout.tsx", dubTsx);
      expect(resDub.status).toBe("parsed");
      expect(resDub.symbols.some((s) => s.name === "CustomerLayout")).toBe(true);
      expect(resDub.dependencies.some((d) => d.target === "next/link")).toBe(true);

      const directusTestTs = `
import { vi } from "vitest";
vi.mock("@directus/utils/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@directus/utils/node")>()),
  createTmpFile: vi.fn(),
}));
export function helper() { return 1; }
`;
      const resDirectus = await extractor.extract("api/src/services/export.test.ts", directusTestTs);
      expect(resDirectus.status).toBe("parsed");
      expect(resDirectus.symbols.some((s) => s.name === "helper")).toBe(true);
    });

    it("isolates genuinely broken syntax files during sync without aborting other valid files", async () => {
      const root = trackTemp("septum-p1-iso-");
      writeFile(root, "src/valid.ts", "export function ok() { return 42; }\n");
      writeFile(root, "src/broken.ts", "export function bad( {\n  const x = ;\n");

      const db = new SeptumDatabase(path.join(root, ".septum", "septum.db"));
      try {
        const repo = new SeptumRepository(db.raw);
        const cfg: ValidatedSeptumConfig = {
          domains: { core: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
          settings: { db_path: ".septum/septum.db", ignore_patterns: [], enforcement: "strict" },
        };
        const pipeline = new IngestionPipeline(repo, root);
        const metrics = await pipeline.run(cfg);
        expect(metrics.files_scanned).toBe(2);
        expect(repo.getFileByPath("src/valid.ts")).not.toBeNull();
        expect(repo.getFileByPath("src/broken.ts")).toBeNull();
        expect(JSON.parse(repo.getMeta("unsupported_files") || "[]")).toContain("src/broken.ts");

        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const res = await evaluateBoundary(evaluator, cfg, { scope: "all" }, repo, root);
        expect(res.payload.status).toBe("unknown");
      } finally {
        db.close();
      }
    });
  });

  describe("Phase 2: Monorepo packages/ Discovery, Coverage Accounting & Boundary Honesty", () => {
    it("does not ignore packages/ and discovers top-level monorepo apps alongside packages/*", async () => {
      expect(shouldIgnoreSourcePath("packages/Webkul/Shop/src/Cart.php")).toBe(false);
      expect(shouldIgnoreSourcePath("packages/ui/src/button.tsx")).toBe(false);

      const root = trackTemp("septum-p2-mono-");
      writeFile(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n  - api\n  - app\n");
      writeFile(root, "packages/types/src/index.ts", "export type ID = string;\n");
      writeFile(root, "api/src/server.ts", "export class ServerService {}\n");
      writeFile(root, "app/src/main.ts", "export const app = 1;\n");

      const topology = TopologyDetector.detect(root);
      expect(topology.domains.types).toBeDefined();
      expect(topology.domains.api).toBeDefined();
      expect(topology.domains.app).toBeDefined();
    });

    it("never returns approved on empty workspace or uncovered files, and preserves scope='all' in heading", async () => {
      const root = trackTemp("septum-p2-honest-");
      writeFile(root, "packages/ai/src/index.ts", "export const ai = 1;\n");
      writeFile(root, "api/src/app.ts", "export const api = 1;\n");

      const db = new SeptumDatabase(path.join(root, ".septum", "septum.db"));
      try {
        const repo = new SeptumRepository(db.raw);
        const cfg: ValidatedSeptumConfig = {
          domains: { ai: { root: "packages/ai", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
          settings: { db_path: ".septum/septum.db", ignore_patterns: [], enforcement: "strict" },
        };
        const pipeline = new IngestionPipeline(repo, root);
        await pipeline.run(cfg);

        // api/src/app.ts is uncovered -> navigation coverage must be partial, boundary(all) must be unknown
        const nav = buildNavigation(repo, {}, root);
        expect(nav.health.coverage).toBe("partial");
        expect(nav.health.reasons).toContain("uncovered_workspace_files");

        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const res = await evaluateBoundary(evaluator, cfg, { scope: "all" }, repo, root);
        expect(res.payload.status).toBe("approved");
        expect((res.payload as any).uncovered_files_count).toBe(1);
        expect((res.payload as any).scope).toBe("all");

        // Empty workspace (0 files indexed) -> must be unknown with scope='all'
        repo.deleteFileByPath("packages/ai/src/index.ts");
        const navEmpty = buildNavigation(repo, {}, root);
        expect(navEmpty.health.coverage).toBe("partial");
        expect(navEmpty.health.reasons).toContain("empty_domains");

        const resEmpty = await evaluateBoundary(evaluator, cfg, { scope: "all" }, repo, root);
        expect(resEmpty.payload.status).toBe("unknown");
        expect((resEmpty.payload as any).scope).toBe("all");
        expect(formatBoundaryAsText(resEmpty.payload)).toContain("# Septum Boundary: all [unknown]");
      } finally {
        db.close();
      }
    });
  });

  describe("Phase 3: Impact Accuracy, Barrel Re-Exports, TSConfig Tolerance, Deep Context & Payload Cap", () => {
    it("resolves method impact for TS class methods without self-declaration false call site", async () => {
      const root = trackTemp("septum-p3-ts-impact-");
      writeFile(
        root,
        "api/src/services/server.ts",
        `export class ServerService {
  async isSetupCompleted(): Promise<boolean> {
    return true;
  }
  async serverInfo(): Promise<{ ok: boolean }> {
    const done = await this.isSetupCompleted();
    return { ok: done };
  }
}
`
      );
      writeFile(
        root,
        "api/src/controllers/server.ts",
        `import { ServerService } from "../services/server.js";
export async function handleInfo() {
  const svc = new ServerService();
  return await svc.serverInfo();
}
`
      );
      const db = new SeptumDatabase(path.join(root, ".septum", "septum.db"));
      try {
        const repo = new SeptumRepository(db.raw);
        const cfg: ValidatedSeptumConfig = {
          domains: { api: { root: "api/src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
          settings: { db_path: ".septum/septum.db", ignore_patterns: [], enforcement: "strict" },
        };
        await new IngestionPipeline(repo, root).run(cfg);

        const impactRes = await handleSymbolTool(
          repo,
          cfg,
          { action: "impact", query: "serverInfo", file_path: "api/src/services/server.ts", format: "json" },
          undefined,
          root
        );
        const payload = JSON.parse(impactRes.content[0]!.text);
        expect(payload.found_in_index).toBe(true);
        expect(payload.call_sites.some((c: any) => c.file === "api/src/controllers/server.ts" && c.line === 4)).toBe(true);
        expect(payload.call_sites.some((c: any) => c.file === "api/src/services/server.ts" && c.line === 5)).toBe(false);

        // Deep context on ServerService::serverInfo should include this.isSetupCompleted()
        const ctxRes = await retrieveContext(
          repo,
          cfg,
          { query: "serverInfo", file_path: "api/src/services/server.ts", budget_bytes: 16384 },
          root
        );
        const ctxJson = JSON.parse(ctxRes.content[0]!.text);
        expect(ctxJson.items.some((i: any) => i.kind === "source" && i.name === "ServerService::isSetupCompleted")).toBe(true);
      } finally {
        db.close();
      }
    });

    it("resolves barrel re-export call sites and tolerates missing tsconfig extends", async () => {
      const root = trackTemp("septum-p3-dub-");
      writeFile(
        root,
        "apps/web/tsconfig.json",
        JSON.stringify({
          extends: "@dub/tsconfig/nextjs.json",
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } },
        })
      );
      writeFile(root, "apps/web/package.json", JSON.stringify({ name: "web", dependencies: { next: "15.0.0" } }));
      writeFile(
        root,
        "apps/web/lib/api/links/get-links-for-workspace.ts",
        "export async function getLinksForWorkspace(id: string) { return [id]; }\n"
      );
      writeFile(root, "apps/web/lib/api/links/index.ts", 'export * from "./get-links-for-workspace";\n');
      writeFile(
        root,
        "apps/web/app/api/links/route.ts",
        'import { getLinksForWorkspace } from "@/lib/api/links";\nexport async function GET() { return getLinksForWorkspace("ws_1"); }\n'
      );

      // ImportResolver must resolve @/lib/api/links despite missing @dub/tsconfig/nextjs.json
      const resolved = new ImportResolver(root).resolve("@/lib/api/links", "apps/web/app/api/links/route.ts");
      expect(resolved.status).toBe("resolved");
      expect(resolved.targets[0]?.files).toContain("apps/web/lib/api/links/index.ts");

      const db = new SeptumDatabase(path.join(root, ".septum", "septum.db"));
      try {
        const repo = new SeptumRepository(db.raw);
        const cfg: ValidatedSeptumConfig = {
          domains: {
            routes: { root: "apps/web/app/api/links", allowed_dependencies: ["links"], forbidden_dependencies: [], archetypes: {} },
            links: { root: "apps/web/lib/api/links", allowed_dependencies: [], forbidden_dependencies: ["routes"], archetypes: {} },
          },
          settings: { db_path: ".septum/septum.db", ignore_patterns: [], enforcement: "strict" },
        };
        await new IngestionPipeline(repo, root).run(cfg);

        const impactRes = await handleSymbolTool(
          repo,
          cfg,
          { action: "impact", query: "getLinksForWorkspace", format: "json" },
          undefined,
          root
        );
        const payload = JSON.parse(impactRes.content[0]!.text);
        expect(payload.call_sites.some((c: any) => c.file === "apps/web/app/api/links/route.ts" && c.line === 2)).toBe(true);
      } finally {
        db.close();
      }
    });

    it("resolves PHP short name impact and omits bloated metadata in text format", async () => {
      const root = trackTemp("septum-p3-php-");
      writeFile(root, "composer.json", JSON.stringify({ autoload: { "psr-4": { "Webkul\\Shop\\": "packages/Webkul/Shop/src" } } }));
      writeFile(
        root,
        "packages/Webkul/Shop/src/Http/Controllers/API/CartController.php",
        `<?php
namespace Webkul\\Shop\\Http\\Controllers\\API;
class CartController {
    public function index() {
        return [];
    }
}
`
      );
      writeFile(
        root,
        "packages/Webkul/Shop/src/Routes/api.php",
        `<?php
use Webkul\\Shop\\Http\\Controllers\\API\\CartController;
Route::get('checkout/cart', [CartController::class, 'index']);
`
      );
      const db = new SeptumDatabase(path.join(root, ".septum", "septum.db"));
      try {
        const repo = new SeptumRepository(db.raw);
        const cfg: ValidatedSeptumConfig = {
          domains: { shop: { root: "packages/Webkul/Shop/src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } },
          settings: { db_path: ".septum/septum.db", ignore_patterns: [], enforcement: "strict" },
        };
        await new IngestionPipeline(repo, root).run(cfg);

        const textRes = await handleSymbolTool(
          repo,
          cfg,
          {
            action: "impact",
            query: "CartController::index",
            file_path: "packages/Webkul/Shop/src/Http/Controllers/API/CartController.php",
            format: "text",
          },
          undefined,
          root
        );
        expect(textRes.content[0]!.text).not.toContain("was not found in Septum index");
        expect(textRes.content[0]!.text).toContain("packages/Webkul/Shop/src/Routes/api.php:2");
        expect(Buffer.byteLength(JSON.stringify(textRes.metadata))).toBeLessThan(4096);
      } finally {
        db.close();
      }
    });
  });

  describe("Phase 4: Semantic Route Extractors (Laravel Modular, Express Factory, Next.js App Router)", () => {
    it("extracts modular Laravel routes including require inside Route::group", async () => {
      const root = trackTemp("septum-p4-laravel-");
      writeFile(root, "artisan", "#!/usr/bin/env php\n");
      writeFile(root, "composer.json", JSON.stringify({ autoload: { "psr-4": { "Webkul\\Shop\\": "packages/Webkul/Shop/src" } } }));
      writeFile(
        root,
        "packages/Webkul/Shop/src/Http/Controllers/API/CartController.php",
        `<?php
namespace Webkul\\Shop\\Http\\Controllers\\API;
class CartController {
    public function index() { return []; }
}
`
      );
      writeFile(
        root,
        "packages/Webkul/Shop/src/Routes/checkout-routes.php",
        `<?php
use Illuminate\\Support\\Facades\\Route;
use Webkul\\Shop\\Http\\Controllers\\API\\CartController;
Route::controller(CartController::class)->prefix('checkout/cart')->group(function () {
    Route::get('', 'index')->name('shop.api.checkout.cart.index');
});
`
      );
      writeFile(
        root,
        "packages/Webkul/Shop/src/Routes/api.php",
        `<?php
use Illuminate\\Support\\Facades\\Route;
Route::group(['prefix' => 'api'], function () {
    require 'checkout-routes.php';
});
`
      );

      const slices = await new LaravelSemanticExtractor().extractSlices(root);
      const cartSlice = slices.find((s) => s.http_method === "GET" && s.route_uri === "/api/checkout/cart");
      expect(cartSlice).toBeDefined();
      expect(cartSlice?.action_name).toBe("index");
      expect(cartSlice?.controller_file).toBe("packages/Webkul/Shop/src/Http/Controllers/API/CartController.php");
    });

    it("extracts Express routes inside createApp() factory with asyncHandler and trailing respond", async () => {
      const root = trackTemp("septum-p4-express-");
      writeFile(root, "api/package.json", JSON.stringify({ name: "@directus/api", dependencies: { express: "^4.18.0" } }));
      writeFile(
        root,
        "api/src/controllers/server.ts",
        `import { Router } from "express";
const router = Router();
const asyncHandler = (fn: any) => fn;
const respond = (_req: any, _res: any) => {};
router.get("/info", asyncHandler(async (_req: any, res: any) => { res.json({ ok: true }); }), respond);
export default router;
`
      );
      writeFile(
        root,
        "api/src/app.ts",
        `import express from "express";
import serverRouter from "./controllers/server";
export default async function createApp() {
  const app = express();
  app.use("/server", serverRouter);
  return app;
}
`
      );

      const extractor = new ExpressSemanticExtractor();
      expect(extractor.canHandle(root)).toBe(true);
      const slices = await extractor.extractSlices(root);
      const infoSlice = slices.find((s) => s.http_method === "GET" && s.route_uri === "/server/info");
      expect(infoSlice).toBeDefined();
      expect(infoSlice?.controller_file).toBe("api/src/controllers/server.ts");
    });

    it("extracts Next.js App Router route handlers wrapped with HOFs like withWorkspace", async () => {
      const root = trackTemp("septum-p4-nextjs-");
      writeFile(root, "apps/web/package.json", JSON.stringify({ name: "web", dependencies: { next: "15.0.0" } }));
      writeFile(
        root,
        "apps/web/app/api/links/route.ts",
        `const withWorkspace = (fn: any) => fn;
export const GET = withWorkspace(async () => {
  return Response.json({ links: [] });
});
export async function POST() {
  return Response.json({ created: true });
}
`
      );
      writeFile(
        root,
        "apps/web/app/app.dub.co/(dashboard)/[slug]/api/stats/route.ts",
        `export async function GET() { return Response.json({}); }\n`
      );

      const extractor = new NextJsSemanticExtractor();
      expect(extractor.canHandle(root)).toBe(true);
      const slices = await extractor.extractSlices(root);
      expect(slices.some((s) => s.http_method === "GET" && s.route_uri === "/api/links")).toBe(true);
      expect(slices.some((s) => s.http_method === "POST" && s.route_uri === "/api/links")).toBe(true);
      expect(slices.some((s) => s.http_method === "GET" && s.route_uri === "/app.dub.co/:slug/api/stats")).toBe(true);
    });
  });
});
