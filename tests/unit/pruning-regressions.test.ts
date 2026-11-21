import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { collectSourceSkips } from "../../src/core/resources/source-files.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { auditStagedFiles } from "../../src/core/boundary/staged-auditor.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { SerialWorkQueue } from "../../src/core/resources/work-queue.ts";
import { WorkspaceWatcher, WatchBudget } from "../../src/mcp/workspace-watcher.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { SemanticSliceExtractorRegistry } from "../../src/core/parser/extractors/registry.ts";

describe("refactoring preserves capabilities with bounded work", () => {
  let root: string, db: SeptumDatabase, repo: SeptumRepository, pipeline: IngestionPipeline;
  let config: ReturnType<typeof ConfigLoader.getDefaultConfig>;
  const put = (file: string, source: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "septum-pruning-"));
    mkdirSync(join(root, "src"));
    db = new SeptumDatabase(join(root, ".septum/septum.db"));
    repo = new SeptumRepository(db.raw);
    pipeline = new IngestionPipeline(repo, root);
    config = ConfigLoader.getDefaultConfig();
    config.domains = { core: { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] } };
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("does not reread source or update file metadata on an unchanged warm sync", async () => {
    put("src/a.ts", "export function entry() { return 1; }");
    await pipeline.run(config);
    const updates = spyOn(repo, "updateFileMetadataOnly");
    try {
      const fast = await collectSourceSkips(root, () => pipeline.run(config));
      expect(fast.value.files_updated).toBe(0);
      expect(fast.value.parser_invocations).toBe(0);
      expect(fast.inputs).toEqual([]);
      const verified = await collectSourceSkips(root, () => pipeline.run(config, { verifyContent: true }));
      expect(verified.inputs.some(input => input.path === "src/a.ts")).toBe(true);
      expect(updates).not.toHaveBeenCalled();
    } finally { updates.mockRestore(); }
  });

  it("skips reconciliation on a healthy native watcher but hashes notified same-metadata edits", async () => {
    put("src/a.ts", "export function before() {}");
    await pipeline.run(config);
    const watcher = new WorkspaceWatcher(root, repo, pipeline, Promise.resolve(), new SerialWorkQueue(), new WatchBudget(), () => config);
    try {
      expect(watcher.mode).toBe("native");
      await watcher.flush(true);
      const run = spyOn(pipeline, "run");
      try { await watcher.flush(false); expect(run).not.toHaveBeenCalled(); }
      finally { run.mockRestore(); }
      const file = join(root, "src/a.ts"), stat = statSync(file);
      put("src/a.ts", "export function after_() {}");
      utimesSync(file, stat.atime, stat.mtime);
      watcher.notify("src/a.ts");
      await watcher.flush(false);
      expect(repo.findSymbolsByName("after_")).toHaveLength(1);
      expect(repo.findSymbolsByName("before")).toHaveLength(0);
    } finally { await watcher.close(); }
  });

  it("honors include_source false while retaining inspect as a context alias", async () => {
    put("src/a.ts", "export function entry() { return 1; }");
    await pipeline.run(config);
    for (const action of ["context", "inspect"] as const) {
      const result = await handleSymbolTool(repo, config, { action, query: "entry", include_source: false , format: "json"}, undefined, root);
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.symbol).toBe("entry");
      expect(payload.source_slice).toBeUndefined();
      expect(payload.items).toBeUndefined();
    }
  });

  it("watches semantic source directories outside registered domain roots", async () => {
    put("artisan", "");
    put("routes/web.php", "<?php\nRoute::get('/before', [ApiController::class, 'before']);\n");
    await pipeline.run(config);
    const watcher = new WorkspaceWatcher(root, repo, pipeline, Promise.resolve(), new SerialWorkQueue(), new WatchBudget(), () => config);
    try {
      await watcher.flush(true);
      put("routes/api.php", "<?php\nRoute::get('/after', [ApiController::class, 'after']);\n");
      const deadline = Date.now() + 2000;
      do {
        await watcher.flush(false);
        if (repo.getAllVerticalSlices().some(slice => slice.route_uri === "/after")) break;
        await Bun.sleep(5);
      } while (Date.now() < deadline);
      expect(repo.getAllVerticalSlices().map(slice => slice.route_uri)).toContain("/after");
    } finally { await watcher.close(); }
  });

  it("binds identities to actual SQL facts, external writes and rollback without full JS dumps", async () => {
    put("src/a.ts", "export function entry() { return 1; }");
    await pipeline.run(config);
    const files = spyOn(repo, "getAllFiles").mockImplementation(() => { throw new Error("full file dump"); });
    const symbols = spyOn(repo, "getAllSymbolsWithFiles").mockImplementation(() => { throw new Error("full symbol dump"); });
    const deps = spyOn(repo, "getAllDependenciesWithDomains").mockImplementation(() => { throw new Error("full dependency dump"); });
    const other = new SeptumDatabase(join(root, ".septum/septum.db"));
    try {
      const first = repo.getIndexIdentity();
      expect(repo.getIndexIdentity()).toBe(first);
      repo.setMeta("last_sync", "irrelevant operational update");
      expect(repo.getIndexIdentity()).toBe(first);
      other.raw.run("UPDATE symbols SET signature = 'changed signature'");
      const second = repo.getIndexIdentity();
      expect(second).not.toBe(first);
      expect(() => repo.runInTransaction(() => {
        db.raw.run("UPDATE dependencies SET line_number = 999");
        db.raw.run("UPDATE symbols SET signature = 'rolled back'");
        expect(repo.getIndexIdentity()).not.toBe(second);
        throw new Error("rollback");
      })).toThrow("rollback");
      expect(repo.getIndexIdentity()).toBe(second);
    } finally { other.close(); files.mockRestore(); symbols.mockRestore(); deps.mockRestore(); }
  });

  it("expands only the selected functional handler using per-file lookups", async () => {
    put("src/entry.ts", 'import { save } from "./service";\nimport { unused } from "./unused";\nexport function entry() { return save(); }\nexport function other() { return unused(); }');
    put("src/service.ts", "export function save() { return 1; }");
    put("src/unused.ts", "export function unused() { return 0; }");
    await pipeline.run(config);
    const files = spyOn(repo, "getAllFiles").mockImplementation(() => { throw new Error("full file dump"); });
    const symbols = spyOn(repo, "getAllSymbolsWithFiles").mockImplementation(() => { throw new Error("full symbol dump"); });
    const deps = spyOn(repo, "getAllDependenciesWithDomains").mockImplementation(() => { throw new Error("full dependency dump"); });
    try {
      const chain = new CallGraphTracer(repo, root).expandChainFromMethod("src/entry.ts", "entry", []);
      expect(chain.map(node => node.file)).toEqual(["src/service.ts"]);
    } finally { files.mockRestore(); symbols.mockRestore(); deps.mockRestore(); }
  });

  it("includes explicitly typed TS and PHP injected collaborators", async () => {
    put("src/Handler.ts", 'import { Storage } from "./Storage";\nexport class Handler {\n constructor(private repo: Storage) {}\n run() { return this.repo.save(); }\n}');
    put("src/Storage.ts", "export class Storage { save() {} }");
    put("src/PhpHandler.php", '<?php\nuse App\\Storage;\nclass PhpHandler {\n public function __construct(private Storage $repo) {}\n public function run() { return $this->repo->save(); }\n}');
    await pipeline.run(config);
    for (const file of ["src/Handler.ts", "src/PhpHandler.php"]) {
      const chain = new CallGraphTracer(repo, root).expandChainFromMethod(file, "run", []);
      expect(chain.some(node => node.file === "src/Storage.ts")).toBe(true);
    }
  });

  it("reuses verified unchanged staged ASTs and reparses mismatching cache entries", async () => {
    for (let i = 0; i < 12; i++) put(`src/file${i}.ts`, `export function entry${i}() { return ${i}; }`);
    await pipeline.run(config);
    put(".gitattributes", "*.ts filter=broken\n");
    git("init", "-q"); git("add", "src", ".gitattributes");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
    // Snapshot reads must neither execute smudge filters nor transform blob bytes.
    git("config", "filter.broken.smudge", "false");
    git("config", "filter.broken.clean", "cat");
    git("config", "filter.broken.required", "true");
    put("src/file0.ts", 'import { entry1 } from "./file1"; export function entry0() { return entry1(); }');
    git("add", "src/file0.ts");
    const parse = spyOn(ASTParserEngine.prototype, "parseFile");
    try {
      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
      const result = await auditStagedFiles(evaluator, config, root, repo);
      expect(result.files).toEqual(["src/file0.ts"]);
      expect(result.violations).toEqual([]);
      expect(parse).toHaveBeenCalledTimes(1);
      // The DB may reflect unstaged source while the index still holds older bytes.
      put("src/file1.ts", 'import { entry0 } from "./file0"; export function entry1() { return entry0(); }');
      await pipeline.ingestFile(join(root, "src/file1.ts"), config);
      parse.mockClear();
      expect((await auditStagedFiles(evaluator, config, root, repo)).violations).toEqual([]);
      expect(parse).toHaveBeenCalledTimes(2);
    } finally { parse.mockRestore(); }
  });

  it("retains all twelve semantic adapters alongside language extraction", async () => {
    expect(SemanticSliceExtractorRegistry.getCapabilities().map(adapter => adapter.id).sort()).toEqual([
      "django", "elysia", "express", "fastapi", "fastify", "flask", "golang", "hono", "laravel", "mcp-cli", "nestjs", "symfony",
    ]);
    put("src/example.py", "def entry():\n    return 1\n");
    put("src/example.go", "package example\nfunc Run() {}\n");
    await pipeline.run(config);
    expect(repo.findSymbolsByName("entry")).toHaveLength(1);
    expect(repo.findSymbolsByName("Run")).toHaveLength(1);
  });
});
