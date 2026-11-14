import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ModuleResolver } from "../resolver/module-resolver.ts";
import type { BoundaryEvaluator } from "./evaluator.ts";
import { RESOURCE_LIMITS } from "../resources/limits.ts";
import { execFileSync } from "node:child_process";
import { resolve, relative, join, dirname } from "node:path";
import type { ImportResolution, BoundaryViolation } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { PARSER_FINGERPRINT } from "../parser/language-capabilities.ts";

export async function auditStagedFiles(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  workspaceRoot: string,
  repo?: SeptumRepository
): Promise<{ files: string[]; violations: BoundaryViolation[]; resolution_issues: ImportResolution[] }> {
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
  // Freeze the index as a Git tree. Every source/config/target is read from this tree.
  const tree = execFileSync("git", ["write-tree"], { cwd: gitRoot, encoding: "utf8", timeout: 5000 }).trim();
  const scratch = mkdtempSync(join(tmpdir(), "septum-staged-"));
  const snapshot = join(scratch, "tree");
  try {
    mkdirSync(snapshot);
    const entries = execFileSync("git", ["ls-tree", "-r", "-l", "-z", tree], { cwd: gitRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).split("\0").filter(Boolean);
    if (entries.length > 20000) throw new Error("Staged view exceeds file-count limit (20000).");
    let totalBytes = 0;
    const indexedPaths: string[] = [];
    const blobs: Array<{ oid: string; file: string; size: number }> = [];
    for (const entry of entries) {
      const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);
      if (!match || !["100644", "100755"].includes(match[1]!)) throw new Error("Cannot certify staged view containing symlinks or submodules.");
      const [, , oid, sizeText, file] = match;
      // Only source and interpretation inputs need bytes in the parser snapshot.
      // Keep the complete path inventory so omitted assets cannot masquerade as source.
      indexedPaths.push(file!);
      const needed = ASTParserEngine.isSourceFile(file!) || /\.(?:json|jsonc|toml|ya?ml)$/i.test(file!) || /(?:^|\/)(?:go\.mod|go\.work|Cargo\.lock|artisan|requirements\.txt)$/.test(file!);
      if (!needed) continue;
      const size = Number(sizeText);
      totalBytes += size;
      if (size > RESOURCE_LIMITS.sourceBytes || totalBytes > 128 * 1024 * 1024) throw new Error("Staged view exceeds resource limits.");
      const destination = resolve(snapshot, file!);
      if (!destination.startsWith(snapshot + "/")) throw new Error("Invalid staged path.");
      blobs.push({ oid: oid!, file: file!, size });
    }
    // One raw-blob process, spooled to disk to bound JS memory. checkout-index
    // applies smudge/EOL/encoding filters; archive applies export attributes.
    // Neither is a faithful raw index snapshot for parsing and resolution.
    const batchPath = join(scratch, "blobs");
    const fd = openSync(batchPath, "w");
    try {
      execFileSync("git", ["cat-file", "--batch"], { cwd: gitRoot, timeout: 30000,
        input: blobs.map(blob => blob.oid + "\n").join(""), stdio: ["pipe", fd, "pipe"] });
    } finally { closeSync(fd); }
    const batch = Bun.file(batchPath);
    let offset = 0;
    for (const { oid, file, size } of blobs) {
      const header = `${oid} blob ${size}\n`;
      const length = header.length + size + 1;
      const record = Buffer.from(await batch.slice(offset, offset + length).arrayBuffer());
      if (record.length !== length || record.subarray(0, header.length).toString() !== header || record[length - 1] !== 10) {
        throw new Error("Invalid staged blob batch.");
      }
      const destination = resolve(snapshot, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, record.subarray(header.length, length - 1));
      offset += length;
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
      const existing = repo?.getFileByPath(file);
      const reusable = !changed.has(file) && !interpretationChanged &&
        repo?.getMeta("sync_state") === "complete" && repo.getMeta("parser_revision") === PARSER_FINGERPRINT &&
        existing?.content_hash === computeContentHash(content);
      const dependencies = reusable ? repo!.getDependenciesByFileId(existing!.id) : await (async () => {
        const parsed = await parser.parseFile(resolve(snapshotRoot, file), content);
        if (parsed.status === "unsupported" || parsed.status === "degraded") {
          throw new Error(`Cannot reliably parse staged file '${file}': ${parsed.status}.`);
        }
        return parsed.dependencies;
      })();
      for (const dependency of dependencies) {
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
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
