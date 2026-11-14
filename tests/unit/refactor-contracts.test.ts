import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { scanSourceFiles } from "../../src/core/resources/source-inventory.ts";
import { SemanticSliceExtractorRegistry } from "../../src/core/parser/extractors/registry.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { auditStagedFiles } from "../../src/core/boundary/staged-auditor.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { SymbolToolSchema, CheckBoundarySchema, parseToolRequest } from "../../src/mcp/schemas.ts";
import { getOperationCapabilities } from "../../src/core/parser/language-capabilities.ts";
import { normalizeHookEdit } from "../../src/cli/hook-payload.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "septum-contracts-")); roots.push(root);
  const put = (file: string, value: string | Uint8Array) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), value); };
  const config = ConfigLoader.getDefaultConfig();
  config.domains = { app: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };
  return { root, put, config };
}

test("all semantic adapters honor the same custom ignore policy", async () => {
  const { root, put, config } = fixture();
  put("package.json", JSON.stringify({ dependencies: { express: "4", hono: "4", fastify: "5", elysia: "1" } }));
  put("src/live.ts", "import express from 'express'; const app=express(); app.get('/live', (req,res)=>res.send('ok'));");
  put("src/ignored/ghost.ts", "import express from 'express'; const app=express(); app.get('/ghost', (req,res)=>res.send('old'));");
  config.settings.ignore_patterns.push("src/ignored/**");
  const db = new SeptumDatabase(join(root, ".septum/index.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    await new IngestionPipeline(repo, root).run(config);
    expect(repo.getFileByPath("src/ignored/ghost.ts")).toBeNull();
    expect(repo.getAllVerticalSlices().some(slice => slice.route_uri === "/live")).toBe(true);
    expect(repo.getAllVerticalSlices().some(slice => slice.route_uri === "/ghost")).toBe(false);
    const before = repo.getAllVerticalSlices().map(slice => slice.execution_chain_json);
    repo.setMeta("slices_dirty", "1");
    expect((await new VerticalSliceTracer(repo, root, config.settings.ignore_patterns).traceAsync("GET /live")).found).toBe(true);
    expect(repo.getAllVerticalSlices().map(slice => slice.execution_chain_json)).toEqual(before);
  } finally { db.close(); }
});

test("semantic source outside domain roots remains discoverable", async () => {
  const { root, put, config } = fixture();
  put("src/model.ts", "export const model = 1;");
  put("package.json", '{"dependencies":{"express":"4"}}');
  put("routes/server.ts", "import express from 'express'; const app=express(); app.get('/outside', (req,res)=>res.send('ok'));");
  const db = new SeptumDatabase(":memory:");
  try {
    const repo = new SeptumRepository(db.raw);
    await new IngestionPipeline(repo, root).run(config);
    expect(repo.getAllVerticalSlices().some(slice => slice.route_uri === "/outside")).toBe(true);
  } finally { db.close(); }
});

test("generic routes complement uncovered files without duplicating adapter entrypoints", async () => {
  const { root, put, config } = fixture();
  put("package.json", "{}");
  put("src/legacy.routes.ts", "import {LegacyController} from './LegacyController';\napp.get('/legacy', LegacyController.run);\n");
  put("src/LegacyController.ts", "export class LegacyController { static run() { return 1; } }\n");
  const candidate = { domain_id: null, feature_key: null, http_method: "GET", route_uri: "/known", route_name: null,
    controller_class: "Known", action_name: "run", controller_file: "src/known.ts", controller_line: 1,
    architecture_style: "fixture", entry_kind: "http_route", execution_chain_json: '[{"stage":"ingress","symbol":"GET /known","file":"src/known.ts"}]' };
  const unregister = SemanticSliceExtractorRegistry.register({ id: "known-fixture", name: "Known fixture", canHandle: path => path === root, extractSlices: () => [candidate] });
  const db = new SeptumDatabase(":memory:");
  try {
    const repo = new SeptumRepository(db.raw);
    await new IngestionPipeline(repo, root).run(config);
    expect(repo.getAllVerticalSlices().filter(slice => slice.route_uri === "/known")).toHaveLength(1);
    expect(repo.getAllVerticalSlices().filter(slice => slice.route_uri === "/legacy")).toHaveLength(1);
    expect(repo.getAllVerticalSlices().some(slice => slice.route_uri === "/legacycontroller/run")).toBe(false);
    expect(JSON.parse(repo.getMeta("semantic_adapter_results") || "[]")).toContainEqual({ id: "known-fixture", slices: 1 });
  } finally { unregister(); db.close(); }
});

test("source inventory excludes escaping symlinks", () => {
  const { root, put } = fixture();
  put("src/real.ts", "export const real = 1;");
  const other = fixture(); other.put("secret.ts", "export const secret = 1;");
  symlinkSync(join(other.root, "secret.ts"), join(root, "src/escape.ts"));
  expect(scanSourceFiles(root).files).toEqual([join(root, "src/real.ts")]);
});

test("source scan permission failures are reported instead of becoming an empty inventory", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const { root, put } = fixture(); put("src/locked/source.ts", "export const source = 1;");
  chmodSync(join(root, "src/locked"), 0);
  try { expect(() => scanSourceFiles(root)).toThrow(); }
  finally { chmodSync(join(root, "src/locked"), 0o700); }
});

test("staged audit ignores unchanged large binary assets while checking source", async () => {
  const { root, put, config } = fixture();
  put("src/main.ts", "export const main = 1;");
  put("assets/archive.bin", new Uint8Array(2 * 1024 * 1024 + 1));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  put("src/main.ts", "export const main = 2;"); git("add", "src/main.ts");
  const db = new SeptumDatabase(":memory:");
  try {
    const repo = new SeptumRepository(db.raw);
    const result = await auditStagedFiles(new BoundaryEvaluator(repo, new ModuleResolver(root, repo)), config, root, repo);
    expect(result.files).toEqual(["src/main.ts"]);
    expect(result.violations).toEqual([]);
    expect(result.resolution_issues).toEqual([]);
  } finally { db.close(); }
});

test("explicit context modes select their engine and reject contradictory options", async () => {
  const { root, put, config } = fixture(); put("src/target.ts", "export function target() { return 1; }\n");
  const db = new SeptumDatabase(":memory:");
  try {
    const repo = new SeptumRepository(db.raw); await new IngestionPipeline(repo, root).run(config);
    for (const mode of ["deep", "source"] as const) {
      const args = SymbolToolSchema.parse({ query: "target", context_mode: mode });
      const response = await handleSymbolTool(repo, config, args, undefined, root);
      expect(JSON.parse(response.content[0]!.text).context_mode).toBe(mode);
    }
    expect(SymbolToolSchema.safeParse({ action: "context", context_mode: "deep", include_source: false }).success).toBe(false);
  } finally { db.close(); }
});

test("boundary canonicalization retains whether imports were supplied and their aliases", () => {
  expect(parseToolRequest("septum_boundary", { file: "src/a.ts", imports: [] }).args).toEqual(CheckBoundarySchema.parse({ file: "src/a.ts", imports: [] }));
  expect(CheckBoundarySchema.parse({ file: "src/a.ts", imports: [] }).proposed_imports_supplied).toBe(true);
  expect(CheckBoundarySchema.parse({ file: "src/a.ts" }).proposed_imports_supplied).toBe(false);
});

test("language capability separates declarations from resolver and dispatch support", () => {
  expect(getOperationCapabilities("main.rs")).toMatchObject({ declarations: "partial", import_resolution: "partial", deep_context: "unsupported", runtime_dispatch: "unverified" });
  expect(getOperationCapabilities("main.ts").deep_context).toBe("bounded_references");
  expect(getOperationCapabilities("main.tsx").deep_context).toBe("unsupported");
  expect(getOperationCapabilities("main.kt").declarations).toBe("unsupported");
});

test("hook reconstructs partial and sequential edits before import parsing", () => {
  const source = "import { x } from './local';\nexport const y = x;\n";
  expect(normalizeHookEdit({ tool_input: { file_path: "src/a.ts", old_string: "./local", new_string: "../billing/invoice" } }, () => source)).toEqual({
    target: "src/a.ts", content: source.replace("./local", "../billing/invoice"), coverage: "complete_candidate",
  });
  expect(() => normalizeHookEdit({ tool_input: { file_path: "src/a.ts", old_string: "missing", new_string: "next" } }, () => source)).toThrow("does not match");
  expect(normalizeHookEdit({ tool_input: { file_path: "src/a.ts", content: "" } }, () => source)?.content).toBe("");
  expect(normalizeHookEdit({ tool_input: { command: "echo unrelated" } }, () => source)).toBeUndefined();
});
