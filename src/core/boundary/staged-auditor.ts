import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ModuleResolver } from "../resolver/module-resolver.ts";
import type { BoundaryEvaluator } from "./evaluator.ts";
import { RESOURCE_LIMITS } from "../resources/limits.ts";
import { execFileSync } from "node:child_process";
import { resolve, relative, join } from "node:path";
import type { ImportResolution, BoundaryViolation } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import type { SeptumRepository } from "../database/repository.ts";

export async function auditStagedFiles(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  workspaceRoot: string,
  repo?: SeptumRepository
): Promise<{ files: string[]; violations: BoundaryViolation[]; resolution_issues: ImportResolution[] }> {
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
  // Freeze the index as a Git tree. Every source/config/target is read from this tree.
  const tree = execFileSync("git", ["write-tree"], { cwd: gitRoot, encoding: "utf8", timeout: 5000 }).trim();
  const snapshot = mkdtempSync(join(tmpdir(), "septum-staged-"));
  try {
    const entries = execFileSync("git", ["ls-tree", "-r", "-z", tree], { cwd: gitRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).split("\0").filter(Boolean);
    if (entries.length > 20000) throw new Error("Staged view exceeds file-count limit (20000).");
    let totalBytes = 0;
    const indexedPaths: string[] = [];
    for (const entry of entries) {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match || !["100644", "100755"].includes(match[1]!)) throw new Error("Cannot certify staged view containing symlinks or submodules.");
      const [, , oid, file] = match;
      const size = Number(execFileSync("git", ["cat-file", "-s", oid!], { cwd: gitRoot, encoding: "utf8", timeout: 5000 }));
      totalBytes += size;
      if (size > RESOURCE_LIMITS.sourceBytes || totalBytes > 128 * 1024 * 1024) throw new Error("Staged view exceeds resource limits.");
      const destination = resolve(snapshot, file!);
      if (!destination.startsWith(snapshot + "/")) throw new Error("Invalid staged path.");
      mkdirSync(resolve(destination, ".."), { recursive: true });
      writeFileSync(destination, execFileSync("git", ["cat-file", "blob", oid!], { cwd: gitRoot, timeout: 5000, maxBuffer: RESOURCE_LIMITS.sourceBytes + 1 }));
      indexedPaths.push(file!);
    }
    const rawPrefix = relative(gitRoot, workspaceRoot).replace(/\\/g, "/");
    const prefix = rawPrefix === "." ? "" : rawPrefix;
    const inside = (file: string) => !prefix || file === prefix || file.startsWith(prefix + "/");
    const hasHead = (() => { try { execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: gitRoot, stdio: "ignore" }); return true; } catch { return false; } })();
    const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], { cwd: gitRoot, input: "", encoding: "utf8" }).trim();
    const stagedPaths = (filter: string) => execFileSync("git", ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", `--diff-filter=${filter}`, "-z", hasHead ? "HEAD" : emptyTree, tree], {
      cwd: gitRoot, encoding: "utf-8", timeout: 5000, maxBuffer: 10 * 1024 * 1024,
    }).split("\0").filter(Boolean).map(f => f.replace(/\\/g, "/")).filter(inside);
    const files = stagedPaths("ACMR").map(file => (prefix ? relative(prefix, file) : file).replace(/\\/g, "/"));
    const deleted = stagedPaths("D").map(file => (prefix ? relative(prefix, file) : file).replace(/\\/g, "/"));
    const snapshotRoot = join(snapshot, prefix);
    evaluator = evaluator.withResolver(new ModuleResolver(snapshotRoot));
    const violations: BoundaryViolation[] = [];
    const resolutionIssues: ImportResolution[] = [];
    const stagedDependencies: ReturnType<SeptumRepository["getAllDependenciesWithDomains"]> = [];
    const parser = new ASTParserEngine();
    const interpretationChanged = [...files, ...deleted].some(file => /(?:\.(?:json|jsonc|toml)|(?:^|\/)(?:go\.mod|go\.work|Cargo\.lock))$/i.test(file));
    const changed = new Set(files);
    const sourceFiles = indexedPaths.filter(inside).map(file => (prefix ? relative(prefix, file) : file).replace(/\\/g, "/"));
    for (const file of sourceFiles) {
      if (!ASTParserEngine.isSourceFile(file) || !evaluator.resolveSourceDomain(file, config)) continue;
      const content = await Bun.file(resolve(snapshotRoot, file)).text();
      const parsed = await parser.parseFile(resolve(snapshotRoot, file), content);
      if (parsed.status === "unsupported" || parsed.status === "degraded") {
        throw new Error(`Cannot reliably parse staged file '${file}': ${parsed.status}.`);
      }
      for (const dependency of parsed.dependencies) {
        stagedDependencies.push({ source_file: file, source_domain: evaluator.resolveSourceDomain(file, config)!, target: dependency.target, statement: dependency.statement, line_number: dependency.line_number, is_external: dependency.is_external });
        const found = evaluator.checkProposedChanges(file, [dependency.target], config).map(violation => ({ ...violation, line: dependency.line_number }));
        const resolution = evaluator.getResolver().resolveImport(dependency.target,file);
        if (found.length === 0 && (!["resolved","external"].includes(resolution.status) || resolution.coverage === "conditional")) {
          resolutionIssues.push(resolution);
        }
        if (changed.has(file) || interpretationChanged) violations.push(...found);
      }
    }
    const staged = new Set([...files, ...deleted]);
    violations.push(...evaluator.detectCircularDependencies(config, stagedDependencies, interpretationChanged ? new Set(sourceFiles) : staged));
    return { files: Array.from(staged), violations, resolution_issues: resolutionIssues };
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}
