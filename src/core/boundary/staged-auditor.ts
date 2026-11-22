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
import { isResolutionInput } from "../resolver/interpretation-inputs.ts";

export async function auditStagedFiles(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  workspaceRoot: string,
  repo?: SeptumRepository
): Promise<{
  files: string[];
  violations: BoundaryViolation[];
  resolution_issues: ImportResolution[];
  background_resolution_issues_count: number;
}> {
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
  // Freeze the index as a Git tree. Every source/config/target is read from this tree.
  const tree = execFileSync("git", ["write-tree"], { cwd: gitRoot, encoding: "utf8", timeout: 5000 }).trim();
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
  if (files.length === 0 && deleted.length === 0) {
    return { files: [], violations: [], resolution_issues: [], background_resolution_issues_count: 0 };
  }

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
      const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const [, mode, oid, sizeText, file] = match;
      // Only source and interpretation inputs need bytes in the parser snapshot.
      // Keep the complete path inventory so omitted assets cannot masquerade as source.
      indexedPaths.push(file!);
      const needed = ASTParserEngine.isSourceFile(file!) || isResolutionInput(file!);
      if (!needed) continue;
      if (!["100644", "100755"].includes(mode!)) throw new Error("Cannot certify staged view containing symlinks or submodules.");
      const size = Number(sizeText);
      totalBytes += size;
      if (size > RESOURCE_LIMITS.sourceBytes || totalBytes > 128 * 1024 * 1024) throw new Error("Staged view exceeds resource limits.");
      const destination = resolve(snapshot, file!);
      if (!destination.startsWith(snapshot + "/")) throw new Error("Invalid staged path.");
      blobs.push({ oid: oid!, file: file!, size });
    }
    const parser = new ASTParserEngine();
    const interpretationChanged = [...files, ...deleted].some(isResolutionInput);
    const changed = new Set(files);
    const canUseFastPath =
      !interpretationChanged &&
      repo?.getMeta("sync_state") === "complete" &&
      repo.getMeta("parser_revision") === PARSER_FINGERPRINT;

    const indexedFileSet = canUseFastPath
      ? new Set(repo!.getAllFiles().map(f => f.path))
      : undefined;
    const unstagedModified = canUseFastPath
      ? new Set(
          execFileSync("git", ["diff-files", "--name-only", "-z"], {
            cwd: gitRoot,
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 10 * 1024 * 1024,
          })
            .split("\0")
            .filter(Boolean)
            .map(f => f.replace(/\\/g, "/"))
            .filter(inside)
            .map(f => (prefix ? relative(prefix, f) : f).replace(/\\/g, "/"))
        )
      : undefined;

    const blobsToFetch: Array<{ oid: string; file: string; size: number }> = [];
    const placeholderFiles: string[] = [];
    for (const blob of blobs) {
      const relFile = (prefix ? relative(prefix, blob.file) : blob.file).replace(/\\/g, "/");
      const needsBytes =
        !canUseFastPath ||
        changed.has(relFile) ||
        isResolutionInput(blob.file) ||
        isResolutionInput(relFile) ||
        !indexedFileSet!.has(relFile) ||
        unstagedModified!.has(relFile);
      if (needsBytes) {
        blobsToFetch.push(blob);
      } else {
        placeholderFiles.push(blob.file);
      }
    }

    for (const file of placeholderFiles) {
      const destination = resolve(snapshot, file);
      mkdirSync(dirname(destination), { recursive: true });
      closeSync(openSync(destination, "w"));
    }

    if (blobsToFetch.length > 0) {
      // One raw-blob process, spooled to disk to bound JS memory. checkout-index
      // applies smudge/EOL/encoding filters; archive applies export attributes.
      // Neither is a faithful raw index snapshot for parsing and resolution.
      const batchPath = join(scratch, "blobs");
      const fd = openSync(batchPath, "w");
      try {
        execFileSync("git", ["cat-file", "--batch"], { cwd: gitRoot, timeout: 30000,
          input: blobsToFetch.map(blob => blob.oid + "\n").join(""), stdio: ["pipe", fd, "pipe"] });
      } finally { closeSync(fd); }
      const batch = Bun.file(batchPath);
      let offset = 0;
      for (const { oid, file, size } of blobsToFetch) {
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
    }
    const snapshotRoot = join(snapshot, prefix);
    evaluator = evaluator.withResolver(new ModuleResolver(snapshotRoot));
    const violations: BoundaryViolation[] = [];
    const resolutionIssues: ImportResolution[] = [];
    let backgroundResolutionIssuesCount = 0;
    const stagedDependencies: ReturnType<SeptumRepository["getAllDependenciesWithDomains"]> = [];
    const sourceFiles = indexedPaths.filter(inside).map(file => (prefix ? relative(prefix, file) : file).replace(/\\/g, "/"));
    const repoDepsByFile = canUseFastPath
      ? (() => {
          const map = new Map<string, ReturnType<SeptumRepository["getAllDependenciesWithDomains"]>>();
          for (const dep of repo!.getAllDependenciesWithDomains()) {
            const list = map.get(dep.source_file) ?? [];
            list.push(dep);
            map.set(dep.source_file, list);
          }
          return map;
        })()
      : undefined;

    for (const file of sourceFiles) {
      const sourceDomain = evaluator.resolveSourceDomain(file, config);
      if (!ASTParserEngine.isSourceFile(file) || !sourceDomain) continue;
      let dependencies: Array<{ target: string; statement: string; line_number: number; is_external: boolean }>;
      if (canUseFastPath && !changed.has(file) && indexedFileSet!.has(file) && !unstagedModified!.has(file)) {
        dependencies = repoDepsByFile!.get(file) ?? [];
      } else {
        const content = await Bun.file(resolve(snapshotRoot, file)).text();
        const existing = repo?.getFileByPath(file);
        const reusable = !changed.has(file) && !interpretationChanged &&
          repo?.getMeta("sync_state") === "complete" && repo.getMeta("parser_revision") === PARSER_FINGERPRINT &&
          existing?.content_hash === computeContentHash(content);
        dependencies = reusable ? repo!.getDependenciesByFileId(existing!.id) : await (async () => {
          const parsed = await parser.parseFile(resolve(snapshotRoot, file), content);
          if (parsed.status === "unsupported" || parsed.status === "degraded") {
            throw new Error(`Cannot reliably parse staged file '${file}': ${parsed.status}.`);
          }
          return parsed.dependencies;
        })();
      }
      for (const dependency of dependencies) {
        stagedDependencies.push({ source_file: file, source_domain: sourceDomain, target: dependency.target, statement: dependency.statement, line_number: dependency.line_number, is_external: dependency.is_external });
        const isRelevantFile = changed.has(file) || interpretationChanged;
        const resolution = evaluator.getResolver().resolveImport(dependency.target, file, dependency.statement);
        const needsViolationCheck = isRelevantFile || !["resolved", "external"].includes(resolution.status) || resolution.coverage === "conditional";
        const found = needsViolationCheck
          ? evaluator.checkProposedChanges(file, [dependency.target], config, [dependency.statement]).map(violation => ({ ...violation, line: dependency.line_number }))
          : [];
        if (found.length === 0 && (!["resolved","external"].includes(resolution.status) || resolution.coverage === "conditional")) {
          if (isRelevantFile) {
            resolutionIssues.push(resolution);
          } else {
            backgroundResolutionIssuesCount++;
          }
        }
        if (isRelevantFile) violations.push(...found);
      }
    }
    const staged = new Set([...files, ...deleted]);
    violations.push(...evaluator.detectCircularDependencies(config, stagedDependencies, interpretationChanged ? new Set(sourceFiles) : staged));
    return {
      files: Array.from(staged),
      violations,
      resolution_issues: resolutionIssues,
      background_resolution_issues_count: backgroundResolutionIssuesCount,
    };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
