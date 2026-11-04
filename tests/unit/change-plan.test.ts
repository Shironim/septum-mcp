import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { handleBoundaryTool } from "../../src/mcp/tools/boundary.ts";
import { BoundaryToolSchema } from "../../src/mcp/schemas.ts";
import { handleRegisterFeature } from "../../src/mcp/tools/register-feature.ts";
import { SessionManager } from "../../src/core/session/session-manager.ts";

describe("change plan independent policy oracle", () => {
  let root: string, db: SeptumDatabase, repo: SeptumRepository;
  let config: ReturnType<typeof ConfigLoader.getDefaultConfig>;
  const put = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", ...args], { cwd: root }); expect(result.exitCode).toBe(0); };
  const sync = () => new IngestionPipeline(repo, root).run(config, { verifyContent: true });
  const call = async (args: Record<string, unknown>) => {
    const result = await handleBoundaryTool(new BoundaryEvaluator(repo, new ModuleResolver(root, repo)), config,
      BoundaryToolSchema.parse(args), repo, root);
    return JSON.parse(result.content[0]!.text);
  };
  const plan = (changes = [{ file_path: "src/orders/submit.ts", proposed_imports: ["../shared/validate"] }], extra = {}) => call({ action: "plan", changes, ...extra });
  beforeEach(async () => {
    root = mkdtempSync("/tmp/septum-change-plan-");
    put(".gitignore", ".septum/\nignored/\n"); put("package.json", "{}");
    put("src/orders/submit.ts", "export function submit() { return 1; }\n");
    put("src/shared/validate.ts", "export function validate() { return true; }\n");
    put("src/shared/other.ts", "export const other = 1;\n");
    put("src/billing/invoice.ts", "export const invoice = 1;\n");
    git("init", "-q"); git("add", ".");
    db = new SeptumDatabase(join(root, ".septum/septum.db")); repo = new SeptumRepository(db.raw);
    config = ConfigLoader.getDefaultConfig();
    config.domains = {
      orders: { root: "src/orders", allowed_dependencies: ["shared"], forbidden_dependencies: ["billing"], archetypes: {} },
      shared: { root: "src/shared", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
      billing: { root: "src/billing", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };
    await sync();
  });
  afterEach(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });

  it("evaluates each file's imports and never saves rejected or unresolved plans", async () => {
    const good = await plan(); expect(good.status).toBe("approved"); expect(good.plan_ref).toMatch(/^[a-f0-9]{64}$/);
    const bad = await plan([
      { file_path: "src/orders/submit.ts", proposed_imports: ["../billing/invoice"] },
      { file_path: "src/shared/new.ts", proposed_imports: [] },
    ]);
    expect(bad.status).toBe("rejected"); expect(bad.results[0].violations[0].rule).toBe("forbidden_dependency");
    expect(bad.results[1].status).toBe("approved"); expect(bad.plan_ref).toBeUndefined();
    expect((await plan([{ file_path: "src/orders/new.ts", proposed_imports: ["./missing"] }])).status).toBe("unknown");
    expect((await call({ action: "verify", plan_ref: good.plan_ref })).status).toBe("approved");
  });

  it("verifies subsequent worktree content without claiming a different staged blob is approved", async () => {
    const saved = await plan();
    put("src/orders/submit.ts", 'import { validate } from "../shared/validate";\nexport function submit() { return validate(); }\n');
    await sync();
    const result = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(result.status).toBe("approved"); expect(result.changed_files.map((f: any) => f.file_path)).toEqual(["src/orders/submit.ts"]);
    expect(result.worktree_index_differences).toContain("src/orders/submit.ts"); expect(result.basis.staged_policy_checked).toBe(false);
    git("add", "src/orders/submit.ts");
    const staged = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(staged.index_changes).toContain("src/orders/submit.ts"); expect(staged.worktree_index_differences).not.toContain("src/orders/submit.ts");
  });

  it("rejects outside-plan creates, deletes and renames, including documentation", async () => {
    const saved = await plan();
    put("NOTES.md", "unplanned\n");
    renameSync(join(root, "src/shared/other.ts"), join(root, "src/shared/renamed.ts"));
    const result = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(result.status).toBe("rejected");
    expect(result.outside_plan).toEqual(["NOTES.md", "src/shared/other.ts", "src/shared/renamed.ts"]);
  });

  it("rejects undeclared new imports even when domain policy permits them", async () => {
    const saved = await plan();
    put("src/orders/submit.ts", 'import { other } from "../shared/other";\nexport const submit = other;\n');
    await sync();
    const result = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(result.status).toBe("rejected"); expect(result.results[0].undeclared_imports).toEqual(["../shared/other"]);
  });

  it("retains dirty baseline imports while rejecting a planned edit that becomes a delete", async () => {
    put("src/orders/submit.ts", 'import { other } from "../shared/other"; export const submit = other;\n'); await sync();
    const saved = await plan();
    put("src/orders/submit.ts", 'import { other } from "../shared/other"; export const submit = other + 1;\n'); await sync();
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).status).toBe("approved");
    rmSync(join(root, "src/orders/submit.ts")); await sync();
    const result = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(result.status).toBe("rejected"); expect(result.unexpected_deletes).toEqual(["src/orders/submit.ts"]);
  });

  it("supports explicit deletes and invalidates a plan when policy or the active lease changes", async () => {
    const saved = await call({ action: "plan", changes: [{ file_path: "src/orders/submit.ts", operation: "delete" }] });
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).pending_deletes).toEqual(["src/orders/submit.ts"]);
    rmSync(join(root, "src/orders/submit.ts")); await sync();
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).status).toBe("approved");
    config.domains.orders.forbidden_dependencies.push("shared");
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).status).toBe("stale_plan");
    config.domains.orders.forbidden_dependencies.pop();
    await handleRegisterFeature(repo, config, { feature_key: "orders", domain: "orders", allowed_touchpoints: ["src/orders/submit.ts"] }, root);
    const locked = await plan(); expect(locked.status).toBe("approved");
    SessionManager.clearActiveSession(root);
    expect((await call({ action: "verify", plan_ref: locked.plan_ref })).status).toBe("stale_plan");
  });

  it("does not persist previews, survives reopening, and refuses wrong refs and escaped/ignored/internal paths", async () => {
    const preview = await plan(undefined, { dry_run: true });
    expect(preview.saved).toBe(false); expect((await call({ action: "verify", plan_ref: preview.plan_ref })).status).toBe("stale_plan");
    const saved = await plan(); db.close(); db = new SeptumDatabase(join(root, ".septum/septum.db")); repo = new SeptumRepository(db.raw);
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).status).toBe("approved");
    expect((await call({ action: "verify", plan_ref: "0".repeat(64) })).status).toBe("stale_plan");
    for (const file_path of ["../escape.ts", ".septum/session.json", "ignored/new.ts"]) {
      await expect(plan([{ file_path, proposed_imports: [] }])).rejects.toThrow();
    }
    symlinkSync("/tmp", join(root, "src/escape"));
    await expect(plan([{ file_path: "src/escape/new.ts", proposed_imports: [] }])).rejects.toThrow();
  });

  it("rejects competing scopes, duplicate normalized paths and plan arguments silently ignored by verify", () => {
    for (const args of [
      { action: "plan", changes: [] },
      { action: "plan", scope: "file", changes: [{ file_path: "src/a.ts" }] },
      { action: "verify", plan_ref: "a".repeat(64), changes: [{ file_path: "src/a.ts" }] },
      { action: "check", changes: [{ file_path: "src/a.ts" }] },
      { action: "plan", changes: [{ file_path: "src/a.ts", operation: "delete", proposed_imports: ["./b"] }] },
    ]) expect(BoundaryToolSchema.safeParse(args).success).toBe(false);
  });

  it("detects a forbidden edge in an unchanged caller after a planned alias-config edit", async () => {
    put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@rule": ["src/shared/validate.ts"] } } }));
    put("src/orders/submit.ts", 'import { validate } from "@rule"; export const submit = validate;\n'); await sync();
    const saved = await plan([{ file_path: "tsconfig.json", proposed_imports: [] }]);
    expect(saved.status).toBe("approved");
    put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@rule": ["src/billing/invoice.ts"] } } })); await sync();
    const result = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(result.status).toBe("rejected");
    expect(result.workspace_audit.violations.some((v: any) => v.file === "src/orders/submit.ts" && v.rule === "forbidden_dependency")).toBe(true);
  });

  it("reports staging-only changes and mode changes without attributing existing dirty state", async () => {
    const saved = await plan();
    chmodSync(join(root, "src/shared/other.ts"), 0o755);
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).outside_plan).toEqual(["src/shared/other.ts"]);
    chmodSync(join(root, "src/shared/other.ts"), 0o644);
    put("src/shared/other.ts", "export const other = 2;\n"); git("add", "src/shared/other.ts");
    put("src/shared/other.ts", "export const other = 1;\n");
    const result = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(result.status).toBe("rejected"); expect(result.changed_files).toEqual([]);
    expect(result.index_changes).toEqual(["src/shared/other.ts"]);
  });

  it("does not save a baseline observed to change during plan evaluation", async () => {
    const saved = await plan();
    const original = repo.getFileInboundImpact.bind(repo);
    repo.getFileInboundImpact = file => { put("src/shared/other.ts", "export const other = 3;\n"); return original(file); };
    const mutated = await plan();
    expect(mutated.status).toBe("unknown"); expect(mutated.reason).toBe("inputs_changed");
    expect(JSON.parse(repo.getMeta("change_plan_v1")!).ref).toBe(saved.plan_ref);
  });

  it("refuses duplicate paths and missing deletions, and invalidates policy by facts rather than timestamps", async () => {
    await expect(plan([
      { file_path: "src/orders/submit.ts", proposed_imports: [] },
      { file_path: "src/orders/./submit.ts", proposed_imports: [] },
    ])).rejects.toThrow("Duplicate planned path");
    await expect(call({ action: "plan", changes: [{ file_path: "src/orders/missing.ts", operation: "delete" }] })).rejects.toThrow("missing file");
    const saved = await plan();
    for (const domain of repo.getAllDomains()) repo.domains.upsertDomain(domain.name, config.domains[domain.name]!);
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).status).toBe("approved");
    repo.domains.upsertDomain("orders", { ...config.domains.orders, forbidden_dependencies: ["billing", "shared"] });
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).status).toBe("stale_plan");
  });

  it("rechecks architecture when an ignored resolver config changes without a visible worktree delta", async () => {
    put(".gitignore", ".septum/\nlocal-config.json\n");
    put("tsconfig.json", JSON.stringify({ extends: "./local-config.json" }));
    put("local-config.json", JSON.stringify({ compilerOptions: { paths: { "@rule": ["src/shared/validate.ts"] } } }));
    put("src/orders/submit.ts", 'import { validate } from "@rule"; export const submit = validate;\n'); await sync();
    const saved = await plan(); expect(saved.status).toBe("approved");
    put("local-config.json", JSON.stringify({ compilerOptions: { paths: { "@rule": ["src/billing/invoice.ts"] } } })); await sync();
    const result = await call({ action: "verify", plan_ref: saved.plan_ref });
    expect(result.changed_files).toEqual([]); expect(result.status).toBe("rejected");
    expect(result.workspace_audit.violations[0].rule).toBe("forbidden_dependency");
  });

  it("provides corrupt-plan recovery and fails explicitly on oversized inventory inputs", async () => {
    const saved = await plan();
    repo.setMeta("change_plan_v1", "corrupt");
    expect((await call({ action: "verify", plan_ref: saved.plan_ref })).reason).toBe("saved_plan_corrupt");
    const replacement = await plan();
    put("oversized.bin", "x".repeat(2 * 1024 * 1024 + 1));
    await expect(call({ action: "verify", plan_ref: replacement.plan_ref })).rejects.toThrow(/byte limit/);
  });

  it("preserves omitted versus explicit-empty import provenance through normalized dispatch", async () => {
    for (const supplied of [false, true]) {
      const raw = { scope: "file", file_path: "src/orders/submit.ts", ...(supplied ? { proposed_imports: [] } : {}) };
      const result = await handleBoundaryTool(new BoundaryEvaluator(repo, new ModuleResolver(root, repo)), config,
        BoundaryToolSchema.parse(raw), repo, root, raw);
      expect(JSON.parse(result.content[0]!.text).evaluated_scope.proposed_imports_supplied).toBe(supplied);
    }
  });
});
