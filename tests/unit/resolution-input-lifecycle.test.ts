import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ImportResolver } from "../../src/core/resolver/import-resolver.ts";
import { collectSourceSkips, probeSourcePath } from "../../src/core/resources/source-files.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { SemanticSliceExtractorRegistry } from "../../src/core/parser/extractors/registry.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";

describe("TypeScript resolution interpretation inputs", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "septum-resolution-inputs-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function put(path: string, text: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }

  it("rejects a missing config becoming present inside one analysis", async () => {
    put("src/validator.ts", "export function validate() {}\n");
    await expect(collectSourceSkips(root, async () => {
      const resolver = new ImportResolver(root);
      expect(resolver.resolve("@rules/validator", "src/main.ts").status).toBe("unresolved");
      put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@rules/*": ["src/*"] } } }));
      expect(resolver.resolve("@rules/validator", "src/main.ts").status).toBe("resolved");
      return true;
    })).rejects.toThrow("Source changed during synchronization:");
  });

  it("rejects a missing relative target appearing after its lookup", async () => {
    await expect(collectSourceSkips(root, async () => {
      expect(new ImportResolver(root).resolve("./missing", "main.ts").status).toBe("unresolved");
      put("missing.ts", "export const ready = true;\n");
      return "unresolved";
    })).rejects.toThrow("Source changed during synchronization:");
  });

  it("rejects workspace membership changing after discovery", async () => {
    put("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    mkdirSync(join(root, "packages"));
    await expect(collectSourceSkips(root, async () => {
      expect(new ImportResolver(root).resolve("@pkg/validator", "main.ts").status).toBe("unresolved");
      put("packages/validator/package.json", JSON.stringify({ name: "@pkg/validator", main: "../../src/validator.ts" }));
      return "old membership";
    })).rejects.toThrow("Source changed during synchronization:");
  });

  it("retains the first lookup when a path changes and then changes back", async () => {
    await expect(collectSourceSkips(root, async () => {
      const resolver = new ImportResolver(root);
      expect(resolver.resolve("./missing", "main.ts").status).toBe("unresolved");
      put("missing.ts", "export const ready = true;\n");
      expect(resolver.resolve("./missing", "main.ts").status).toBe("resolved");
      rmSync(join(root, "missing.ts"));
      return "same final filesystem, mixed observed facts";
    })).rejects.toThrow("Source changed during synchronization:");
  });

  it("invalidates a symlink lookup if its destination changes even with identical contents", async () => {
    put("first.ts", "export const value = 1;\n");
    put("second.ts", "export const value = 1;\n");
    symlinkSync(join(root, "first.ts"), join(root, "alias.ts"));
    await expect(collectSourceSkips(root, async () => {
      expect(probeSourcePath(join(root, "alias.ts"))).toBe("file");
      rmSync(join(root, "alias.ts"));
      symlinkSync(join(root, "second.ts"), join(root, "alias.ts"));
      return "old target identity";
    })).rejects.toThrow("Source changed during synchronization:");
  });

  it("invalidates warm semantic facts for a new nested config without changing source", async () => {
    put("src/main.ts", "export function main() {}\n");
    put("src/validator.ts", "export function validate() {}\n");
    put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@rules/*": ["src/*"] } } }));
    const dbPath = join(root, ".septum/index.db");
    let db = new SeptumDatabase(dbPath);
    let repo = new SeptumRepository(db.raw);
    const config = ConfigLoader.getDefaultConfig();
    config.domains = { app: { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };
    let extractions = 0;
    const unregister = SemanticSliceExtractorRegistry.register({ id: "resolution-input-fixture", name: "resolution input fixture",
      canHandle: path => path === root,
      extractSlices: () => {
        extractions++;
        const result = new ImportResolver(root).resolve("@rules/validator", "src/main.ts");
        return [{ domain_id: null, feature_key: null, http_method: "GET", route_uri: "/resolution", route_name: null,
          controller_class: "Fixture", action_name: result.status, controller_file: "src/main.ts", controller_line: 1,
          architecture_style: "fixture", entry_kind: "http_route", execution_chain_json: "[]" }];
      },
    });
    try {
      let pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config);
      expect(repo.getAllVerticalSlices()[0]!.action_name).toBe("resolved");
      await pipeline.run(config);
      expect(extractions).toBe(1);
      expect(JSON.parse(repo.getMeta("semantic_observations")!).paths).toContainEqual({ path: "src/tsconfig.json", kind: "missing" });
      db.close();
      db = new SeptumDatabase(dbPath);
      repo = new SeptumRepository(db.raw);
      pipeline = new IngestionPipeline(repo, root);
      await pipeline.run(config, { verifyContent: true });
      expect(extractions).toBe(1);
      put("src/tsconfig.json", "{}\n");
      const changed = await pipeline.run(config, { verifyContent: true });
      expect(changed.parser_invocations).toBe(0);
      expect(repo.getAllVerticalSlices()[0]!.action_name).toBe("unresolved");
      expect(extractions).toBe(2);
      rmSync(join(root, "src/tsconfig.json"));
      // The on-demand path must validate the same persisted interpretation inputs.
      await new VerticalSliceTracer(repo, root, [], false).traceAsync("GET /resolution");
      expect(repo.getAllVerticalSlices()[0]!.action_name).toBe("resolved");
      expect(extractions).toBe(3);
      repo.setMeta("semantic_extractor_revision", "3-inputs-2");
      repo.setMeta("semantic_input_revision", "2");
      const refreshed = await pipeline.run(config);
      expect(refreshed.parser_invocations).toBe(0);
      expect(extractions).toBe(4);
    } finally { unregister(); db.close(); }
  });
});
