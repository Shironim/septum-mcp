import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { auditStagedFiles } from "../../src/core/boundary/staged-auditor.ts";
import { BehavioralAnalyzer } from "../../src/core/parser/behavioral-analyzer.ts";
import { LaravelMigrationSchemaProvider } from "../../src/core/parser/schema/providers/laravel-migration-provider.ts";
import { handleGetFeatureContext } from "../../src/mcp/tools/get-feature-context.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { resolveEffectiveFeature } from "../../src/core/session/effective-feature.ts";
import { SEPTUM_PRE_WRITE_SCRIPT, SEPTUM_POST_WRITE_SCRIPT } from "../../src/cli/templates/hooks.ts";
import { installGitHook } from "../../src/cli/commands/init.ts";
import { SEMANTIC_EXTRACTOR_REVISION } from "../../src/core/parser/semantic-revision.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";

const roots: string[] = [];
const databases: SeptumDatabase[] = [];
const cli = resolve(import.meta.dir, "../../bin/septum.ts");
function fixture() {
  const root = mkdtempSync("/tmp/septum-foundation-test-"); roots.push(root);
  const put = (file: string, content: string) => { mkdirSync(resolve(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), content); };
  put("package.json", "{}");
  put("src/orders/Order.ts", "import { invoice } from '@invoice'; export const total = invoice();");
  put("src/orders/Local.ts", "export function invoice() { return 2; }");
  put("src/billing/Invoice.ts", "export function invoice() { return 1; }");
  put("configs/base.json", JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@invoice": ["src/billing/Invoice.ts"] } } }));
  put("tsconfig.json", JSON.stringify({ extends: "./configs/base.json" }));
  const db = new SeptumDatabase(join(root, ".septum/septum.db")); databases.push(db);
  const repo = new SeptumRepository(db.raw);
  const config = ConfigLoader.getDefaultConfig();
  config.settings.enforcement = "strict";
  config.domains = { orders: { root: "src/orders", forbidden_dependencies: ["billing"] }, billing: { root: "src/billing" } };
  const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", ...args], { cwd: root }); expect(result.exitCode).toBe(0); return result; };
  return { root, put, db, repo, config, evaluator, git };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

test("staged aliases, inherited config and target membership ignore unstaged edits", async () => {
  const f = fixture();
  await new IngestionPipeline(f.repo, f.root).run(f.config);
  f.git("init", "-q"); f.git("add", "package.json", "src", "configs", "tsconfig.json");
  const audit = () => auditStagedFiles(f.evaluator, f.config, f.root, undefined, f.repo);
  const before = await audit();
  expect(before.violations.some(v => v.rule === "forbidden_dependency")).toBe(true);
  f.put("configs/base.json", JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@invoice": ["src/orders/Local.ts"] } } }));
  unlinkSync(join(f.root, "src/billing/Invoice.ts"));
  expect(await audit()).toEqual(before);
  f.git("add", "configs", "src/billing/Invoice.ts");
  expect((await audit()).violations).toHaveLength(0);
});

test("feature reuse exposes ambiguity and file-qualified identity, then detects deletion", async () => {
  const f = fixture(); await new IngestionPipeline(f.repo, f.root).run(f.config);
  f.config.features = { pay: { domain: "orders", allowed_touchpoints: [], reuse_symbols: ["invoice", "src/billing/Invoice.ts#invoice"] } };
  const get = () => JSON.parse(handleGetFeatureContext(f.repo, f.config, { feature_key: "pay" }, f.root).content[0].text).reuse_symbols;
  expect(get()[0].status).toBe("ambiguous"); expect(get()[0].candidates).toHaveLength(2);
  expect(get()[1].status).toBe("resolved"); expect(get()[1].symbol_ref.file_path).toBe("src/billing/Invoice.ts");
  unlinkSync(join(f.root, "src/billing/Invoice.ts")); expect(get()[1].status).toBe("stale");
});

test("proposal approval declares omitted and explicit empty imports without certifying existing imports", async () => {
  const f = fixture(); await new IngestionPipeline(f.repo, f.root).run(f.config);
  for (const supplied of [false, true]) {
    const args = { file_path: "src/orders/Order.ts", ...(supplied ? { proposed_imports: [] } : {}) };
    const result = JSON.parse((await handleCheckBoundary(f.evaluator, f.config, args as any, f.repo, f.root)).content[0].text);
    expect(result.status).toBe("approved"); expect(result.evaluated_scope.existing_imports_checked).toBe(false);
    expect(result.evaluated_scope.proposed_imports_supplied).toBe(supplied);
  }
});

test("behavioral heuristic excludes strings, escapes, comments, heredoc and nowdoc", () => {
  for (const code of [
    `"DB::transaction(); event(new GhostEvent()); GhostJob::dispatch();";`,
    `"escaped \\" event(new GhostEvent())";`,
    `/* event(new GhostEvent());\nDB::transaction(); GhostJob::dispatch(); */`,
    `// event(new GhostEvent());\n# GhostJob::dispatch();`,
    `$x = <<<TXT\nDB::transaction(); event(new GhostEvent()); GhostJob::dispatch();\nTXT;`,
    `$x = <<<'TXT'\nevent(new GhostEvent()); $order->delete();\nTXT;`,
    `DB::transactional(); fakeevent(new GhostEvent()); fakeabort_if(); $order->status == true;`,
    `"$this->authorize('delete'); $order->status = 'x';";`,
  ]) {
    const result = BehavioralAnalyzer.analyzeMethod(code);
    expect(result.hasTransaction).toBe(false); expect(result.emittedEvents).toEqual([]);
    expect(result.dispatchedJobs).toEqual([]); expect(result.mutations).toEqual([]); expect(result.guards).toEqual([]);
  }
  const positive = BehavioralAnalyzer.analyzeMethod(`DB::transaction(); event(new RealEvent()); RealJob::dispatch(); $order->status = 'x'; $this->authorize('update');`);
  expect(positive.hasTransaction).toBe(true); expect(positive.emittedEvents).toContain("RealEvent");
  expect(positive.dispatchedJobs).toContain("RealJob"); expect(positive.mutations).toContain("order.status"); expect(positive.guards).toContain("update");
  expect(positive.analysis).toBe("lexical_heuristic");
});

test("migration summary scopes tables and up, applies column removals and renames", () => {
  const f = fixture();
  f.put("database/migrations/001.php", `<?php class M { function up() {
    Schema::create('orders', function ($table) { $table->id(); $table->string('status'); });
    Schema::create('invoices', function ($table) { $table->string('billing_secret'); });
    /* Schema::table('orders', function ($table) { $table->string('ghost'); }); */
    $decoy = "Schema::table('orders', function ($table) { $table->string('fake'); });";
  } function down() { Schema::dropIfExists('orders'); } }`);
  f.put("database/migrations/002.php", `<?php class N { function up() { Schema::table('orders', function ($table) { $table->renameColumn('status', 'state'); $table->dropColumn('id'); }); } }`);
  const schema = new LaravelMigrationSchemaProvider().resolveEntitySchema(f.root, "Order");
  expect(schema?.fields.map(field => field.name)).toEqual(["state"]);
});

test("generated pre-write wrapper and CLI enforce the same active lease from a subfolder", async () => {
  const f = fixture(); await new IngestionPipeline(f.repo, f.root).run(f.config);
  f.put(".septum/session.json", JSON.stringify({ feature_key: "pay", domain: "orders", touchpoints: ["src/orders/Order.ts"], owner_id: "another-owner" }));
  f.put(".septum/catalog_access.json", JSON.stringify({ domains: { orders: "consulted" } }));
  f.put(".agents/hooks/pre.sh", SEPTUM_PRE_WRITE_SCRIPT);
  f.put("bin/septum.ts", `import ${JSON.stringify(cli)};`);
  for (const [cwd, target] of [[f.root, "src/orders/Local.ts"], [join(f.root, "src/orders"), "Local.ts"], [join(f.root, "src/orders"), join(f.root, "src/orders/Local.ts")]]) {
    const result = Bun.spawnSync(["sh", join(f.root, ".agents/hooks/pre.sh")], { cwd, stdin: Buffer.from(JSON.stringify({ tool_input: { file_path: target } })) });
    expect(result.exitCode).toBe(1); expect(JSON.parse(result.stdout.toString()).decision).toBe("deny");
  }
  f.git("init", "-q"); f.git("add", "src", "configs", "tsconfig.json", "package.json");
  f.repo.setMeta("settings_json", JSON.stringify(f.config.settings));
  const cliResult = Bun.spawnSync(["bun", cli, "check", "--staged", "--strict", "--json"], { cwd: f.root });
  expect(cliResult.exitCode).toBe(1); expect(JSON.parse(cliResult.stdout.toString()).violations.some((v: any) => v.rule === "touchpoint_violation")).toBe(true);
  installGitHook(f.root);
  const commitGuard = Bun.spawnSync(["sh", join(f.root, ".git/hooks/pre-commit")], { cwd: f.root });
  expect(commitGuard.exitCode).toBe(1); expect(commitGuard.stderr.toString()).toContain("TOUCHPOINT_VIOLATION");
  expect(() => resolveEffectiveFeature(f.root, f.config, "other")).toThrow(/Active feature lock/);
  f.put(".septum/session.json", "{broken"); expect(() => resolveEffectiveFeature(f.root, f.config)).toThrow(/Corrupted/);
  unlinkSync(join(f.root, ".septum/session.json")); expect(resolveEffectiveFeature(f.root, f.config)).toBeUndefined();
});

test("a staged config-only alias change checks unchanged sources and deletion-only changes honor the lease", async () => {
  const f = fixture();
  f.put("configs/base.json", JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@invoice": ["src/orders/Local.ts"] } } }));
  await new IngestionPipeline(f.repo, f.root).run(f.config);
  f.git("init", "-q"); f.git("add", "src", "configs", "tsconfig.json", "package.json");
  f.git("-c", "user.name=Foundation Test", "-c", "user.email=foundation@example.invalid", "commit", "-qm", "fixture baseline");
  f.put("configs/base.json", JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@invoice": ["src/billing/Invoice.ts"] } } }));
  f.git("add", "configs/base.json");
  const changed = await auditStagedFiles(f.evaluator, f.config, f.root, undefined, f.repo);
  expect(changed.files).toEqual(["configs/base.json"]);
  expect(changed.violations.some(v => v.file === "src/orders/Order.ts" && v.rule === "forbidden_dependency")).toBe(true);
  f.git("restore", "--staged", "configs/base.json");
  f.git("rm", "src/orders/Local.ts");
  f.put(".septum/session.json", JSON.stringify({ feature_key: "pay", domain: "orders", touchpoints: ["src/orders/Order.ts"], owner_id: "other" }));
  const key = resolveEffectiveFeature(f.root, f.config);
  const deleted = await auditStagedFiles(f.evaluator, f.config, f.root, key, f.repo);
  expect(deleted.violations.some(v => v.file === "src/orders/Local.ts" && v.rule === "touchpoint_violation")).toBe(true);
});

test("generated post-write wrapper syncs its workspace when invoked from a subfolder", async () => {
  const f = fixture(); await new IngestionPipeline(f.repo, f.root).run(f.config);
  f.put("bin/septum.ts", `import ${JSON.stringify(cli)};`);
  f.put(".agents/hooks/post.sh", SEPTUM_POST_WRITE_SCRIPT);
  f.put("src/orders/Local.ts", "export function refreshedByPostWrite() { return 3; }");
  const result = Bun.spawnSync(["sh", join(f.root, ".agents/hooks/post.sh")], { cwd: join(f.root, "src/orders") });
  expect(result.exitCode).toBe(0);
  const deadline = Date.now() + 5000;
  while (!f.repo.findSymbolsByName("refreshedByPostWrite").length && Date.now() < deadline) await Bun.sleep(30);
  expect(f.repo.findSymbolsByName("refreshedByPostWrite")).toHaveLength(1);
});

test("dynamic schema operations and table rename do not certify an older field set", () => {
  const f = fixture();
  f.put("database/migrations/001.php", `<?php Schema::create('orders', function ($table) { $table->id(); });`);
  const provider = new LaravelMigrationSchemaProvider();
  expect(provider.resolveEntitySchema(f.root, "Order")?.fields).toHaveLength(1);
  for (const operation of [`Schema::table($dynamic, function ($table) { $table->string('ghost'); });`, `Schema::rename('orders', 'archived_orders');`, `Schema::drop('orders');`]) {
    f.put("database/migrations/002.php", `<?php ${operation}`);
    expect(provider.resolveEntitySchema(f.root, "Order")).toBeNull();
  }
});

test("sync and on-demand tracing invalidate slices from the previous semantic implementation", async () => {
  const f = fixture(); const pipeline = new IngestionPipeline(f.repo, f.root);
  await pipeline.run(f.config);
  const seed = () => {
    f.repo.upsertVerticalSlice({ domain_id: null, feature_key: null, http_method: "GET", route_uri: "/phantom", route_name: null, controller_class: "GhostController", action_name: "index", controller_file: null, controller_line: null, architecture_style: "mvc", execution_chain_json: "[]" });
    f.repo.setMeta("semantic_extractor_revision", "3-inputs-4");
  };
  seed(); await pipeline.run(f.config, { verifyContent: true });
  expect(f.repo.getAllVerticalSlices().some(slice => slice.route_uri === "/phantom")).toBe(false);
  expect(f.repo.getMeta("semantic_extractor_revision")).toBe(SEMANTIC_EXTRACTOR_REVISION);
  seed(); await new VerticalSliceTracer(f.repo, f.root, [], false).traceAsync("/phantom");
  expect(f.repo.getAllVerticalSlices().some(slice => slice.route_uri === "/phantom")).toBe(false);
  expect(f.repo.getMeta("semantic_extractor_revision")).toBe(SEMANTIC_EXTRACTOR_REVISION);
});
