import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import { PARSER_REVISION } from "../parser/language-capabilities.ts";
import { SEMANTIC_EXTRACTOR_REVISION } from "../parser/semantic-revision.ts";
import { RESOLVER_REVISION } from "../resolver/import-resolver.ts";
import { assertPathContained } from "../resolver/path-resolver.ts";
import { RESOURCE_LIMITS } from "../resources/limits.ts";
import { readSourceFile } from "../resources/source-files.ts";
import { resolveEffectiveFeature } from "../session/effective-feature.ts";
import { SessionManager } from "../session/session-manager.ts";
import type { BoundaryEvaluator } from "./evaluator.ts";
import type { CheckBoundaryArgs } from "../../mcp/schemas.ts";

const STORAGE_KEY = "change_plan_v1";
const REVISION = "git-visible-change-plan/v1";
type FileVersion = { hash: string; mode: string; git_hash: string };
type Snapshot = { files: Record<string, FileVersion | null>; index: Record<string, string> };
type PlannedChange = { file_path: string; operation: "edit" | "delete"; proposed_imports: string[]; baseline_imports: string[] };
type Plan = { revision: string; root: string; policy: string; feature?: string; changes: PlannedChange[]; baseline: Snapshot };
type Evaluation = { status: string; [key: string]: unknown };
type Check = (file: string, imports: string[], feature?: string) => Promise<Evaluation>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const git = (root: string, args: string[]) => execFileSync("git", ["--literal-pathspecs", ...args], {
  cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
function internal(file: string, config: ValidatedSeptumConfig, root: string): boolean {
  const database = relative(root, resolve(root, config.settings.db_path)).replace(/\\/g, "/");
  return file === ".septum" || file.startsWith(".septum/") || file === ".git" || file.startsWith(".git/") ||
    file === database || file === database + "-wal" || file === database + "-shm";
}
function pathInWorkspace(file: string, root: string, config: ValidatedSeptumConfig): string {
  if (isAbsolute(file) || /^[a-zA-Z]:/.test(file)) throw new Error("Plan paths must be workspace-relative exact paths.");
  const normalized = relative(root, resolve(root, file.replace(/\\/g, "/"))).replace(/\\/g, "/");
  assertPathContained(normalized, root, "Change plan path");
  if (!normalized || internal(normalized, config, root) || /[*?\[\]\x00-\x1f]/.test(normalized)) throw new Error(`Invalid or internal plan path '${file}'.`);
  return normalized;
}

/** The comparison scope is Git-visible paths, not ignored artifacts or an OS snapshot. */
function capture(root: string, config: ValidatedSeptumConfig): Snapshot {
  const index: Snapshot["index"] = Object.create(null);
  for (const entry of git(root, ["ls-files", "--stage", "-z", "--", "."]).split("\0").filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== "0" || !["100644", "100755"].includes(match[1]!)) throw new Error("Cannot compare a conflicted index, symlink or submodule.");
    if (!internal(match[4]!, config, root)) index[match[4]!] = `${match[1]}:${match[2]}`;
  }
  const paths = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."]).split("\0").filter(file => file && !internal(file, config, root)))].sort();
  if (paths.length > 20000) throw new Error("Change inventory exceeds 20000 paths.");
  const format = git(root, ["rev-parse", "--show-object-format"]).trim();
  if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported Git object format.");
  const files: Snapshot["files"] = Object.create(null);
  let bytes = 0;
  for (const file of paths) {
    assertPathContained(file, root, "Change inventory");
    const full = resolve(root, file);
    let stat;
    try { stat = lstatSync(full); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { files[file] = null; continue; } throw error; }
    if (!stat.isFile()) throw new Error(`Cannot compare nonregular file '${file}'.`);
    if (stat.size > RESOURCE_LIMITS.sourceBytes) throw new Error("Change inventory exceeds source byte limit.");
    const fd = openSync(full, "r");
    let buffer: Buffer;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > RESOURCE_LIMITS.sourceBytes) throw new Error(`File changed before inventory read: '${file}'.`);
      const bounded = Buffer.alloc(opened.size + 1);
      let size = 0;
      while (size < bounded.length) {
        const count = readSync(fd, bounded, size, bounded.length - size, null);
        if (!count) break;
        size += count;
      }
      const after = fstatSync(fd);
      if (size !== opened.size || size !== after.size || opened.mtimeMs !== after.mtimeMs) throw new Error(`File changed during inventory read: '${file}'.`);
      buffer = bounded.subarray(0, size);
    } finally { closeSync(fd); }
    if (buffer.length > RESOURCE_LIMITS.sourceBytes || (bytes += buffer.length) > 128 * 1024 * 1024) throw new Error("Change inventory exceeds source/total byte limits.");
    files[file] = { hash: createHash("sha256").update(buffer).digest("hex"), mode: stat.mode & 0o111 ? "100755" : "100644",
      git_hash: createHash(format).update(`blob ${buffer.length}\0`).update(buffer).digest("hex") };
  }
  return { files, index };
}
function policy(root: string, config: ValidatedSeptumConfig, repo: SeptumRepository, feature?: string): string {
  const effective = structuredClone(config);
  const key = resolveEffectiveFeature(root, effective, feature);
  return digest({ domains: effective.domains, settings: effective.settings, feature: key ? effective.features?.[key] : null,
    registered_domains: repo.getAllDomains().map(domain => ({ name: domain.name, root: domain.root_path,
      allowed: JSON.parse(domain.allowed_deps_json), forbidden: JSON.parse(domain.forbidden_deps_json), archetypes: JSON.parse(domain.archetypes_json) })),
    stored_feature: key ? JSON.parse(repo.getMeta("features_json") || "{}")[key] : null,
    session: SessionManager.getActiveSession(root), parser: PARSER_REVISION, resolver: RESOLVER_REVISION, semantic: SEMANTIC_EXTRACTOR_REVISION });
}
function differences<T>(before: Record<string, T>, after: Record<string, T>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => stable(before[file] ?? null) !== stable(after[file] ?? null)).sort();
}
async function imports(root: string, file: string): Promise<string[]> {
  if (!ASTParserEngine.isSourceFile(file)) return [];
  const parsed = await new ASTParserEngine().parseFile(file, readSourceFile(resolve(root, file)));
  if (parsed.status !== "parsed") throw new Error(`Cannot verify imports for '${file}': parser ${parsed.status}.`);
  return [...new Set(parsed.dependencies.map(dep => dep.target))].sort();
}
function aggregate(results: Evaluation[], rejected: boolean): string {
  return rejected || results.some(item => item.status === "rejected") ? "rejected" : results.some(item => item.status !== "approved") ? "unknown" : "approved";
}

export async function evaluateChangePlan(evaluator: BoundaryEvaluator, config: ValidatedSeptumConfig, args: CheckBoundaryArgs,
  repo: SeptumRepository, workspaceRoot: string, check: Check, audit: () => Promise<Evaluation>) {
  const root = realpathSync(workspaceRoot);
  const basis = { workspace: root, comparison_scope: "git_visible_worktree_and_index_since_plan", staged_policy_checked: false,
    implementation: { plan: REVISION, parser: PARSER_REVISION, resolver: RESOLVER_REVISION, semantic: SEMANTIC_EXTRACTOR_REVISION },
    index_state: repo.getMeta("sync_state") || "unindexed",
    exclusions: ["Git-ignored untracked files", "Septum state/database", "Files outside the workspace"], snapshot_guarantee: "sequential observations rechecked; not an atomic filesystem snapshot" };
  const response = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify({ ...value, basis }, null, 2) }] });
  if (args.action === "plan") {
    const effective = structuredClone(config);
    const feature = resolveEffectiveFeature(root, effective, args.feature_key);
    const fingerprint = policy(root, config, repo, feature);
    const before = capture(root, config);
    const changes: PlannedChange[] = [];
    const results: Evaluation[] = [];
    for (const proposed of args.changes!) {
      const file = pathInWorkspace(proposed.file_path, root, config);
      if (changes.some(change => change.file_path === file)) throw new Error(`Duplicate planned path '${file}'.`);
      if (!(file in before.index)) {
        const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", file], { cwd: root, timeout: 5000 });
        if (ignored.status !== 1) throw new Error(`Planned path '${file}' is ignored or ignore status cannot be checked.`);
      }
      if (proposed.operation === "delete" && !before.files[file]) throw new Error(`Cannot plan deletion of missing file '${file}'.`);
      const baselineImports = before.files[file] ? await imports(root, file) : [];
      changes.push({ ...proposed, file_path: file, baseline_imports: baselineImports });
      const result = await check(file, proposed.proposed_imports, feature);
      results.push({ ...result, file_path: file, proposed_imports: proposed.proposed_imports,
        impact: { ...repo.getFileInboundImpact(file), evidence: "indexed file dependents; partial, not runtime calls" } });
    }
    changes.sort((a, b) => a.file_path.localeCompare(b.file_path));
    if (digest(before) !== digest(capture(root, config)) || fingerprint !== policy(root, config, repo, feature)) {
      return response({ status: "unknown", reason: "inputs_changed", next: ["Retry plan after source/index/policy stabilizes."] });
    }
    const status = aggregate(results, false);
    const plan: Plan = { revision: REVISION, root, policy: fingerprint, feature, changes, baseline: before };
    const ref = digest(plan);
    if (status === "approved" && !args.dry_run) repo.setMeta(STORAGE_KEY, JSON.stringify({ ref, plan }));
    return response({ status, action: "plan", saved: status === "approved" && !args.dry_run, ...(status === "approved" ? { plan_ref: ref } : {}),
      baseline_id: digest(before), policy_id: fingerprint, baseline_path_count: Object.keys(before.files).length, results,
      next: [status === "approved" ? args.dry_run ? "Save the plan without dry_run before editing." : "Edit planned files, then verify using plan_ref." : "Resolve violations/uncertainty and run plan again."],
      approval_scope: "declared proposals only; no human approval or application correctness claim" });
  }
  const stored = repo.getMeta(STORAGE_KEY);
  let saved: { ref: string; plan: Plan } | null;
  try { saved = stored ? JSON.parse(stored) : null; }
  catch { return response({ status: "stale_plan", reason: "saved_plan_corrupt", next: ["Create a new saved plan; the stored baseline is unreadable."] }); }
  if (!saved?.plan || saved.ref !== args.plan_ref || digest(saved.plan) !== saved.ref || saved.plan.root !== root || saved.plan.revision !== REVISION) {
    return response({ status: "stale_plan", next: ["Create a new saved plan and copy its plan_ref."] });
  }
  const plan = saved.plan;
  if (policy(root, config, repo, plan.feature) !== plan.policy) return response({ status: "stale_plan", reason: "policy_or_session_changed", next: ["Review the effective scope and create a new plan."] });
  const before = capture(root, config);
  const changed = differences(plan.baseline.files, before.files);
  const indexChanges = differences(plan.baseline.index, before.index);
  // A staging-only delta is still an actual change even if worktree hashes match.
  const touched = [...new Set([...changed, ...indexChanges])].sort();
  const allowed = new Map(plan.changes.map(change => [change.file_path, change]));
  const outside = touched.filter(file => !allowed.has(file));
  const unexpectedDeletes = [...new Set([
    ...changed.filter(file => !before.files[file] && allowed.get(file)?.operation !== "delete"),
    ...indexChanges.filter(file => !before.index[file] && allowed.get(file)?.operation !== "delete"),
  ])].sort();
  const pendingDeletes = plan.changes.filter(change => change.operation === "delete" && before.files[change.file_path]).map(change => change.file_path);
  const results: Evaluation[] = [];
  const effective = structuredClone(config); resolveEffectiveFeature(root, effective, plan.feature);
  for (const file of changed) {
    const permitted = allowed.get(file);
    if (!before.files[file]) {
      const violations = plan.feature ? evaluator.checkFeatureTouchpoints(plan.feature, file, effective) : [];
      results.push({ file_path: file, status: violations.length ? "rejected" : "approved", violations, actual_imports: [] });
      continue;
    }
    const actual = await imports(root, file);
    const declared = new Set([...(permitted?.baseline_imports ?? []), ...(permitted?.proposed_imports ?? [])]);
    const undeclared = actual.filter(target => !declared.has(target));
    const result = await check(file, actual, plan.feature);
    results.push({ ...result, file_path: file, actual_imports: actual, undeclared_imports: undeclared,
      status: undeclared.length ? "rejected" : result.status });
  }
  // Config/target changes can affect callers whose own source did not change.
  // Reuse the architecture audit instead of certifying only the edited files.
  const workspaceAudit = await audit();
  if (digest(before) !== digest(capture(root, config)) || policy(root, config, repo, plan.feature) !== plan.policy || repo.getMeta(STORAGE_KEY) !== stored) {
    return response({ status: "unknown", reason: "inputs_changed", next: ["Retry verification after source/index/policy stabilizes."] });
  }
  const diverged = [...new Set([...Object.keys(before.files), ...Object.keys(before.index)])].sort().filter(file => {
    const version = before.files[file];
    return (version ? `${version.mode}:${version.git_hash}` : null) !== (before.index[file] ?? null);
  });
  return response({ status: aggregate([...results, workspaceAudit], Boolean(outside.length || unexpectedDeletes.length || pendingDeletes.length)), action: "verify", plan_ref: saved.ref,
    baseline_id: digest(plan.baseline), policy_id: plan.policy,
    changed_files: changed.map(file => ({ file_path: file, change: !before.files[file] ? "deleted" : !plan.baseline.files[file] ? "created" : "modified" })),
    outside_plan: outside, unexpected_deletes: unexpectedDeletes, pending_deletes: pendingDeletes, index_changes: indexChanges,
    worktree_index_differences: diverged, workspace_audit: workspaceAudit, results, next: ["Check scope='staged' before committing; this result covers worktree policy only.", "Run relevant application tests/typecheck/build."] });
}
