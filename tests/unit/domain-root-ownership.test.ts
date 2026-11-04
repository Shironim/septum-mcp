import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { handleRegisterDomain } from "../../src/mcp/tools/register-domain.ts";
import { sliceIntegrityCases } from "../fixtures/slice-integrity-cases.ts";
import { TopologyDetector } from "../../src/core/discovery/topology-detector.ts";
import { pathToFileURL } from "node:url";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";

describe("single domain owner per physical root", () => {
  let root: string, db: SeptumDatabase, repo: SeptumRepository;
  beforeEach(() => {
    root = mkdtempSync("/tmp/septum-domain-owner-");
    db = new SeptumDatabase(":memory:"); repo = new SeptumRepository(db.raw);
    repo.setMeta("workspace_root", root);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = () => ConfigLoader.getDefaultConfig();
  const put = (file: string, text: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };

  for (const fixture of sliceIntegrityCases) it(`${fixture.framework}: refuses duplicate owners before changing indexed facts`, async () => {
    for (const [file, text] of Object.entries(fixture.files)) put(file, text);
    const cfg = config(); cfg.domains = { root: { root: ".", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };
    const pipeline = new IngestionPipeline(repo, root);
    await pipeline.run(cfg, { verifyContent: true });
    const before = repo.getAllFiles();
    cfg.domains.alias = { ...cfg.domains.root, root: "./" };
    await expect(pipeline.run(cfg)).rejects.toThrow("Domain root conflict");
    expect(repo.getAllFiles()).toEqual(before);
    expect(repo.getAllDomains().map(domain => domain.name)).toEqual(["root"]);
    delete cfg.domains.alias;
    const recovered = await pipeline.run(cfg, { verifyContent: true });
    expect(recovered.parser_invocations).toBe(0);
    expect(repo.getMeta("sync_state")).toBe("complete");
  });

  it("rejects repository aliases transactionally and allows same-name updates", () => {
    repo.upsertDomain("orders", { root: "src/orders" });
    expect(() => repo.upsertDomain("alias", { root: "src/x/../orders/" })).toThrow("Domain root conflict");
    expect(repo.getAllDomains()).toHaveLength(1);
    const id = repo.getDomainByName("orders")!.id;
    expect(repo.upsertDomain("ORDERS", { root: "./src/orders" })).toBe(id);
  });

  it("rejects physical symlink aliases, including not-yet-created descendants", () => {
    mkdirSync(join(root, "src")); symlinkSync("src", join(root, "alias"), "dir");
    repo.upsertDomain("source", { root: "src/new" });
    expect(() => repo.upsertDomain("other", { root: "alias/new" })).toThrow("Domain root conflict");
  });

  it("uses SQLite name equivalence when checking non-ASCII owners", () => {
    repo.upsertDomain("Ä", { root: "src" });
    expect(repo.getDomainByName("ä")).toBeNull();
    expect(() => repo.upsertDomain("ä", { root: "./src" })).toThrow("Domain root conflict");
    expect(repo.getAllDomains()).toHaveLength(1);
    const cfg = config(); cfg.domains = {
      "Ä": { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      "ä": { root: "./src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };
    expect(() => new ModuleResolver(root).resolveSourceDomain("src/app.ts", cfg)).toThrow("Domain root conflict");
  });

  it("serializes competing root registrations from two processes", async () => {
    const file = join(root, ".septum/race.db");
    const shared = new SeptumDatabase(file);
    new SeptumRepository(shared.raw).setMeta("workspace_root", root);
    shared.close();
    const databaseModule = pathToFileURL(join(import.meta.dir, "../../src/core/database/client.ts")).href;
    const repositoryModule = pathToFileURL(join(import.meta.dir, "../../src/core/database/repository.ts")).href;
    const code = `import {SeptumDatabase} from ${JSON.stringify(databaseModule)};
      import {SeptumRepository} from ${JSON.stringify(repositoryModule)};
      const timer = setTimeout(() => process.exit(3), 8000); timer.unref();
      const db = new SeptumDatabase(process.env.OWNER_TEST_DB);
      try { new SeptumRepository(db.raw).upsertDomain(process.env.OWNER_TEST_NAME, {root:'.'}); }
      catch(error) { if (error.code === 'DOMAIN_ROOT_CONFLICT') process.exitCode=2; else throw error; }
      finally { db.close(); }`;
    const children = ["first", "second"].map(name => Bun.spawn([process.execPath, "--eval", code], {
      env: { ...process.env, OWNER_TEST_DB: file, OWNER_TEST_NAME: name }, stdout: "pipe", stderr: "pipe",
    }));
    const outcomes = await Promise.all(children.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(outcomes.map(result => result.code).sort()).toEqual([0, 2]);
    expect(outcomes.every(result => result.stderr === "")).toBe(true);
    const reopened = new SeptumDatabase(file);
    try { expect(new SeptumRepository(reopened.raw).getAllDomains()).toHaveLength(1); }
    finally { reopened.close(); }
  });

  it("does not let auto-discovery create another owner for an explicitly registered root", () => {
    put("package.json", '{"name":"fixture"}'); put("src/core/run.ts", "export const run = 1;");
    repo.upsertDomain("custom", { root: "src/core", forbidden_dependencies: ["billing"] });
    TopologyDetector.discoverAndPersist(repo, root);
    expect(repo.getDomainByName("core")).toBeNull();
    expect(repo.getDomainByName("custom")!.forbidden_deps_json).toBe('["billing"]');
  });

  it("uses stored ownership instead of inferring aliases when sync receives no domains", async () => {
    put("package.json", '{"name":"fixture"}'); put("src/core/run.ts", "export const run = 1;");
    repo.upsertDomain("custom", { root: "src/core", forbidden_dependencies: ["billing"] });
    const cfg = config();
    await new IngestionPipeline(repo, root).run(cfg);
    expect(repo.getDomainByName("core")).toBeNull();
    expect(cfg.domains.custom.root).toBe("src/core");
    expect(repo.getFileByPath("src/core/run.ts")!.domain_id).toBe(repo.getDomainByName("custom")!.id);
  });

  it("checks retained SQLite owners before parser-revision invalidation or JIT writes", async () => {
    put("app.ts", "export const app = 1;");
    const cfg = config(); cfg.domains.root = { root: ".", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} };
    const pipeline = new IngestionPipeline(repo, root); await pipeline.run(cfg);
    db.raw.query("INSERT INTO domains(name,root_path) VALUES ('legacy','./')").run();
    repo.setMeta("parser_revision", "old-revision");
    const before = repo.getAllFiles();
    await expect(pipeline.run(cfg)).rejects.toThrow("Domain root conflict");
    await expect(pipeline.ingestFile(join(root, "app.ts"), cfg)).rejects.toThrow("Domain root conflict");
    expect(repo.getAllFiles()).toEqual(before);
    expect(repo.getMeta("parser_revision")).toBe("old-revision");
  });

  it("rejects registration before mutating SQLite or caller configuration", async () => {
    const cfg = config(); cfg.domains.orders = { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} };
    repo.upsertDomain("orders", cfg.domains.orders);
    const before = JSON.stringify(cfg);
    await expect(handleRegisterDomain(repo, cfg, { domain: "alias", root: "./src/orders" }, root)).rejects.toThrow("Domain root conflict");
    expect(JSON.stringify(cfg)).toBe(before);
    expect(repo.getDomainByName("alias")).toBeNull();
  });

  it("preserves most-specific ownership for nested domains and stable warm ingestion", async () => {
    put("src/orders/run.ts", "export function run() { return 1; }");
    put("src/common.ts", "export const common = 1;");
    const cfg = config();
    cfg.domains = {
      source: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };
    const pipeline = new IngestionPipeline(repo, root); await pipeline.run(cfg);
    const owner = repo.getFileByPath("src/orders/run.ts")!.domain_id;
    expect(owner).toBe(repo.getDomainByName("orders")!.id);
    expect((await pipeline.run(cfg)).parser_invocations).toBe(0);
    expect(await pipeline.ingestFile(join(root, "src/orders/run.ts"), cfg)).toBe(false);
    expect(repo.getFileByPath("src/orders/run.ts")!.domain_id).toBe(owner);
  });

  it("does not choose an owner from conflicting direct policy configuration", () => {
    const cfg = config(); cfg.domains = { a: { root: ".", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      b: { root: "./", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };
    expect(() => new ModuleResolver(root).resolveSourceDomain("app.py", cfg)).toThrow("Domain root conflict");
    const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root));
    expect(() => evaluator.auditCodebase(cfg)).toThrow("Domain root conflict");
    expect(() => evaluator.evaluate("app.py", [], cfg)).toThrow("Domain root conflict");
    expect(() => evaluator.detectCircularDependencies(cfg, [])).toThrow("Domain root conflict");
  });

  it("allows repairing a legacy duplicate by moving a domain without deleting policy", async () => {
    repo.upsertDomain("root", { root: ".", forbidden_dependencies: ["billing"] });
    db.raw.query("INSERT INTO domains(name,root_path) VALUES ('legacy','./')").run();
    const cfg = ConfigLoader.loadFromRepository(repo);
    await handleRegisterDomain(repo, cfg, { domain: "legacy", root: "src/legacy" }, root);
    expect(repo.getDomainByName("root")!.forbidden_deps_json).toBe('["billing"]');
    expect(repo.getDomainByName("legacy")!.root_path).toBe("src/legacy");
    expect(repo.getAllDomains()).toHaveLength(2);
  });

  it("reports an unavailable index during a multi-step legacy repair without ingestion", async () => {
    repo.upsertDomain("root", { root: "." });
    db.raw.query("INSERT INTO domains(name,root_path) VALUES ('first','./'),('second','./')").run();
    const cfg = ConfigLoader.loadFromRepository(repo);
    const pipeline = new IngestionPipeline(repo, root);
    await expect(pipeline.run(cfg)).rejects.toThrow("Domain root conflict");
    const result = JSON.parse((await handleRegisterDomain(repo, cfg, { domain: "first", root: "first" }, root)).content[0].text);
    expect(result.status).toBe("success");
    expect(result.index_status).toEqual({ sync_state: "error", code: "DOMAIN_ROOT_CONFLICT" });
    expect(result.next).toHaveLength(1);
    await expect(pipeline.run(cfg)).rejects.toThrow("Domain root conflict");
    mkdirSync(join(root, "first")); mkdirSync(join(root, "second"));
    await handleRegisterDomain(repo, cfg, { domain: "second", root: "second", ingest_now: true }, root);
    expect(repo.getMeta("sync_state")).toBe("complete");
    expect(repo.getMeta("sync_error_code")).toBe("");
    expect(repo.getAllDomains()).toHaveLength(3);
  });
});
