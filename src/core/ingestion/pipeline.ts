import { scanSourceFiles, type SourceInventory } from "../resources/source-inventory.ts";
import { rebuildSliceCatalog } from "../resolver/slice-catalog.ts";
import { SEMANTIC_FINGERPRINT } from "../parser/semantic-revision.ts";
import { RESOLVER_REVISION } from "../resolver/import-resolver.ts";
import { sourceObservationsCurrent } from "../resources/source-files.ts";
import { shouldIgnoreSourcePath } from "../resources/ignore.ts";
import { RESOURCE_LIMITS } from "../resources/limits.ts";
import { readSourceFile, SourceFileLimitError, type SkippedSourceFile, type SourceReadFingerprint } from "../resources/source-files.ts";
import { existsSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isPathContained, resolveWorkspaceRoot } from "../resolver/path-resolver.ts";
import type { ArchetypeKind, ParsedFileAST } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { detectArchetype } from "../parser/extractors/base.ts";
import { TopologyDetector } from "../discovery/topology-detector.ts";
import { PARSER_FINGERPRINT } from "../parser/language-capabilities.ts";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import { ModuleResolver } from "../resolver/module-resolver.ts";
import { computeContentHash } from "./hasher.ts";
import { assertUniqueDomainRoots, domainNameKey, DomainRootConflictError } from "../config/domain-ownership.ts";
import { ConfigLoader } from "../config/loader.ts";
import { SeptumTelemetry } from "../telemetry/telemetry.ts";

export type IngestionProgressEvent =
  | { phase: "scanning"; status: "start" | "done"; total: number }
  | { phase: "parsing"; status: "progress" | "done"; processed: number; total: number }
  | { phase: "resolving"; status: "done"; symbols: number; dependencies: number }
  | { phase: "linking"; status: "start" | "done"; slices: number };

export interface IngestionMetrics {
  domains_processed: number;
  files_scanned: number;
  files_updated: number;
  files_skipped: number;
  symbols_indexed: number;
  dependencies_indexed: number;
  /** Indexed-file parse attempts across this sync, including recovered retries; excludes semantic extraction. */
  parser_invocations: number;
  duration_ms: number;
  stage_timings_ms?: {
    scan_ms: number;
    parse_ms: number;
    commit_ms: number;
    slice_ms: number;
  };
}

export class IngestionPipeline {
  // Only trust metadata already content-verified by this pipeline instance.
  // ctime catches edits which deliberately preserve size and mtime.
  private verifiedFiles = new Map<string, { ctime: number; hash: string }>();
  private repo: SeptumRepository;
  private parserEngine: ASTParserEngine;
  private customWorkspaceRoot?: string;

  constructor(repo: SeptumRepository, workspaceRoot?: string) {
    this.repo = repo;
    this.parserEngine = new ASTParserEngine();
    if (workspaceRoot) {
      this.customWorkspaceRoot = resolve(workspaceRoot);
    }
  }

  public async run(
    config: ValidatedSeptumConfig,
    options: {
      verifyContent?: boolean;
      rebuild?: boolean;
      signal?: AbortSignal;
      onProgress?: (info: IngestionProgressEvent) => void;
    } = {}
  ): Promise<IngestionMetrics> {
    const workspaceRoot = this.resolveWorkspaceRoot(config, Object.values(config.domains)[0]?.root ?? ".");
    this.repo.setMeta("workspace_root", workspaceRoot);
    this.repo.setMeta("settings_json", JSON.stringify(config.settings));
    this.repo.setMeta("resolver_revision", RESOLVER_REVISION);
    this.repo.setMeta("sync_state", "running");
    const work = { parserInvocations: 0 };
    try {
      let result: IngestionMetrics | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { result = await this.runSync(config, options, work); break; }
        catch (error) {
          if (attempt || !(error instanceof Error) || !error.message.startsWith("Source changed during synchronization:")) throw error;
          options.signal?.throwIfAborted();
        }
      }
      this.repo.setMeta("sync_state", "complete");
      this.repo.setMeta("sync_error", "");
      this.repo.setMeta("sync_error_code", "");
      SeptumTelemetry.recordSystemEvent({
        level: "INFO",
        component: "ingestion",
        event: "ingestion_completed",
        fields: {
          state_previous: "running",
          state_current: "complete",
          files_scanned: result!.files_scanned,
          files_updated: result!.files_updated,
          files_skipped: result!.files_skipped,
          parser_invocations: result!.parser_invocations,
          duration_ms: result!.duration_ms,
          ...(result!.stage_timings_ms ?? {}),
        },
        workspaceRoot,
        emitStderr: false,
      });
      return result!;
    } catch (error) {
      this.recordSyncFailure(error);
      SeptumTelemetry.recordSystemEvent({
        level: "ERROR",
        component: "ingestion",
        event: "ingestion_failed",
        fields: {
          state_previous: "running",
          state_current: "error",
          error_code: error instanceof DomainRootConflictError ? error.code : undefined,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 256),
        },
        workspaceRoot,
        emitStderr: false,
      });
      throw error;
    }
  }

  private async runSync(
    config: ValidatedSeptumConfig,
    options: {
      verifyContent?: boolean;
      rebuild?: boolean;
      signal?: AbortSignal;
      onProgress?: (info: IngestionProgressEvent) => void;
    },
    work: { parserInvocations: number }
  ): Promise<IngestionMetrics> {
    const startTime = performance.now();
    let scanMs = 0;
    let parseMs = 0;
    let commitMs = 0;
    let sliceMs = 0;
    let filesScanned = 0;
    let filesUpdated = 0;
    let filesSkipped = 0;
    let symbolsIndexed = 0;
    let dependenciesIndexed = 0;
    const unsupportedFiles: string[] = [];
    const skippedFiles: SkippedSourceFile[] = [];
    const ingestedFullPaths = new Set<string>();
    let removedFiles = 0;

    let domainNames = Object.keys(config.domains);
    const hasExplicitDomains = domainNames.length > 0;
    const projectRoot = this.customWorkspaceRoot || resolveWorkspaceRoot();

    // Existing SQLite ownership precedes inference when the caller omits domains.
    if (domainNames.length === 0) {
      const discovered = this.repo.getAllDomains().length
        ? ConfigLoader.loadFromRepository(this.repo).domains : this.autoDiscoverDomains(projectRoot);
      for (const [dName, dCfg] of Object.entries(discovered)) {
        config.domains[dName] = {
          root: dCfg.root,
          description: dCfg.description,
          allowed_dependencies: dCfg.allowed_dependencies || [],
          forbidden_dependencies: dCfg.forbidden_dependencies || [],
          archetypes: dCfg.archetypes || {},
        };
      }
      domainNames = Object.keys(config.domains);
    }
    this.assertDomainOwnership(config, projectRoot);
    if (hasExplicitDomains) {
      const pruned = this.repo.pruneDomainsNotIn(domainNames);
      if (pruned.prunedDomains > 0) {
        removedFiles += pruned.removedFiles;
        this.repo.setMeta("slices_dirty", "1");
      }
    }
    this.ensureParserFingerprint(options.rebuild);
    options.onProgress?.({ phase: "scanning", status: "start", total: 0 });
    const scanStart = performance.now();
    const initialScan = scanSourceFiles(projectRoot, { ignorePatterns: config.settings.ignore_patterns, signal: options.signal });
    const initialStats = new Map<string, Stats>();
    const initialEntries: Array<{ fullPath: string; relPath: string }> = [];
    const inventory = initialScan.files.map(fullPath => {
      const relPath = relative(projectRoot, fullPath).replace(/\\/g, "/");
      const stat = statSync(fullPath);
      initialStats.set(fullPath, stat);
      initialEntries.push({ fullPath, relPath });
      return `${relPath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    }).sort();
    scanMs += performance.now() - scanStart;
    const totalEstimatedFiles = initialEntries.length;
    options.onProgress?.({ phase: "scanning", status: "done", total: totalEstimatedFiles });
    const batchFilesLimit = options.rebuild && totalEstimatedFiles >= 500 ? 250 : RESOURCE_LIMITS.batchFiles;
    const batchBytesLimit = options.rebuild && totalEstimatedFiles >= 500 ? 4 * 1024 * 1024 : RESOURCE_LIMITS.batchBytes;

    const existingFilesMap = new Map<string, import("../../types/index.ts").FileRecord>();
    for (const f of this.repo.getAllFiles()) {
      existingFilesMap.set(f.path, f);
    }

    // Single-pass O(F * depth) longest-prefix domain partitioning for projectRoot domains
    const prefixToDomain = new Map<string, string>();
    for (const domainName of domainNames) {
      const domainCfg = config.domains[domainName];
      const wsRoot = this.resolveWorkspaceRoot(config, domainCfg.root);
      if (wsRoot !== projectRoot || !isPathContained(domainCfg.root, wsRoot)) continue;
      const relPrefix = relative(wsRoot, resolve(wsRoot, domainCfg.root)).replace(/\\/g, "/");
      prefixToDomain.set(relPrefix, domainName);
    }
    const entriesByDomain = new Map<string, Array<{ fullPath: string; relPath: string }>>();
    for (const entry of initialEntries) {
      let owner: string | undefined = prefixToDomain.get(entry.relPath);
      if (!owner) {
        let dir = entry.relPath;
        while (true) {
          const slash = dir.lastIndexOf("/");
          if (slash === -1) {
            owner = prefixToDomain.get("");
            break;
          }
          dir = dir.slice(0, slash);
          owner = prefixToDomain.get(dir);
          if (owner) break;
        }
      }
      if (owner) {
        let bucket = entriesByDomain.get(owner);
        if (!bucket) {
          bucket = [];
          entriesByDomain.set(owner, bucket);
        }
        bucket.push(entry);
      }
    }

    for (const domainName of domainNames) {
      const domainCfg = config.domains[domainName];
      const domainId = this.repo.upsertDomain(domainName, domainCfg);
      const workspaceRoot = this.resolveWorkspaceRoot(config, domainCfg.root);
      // SV-02: Enforce workspace containment during ingestion (reject traversal/symlink escape)
      if (!isPathContained(domainCfg.root, workspaceRoot)) {
        throw new Error(`Domain root '${domainCfg.root}' for domain '${domainName}' escapes workspace boundary '${workspaceRoot}'.`);
      }
      const absDomainRoot = resolve(workspaceRoot, domainCfg.root);

      try {
        const rootStat = statSync(absDomainRoot);
        if (!rootStat.isDirectory()) {
          throw new Error(`Domain root '${domainCfg.root}' is not a directory.`);
        }
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          removedFiles += this.repo.getAllFiles().filter(file => file.domain_id === domainId).length;
          this.repo.files.deleteFilesNotInPaths(domainId, []);
          if (removedFiles) this.repo.setMeta("slices_dirty", "1");
          continue;
        }
        // SV-01: Permission or I/O failure (EACCES, EPERM, EIO). Do NOT prune, propagate error!
        throw new Error(`Failed to access domain root '${domainCfg.root}' for domain '${domainName}': ${err.message || err}`);
      }

      const collectedFiles = workspaceRoot === projectRoot
        ? (entriesByDomain.get(domainName) ?? [])
        : this.collectFiles(
            absDomainRoot,
            workspaceRoot,
            config.settings.ignore_patterns,
            domainNames
              .filter(name => name !== domainName)
              .map(name => relative(workspaceRoot, resolve(workspaceRoot, config.domains[name].root)).replace(/\\/g, "/"))
              .filter(child => {
                const fromParent = relative(absDomainRoot, resolve(workspaceRoot, child)).replace(/\\/g, "/");
                return fromParent !== "" && fromParent !== ".." && !fromParent.startsWith("../") && !isAbsolute(fromParent);
              }),
            options.signal
          );
      const activeRelPaths = new Set<string>();

      const pendingMetadataUpdates: Array<{
        id: number;
        mtimeMs: number;
        sizeBytes: number;
        file: import("../../types/index.ts").FileRecord;
        archetype: ReturnType<typeof detectArchetype>;
      }> = [];

      const pendingUpdates: Array<{
        fullPath: string;
        relPath: string;
        contentHash: string;
        lineCount: number;
        archetype: ReturnType<typeof detectArchetype>;
        mtimeMs: number;
        ctimeMs: number;
        sizeBytes: number;
        ino: number;
        ast: ParsedFileAST;
      }> = [];

      let batchBytes = 0;
      const commitBatch = () => {
        for (const item of pendingUpdates) {
          let changed = false;
          try {
            const s = statSync(item.fullPath);
            if (s.size !== item.sizeBytes || s.mtimeMs !== item.mtimeMs || s.ctimeMs !== item.ctimeMs || s.ino !== item.ino) {
              changed = true;
            }
          } catch (error: any) {
            if (error?.code === "ENOENT") {
              throw new Error(`Source changed during synchronization: '${item.relPath}'. Run sync again after the file stops changing.`);
            }
            throw error;
          }
          if (changed) {
            let currentHash: string | undefined;
            try { currentHash = existsSync(item.fullPath) ? computeContentHash(readSourceFile(item.fullPath)) : undefined; }
            catch (error: any) {
              if (error?.code !== "ENOENT") throw error;
            }
            if (currentHash !== item.contentHash) {
              throw new Error(`Source changed during synchronization: '${item.relPath}'. Run sync again after the file stops changing.`);
            }
          }
        }
        const commitStart = performance.now();
        this.repo.runInTransaction(() => {
          for (const meta of pendingMetadataUpdates) {
            if (meta.file.archetype !== meta.archetype) {
              this.repo.upsertFile(domainId, meta.file.path, meta.archetype, meta.file.content_hash, meta.file.line_count, meta.mtimeMs, meta.sizeBytes);
              this.repo.setMeta("slices_dirty", "1");
            } else this.repo.updateFileMetadataOnly(meta.id, meta.mtimeMs, meta.sizeBytes);
          }

          for (const item of pendingUpdates) {
            this.publishParsedFile(domainId, item, false);

            symbolsIndexed += item.ast.symbols.length;
            dependenciesIndexed += item.ast.dependencies.length;
          }
          if (pendingUpdates.length > 0) {
            this.repo.setMeta("slices_dirty", "1");
          }

        });
        commitMs += performance.now() - commitStart;
        pendingUpdates.length = 0;
        pendingMetadataUpdates.length = 0;
        batchBytes = 0;
      };

      for (const { fullPath, relPath } of collectedFiles) {
        options.signal?.throwIfAborted();
        if (pendingMetadataUpdates.length >= batchFilesLimit) commitBatch();
        filesScanned++;
        if (filesScanned % RESOURCE_LIMITS.batchFiles === 0) {
          options.onProgress?.({ phase: "parsing", status: "progress", processed: filesScanned, total: totalEstimatedFiles });
          await new Promise<void>(done => setTimeout(done, 0));
          options.signal?.throwIfAborted();
        }
        activeRelPaths.add(relPath);

        let stat = initialStats.get(fullPath);
        if (!stat) {
          try {
            stat = statSync(fullPath);
          } catch (error: any) {
            if (error?.code === "ENOENT") continue;
            throw new Error(`Failed to inspect source '${relPath}': ${error?.message || error}`);
          }
        }

        const mtimeMs = stat.mtimeMs;
        const sizeBytes = stat.size;
        const existingFile = existingFilesMap.get(relPath);

        const archetype = detectArchetype(relPath, domainCfg.archetypes ?? {});
        if (sizeBytes > RESOURCE_LIMITS.sourceBytes) {
          skippedFiles.push({path: relPath, reason: "file_too_large"});
          if (existingFile) removedFiles++;
          this.repo.deleteFileByPath(relPath);
          this.repo.setMeta("slices_dirty", "1");
          continue;
        }
        // Fast sync trusts metadata; explicit verification and rebuilds read bytes.
        if (!options.verifyContent && !options.rebuild && existingFile &&
            existingFile.domain_id === domainId && existingFile.mtime_ms === mtimeMs &&
            existingFile.size_bytes === sizeBytes && existingFile.archetype === archetype &&
            this.verifiedFiles.get(relPath)?.ctime === stat.ctimeMs &&
            this.verifiedFiles.get(relPath)?.hash === existingFile.content_hash) {
          filesSkipped++;
          continue;
        }
        if (pendingUpdates.length >= batchFilesLimit || (batchBytes + sizeBytes > batchBytesLimit && pendingUpdates.length > 0)) { commitBatch(); await new Promise<void>(done => setTimeout(done, 0)); options.signal?.throwIfAborted(); }
        let content: string;
        try { content = readSourceFile(fullPath); }
        catch (error) {
          if (!(error instanceof SourceFileLimitError)) throw error;
          skippedFiles.push({path: relPath, reason: "file_too_large"});
          if (existingFile) removedFiles++;
          this.repo.deleteFileByPath(relPath);
          this.repo.setMeta("slices_dirty", "1");
          continue;
        }
        const currentHash = computeContentHash(content);
        this.verifiedFiles.set(relPath, { ctime: stat.ctimeMs, hash: currentHash });

        if (
          existingFile &&
          existingFile.domain_id === domainId &&
          existingFile.content_hash === currentHash
        ) {
          // Content identical despite mtime bump (e.g. touch) - queue metadata update for batch transaction
          if (existingFile.mtime_ms !== mtimeMs || existingFile.size_bytes !== sizeBytes || existingFile.archetype !== archetype) {
            pendingMetadataUpdates.push({ id: existingFile.id, mtimeMs, sizeBytes, file: existingFile, archetype });
          }
          filesSkipped++;
          continue;
        }

        const lineCount = content.split("\n").length;
        ingestedFullPaths.add(fullPath);
        work.parserInvocations++;
        const parseStart = performance.now();
        const ast = await this.parserEngine.parseFile(fullPath, content);
        parseMs += performance.now() - parseStart;
        if (ast.status === "unsupported" || ast.status === "degraded") {
          unsupportedFiles.push(relPath);
          if (existingFile) removedFiles++;
          this.repo.deleteFileByPath(relPath);
          this.repo.setMeta("slices_dirty", "1");
          if (ast.status === "degraded") {
            SeptumTelemetry.recordSystemEvent({
              level: "WARN",
              component: "ingestion",
              event: "parser_degraded_isolated",
              fields: {
                file: relPath,
                diagnostics: ast.diagnostics?.map(d => `${d.code}: ${d.message}`).join("; ").slice(0, 200),
              },
              workspaceRoot: projectRoot,
              emitStderr: false,
            });
          }
          continue;
        }

        filesUpdated++;
        batchBytes += sizeBytes;
        pendingUpdates.push({
          fullPath,
          relPath,
          contentHash: currentHash,
          lineCount,
          archetype,
          mtimeMs,
          ctimeMs: stat.ctimeMs,
          sizeBytes,
          ino: stat.ino,
          ast,
        });
      }

      commitBatch();
      this.repo.runInTransaction(() => {
        // State Reconciliation: Prune deleted files from DB using pre-loaded existingFilesMap
        for (const [existingPath, existingRecord] of existingFilesMap.entries()) {
          if (existingRecord.domain_id === domainId && !activeRelPaths.has(existingPath)) {
            removedFiles++;
            this.removeIndexedFile(existingPath);
            existingFilesMap.delete(existingPath);
          }
        }
      });
    }

    options.onProgress?.({ phase: "parsing", status: "done", processed: filesScanned, total: totalEstimatedFiles });
    options.onProgress?.({ phase: "resolving", status: "done", symbols: symbolsIndexed, dependencies: dependenciesIndexed });

    options.signal?.throwIfAborted();
    const topologyInputs = ["package.json", "composer.json", "nest-cli.json", "go.mod", "artisan", "tsconfig.json"]
      .map(file => { const target = join(projectRoot, file); return existsSync(target) ? readSourceFile(target) : ""; });
    const semanticRevision = computeContentHash(JSON.stringify([config.domains, topologyInputs]));
    // Membership covers newly added semantic files outside registered domains.
    const inventoryRevision = computeContentHash(JSON.stringify(inventory));
    const priorInputs: SourceReadFingerprint[] = JSON.parse(this.repo.getMeta("semantic_inputs") || "[]");
    let semanticInputChanged = !sourceObservationsCurrent(projectRoot, JSON.parse(this.repo.getMeta("semantic_observations") || '{"paths":[],"directories":[]}'));
    for (let index = 0; index < priorInputs.length && !semanticInputChanged; index++) {
      if (index % RESOURCE_LIMITS.batchFiles === 0) { await new Promise<void>(done => setTimeout(done, 0)); options.signal?.throwIfAborted(); }
      const input = priorInputs[index];
      const file = resolve(projectRoot, input.path);
      if (!existsSync(file)) { semanticInputChanged = true; break; }
      const stat = statSync(file);
      if (stat.size !== input.size || stat.mtimeMs !== input.mtime) { semanticInputChanged = true; break; }
      if (!options.verifyContent) continue;
      try { semanticInputChanged = computeContentHash(readSourceFile(file)) !== input.hash; }
      catch (error) { if (error instanceof SourceFileLimitError) semanticInputChanged = input.hash !== "file_too_large"; else throw error; }
      if (semanticInputChanged) break;
    }
    const extractorRevision = SEMANTIC_FINGERPRINT;
    options.onProgress?.({ phase: "linking", status: "start", slices: 0 });
    const sliceStart = performance.now();
    if (this.repo.getMeta("semantic_extractor_revision") !== extractorRevision || this.repo.getMeta("semantic_inventory") !== inventoryRevision || semanticInputChanged || filesUpdated > 0 || removedFiles > 0 || this.repo.getMeta("slices_dirty") === "1" || this.repo.getMeta("semantic_revision") !== semanticRevision) {
      await rebuildSliceCatalog(this.repo, projectRoot, {
        ignorePatterns: config.settings.ignore_patterns, signal: options.signal,
        semanticRevision, inventoryRevision, inventory: initialScan,
      });
    }
    sliceMs += performance.now() - sliceStart;
    options.onProgress?.({ phase: "linking", status: "done", slices: this.repo.countVerticalSlices() });

    skippedFiles.push(...JSON.parse(this.repo.getMeta("semantic_skipped_files") || "[]"));
    const endScan = scanSourceFiles(projectRoot, { ignorePatterns: config.settings.ignore_patterns, signal: options.signal });
    if (endScan.files.length !== initialStats.size || endScan.files.some(fullPath => !initialStats.has(fullPath))) {
      throw new Error("Source changed during synchronization: workspace inventory changed. Run sync again after the files stop changing.");
    }
    for (const fullPath of ingestedFullPaths) {
      const initialStat = initialStats.get(fullPath);
      if (!initialStat) continue;
      let endStat: Stats;
      try {
        endStat = statSync(fullPath);
      } catch {
        throw new Error("Source changed during synchronization: workspace inventory changed. Run sync again after the files stop changing.");
      }
      if (
        endStat.size !== initialStat.size ||
        endStat.mtimeMs !== initialStat.mtimeMs ||
        endStat.ctimeMs !== initialStat.ctimeMs ||
        endStat.ino !== initialStat.ino
      ) {
        throw new Error("Source changed during synchronization: workspace inventory changed. Run sync again after the files stop changing.");
      }
    }
    const durationMs = Math.round(performance.now() - startTime);

    // Identify uncovered eligible source files outside registered domains
    const indexedPaths = new Set(this.repo.getAllFiles().map((file) => file.path));
    for (const path of this.verifiedFiles.keys()) if (!indexedPaths.has(path)) this.verifiedFiles.delete(path);
    const unsupportedSet = new Set(unsupportedFiles);
    const skippedSet = new Set(skippedFiles.map((file) => file.path));
    const uncoveredFiles = initialEntries
      .map((entry) => entry.relPath)
      .filter((rel) => !indexedPaths.has(rel) && !unsupportedSet.has(rel) && !skippedSet.has(rel));

    // Update SSOT repo_meta watermark
    this.repo.runInTransaction(() => {
      this.repo.setMeta("last_sync", new Date().toISOString());
      this.repo.setMeta("sync_duration_ms", String(durationMs));
      this.repo.setMeta("files_scanned", String(filesScanned));
      this.repo.setMeta("files_updated", String(filesUpdated));
      this.repo.setMeta("symbols_indexed", String(symbolsIndexed));
      this.repo.setMeta("dependencies_indexed", String(dependenciesIndexed));
      this.repo.setMeta("unsupported_files", JSON.stringify(unsupportedFiles));
      this.repo.setMeta("skipped_files", JSON.stringify([...new Map(skippedFiles.map(file => [file.path, file])).values()]));
      this.repo.setMeta("uncovered_files", JSON.stringify(uncoveredFiles));
    });

    this.repo.checkpoint();

    return {
      domains_processed: domainNames.length,
      files_scanned: filesScanned,
      files_updated: filesUpdated,
      files_skipped: filesSkipped,
      symbols_indexed: symbolsIndexed,
      dependencies_indexed: dependenciesIndexed,
      parser_invocations: work.parserInvocations,
      duration_ms: durationMs,
      stage_timings_ms: {
        scan_ms: Math.round(scanMs),
        parse_ms: Math.round(parseMs),
        commit_ms: Math.round(commitMs),
        slice_ms: Math.round(sliceMs),
      },
    };
  }

  public autoDiscoverDomains(projectRoot: string): Record<string, import("../../types/index.ts").DomainConfig> {
    return TopologyDetector.detect(projectRoot).domains;
  }

  private sourceInventory(root: string, ignorePatterns: string[], signal?: AbortSignal): string[] {
    return this.collectFiles(root, root, ignorePatterns, [], signal).map(({fullPath, relPath}) => {
      const stat = statSync(fullPath);
      // Guard membership and concurrent writes without rereading every source.
      // Content checks belong to indexed files and semantic-input verification.
      return `${relPath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    }).sort();
  }

  private collectFiles(
    dir: string,
    workspaceRoot: string,
    ignorePatterns: string[],
    childDomainRoots: string[] = [],
    signal?: AbortSignal
  ): Array<{ fullPath: string; relPath: string }> {
    return scanSourceFiles(workspaceRoot, { directory: dir, ignorePatterns, excludeRoots: childDomainRoots, signal })
      .files.map(fullPath => ({ fullPath, relPath: relative(workspaceRoot, fullPath).replace(/\\/g, "/") }));
  }

  private resolveWorkspaceRoot(config: ValidatedSeptumConfig, domainRoot: string): string {
    if (this.customWorkspaceRoot) {
      return this.customWorkspaceRoot;
    }
    const settings = config.settings as Record<string, unknown> | undefined;
    if (typeof settings?.workspace_root === "string" && settings.workspace_root.trim()) {
      return resolve(settings.workspace_root);
    }
    if (config.settings.db_path && config.settings.db_path !== ":memory:") {
      const dbDir = dirname(resolve(config.settings.db_path));
      const candidate = basename(dbDir) === ".septum" ? dirname(dbDir) : dbDir;
      const absDomainRoot = isAbsolute(domainRoot) ? domainRoot : resolve(candidate, domainRoot);
      if (absDomainRoot.startsWith(candidate)) {
        return candidate;
      }
    }
    return resolveWorkspaceRoot();
  }


  private isSourceFile(path: string): boolean {
    return ASTParserEngine.isSourceFile(path);
  }

  public assertDomainOwnership(config: ValidatedSeptumConfig, projectRoot: string): void {
    const proposedNames = new Set(Object.keys(config.domains).map(domainNameKey));
    const retained = Object.fromEntries(this.repo.getAllDomains()
      .filter(domain => !proposedNames.has(domainNameKey(domain.name)))
      .map(domain => [domain.name, { root: domain.root_path }]));
    assertUniqueDomainRoots({ ...retained, ...config.domains }, projectRoot);
  }

  private recordSyncFailure(error: unknown): void {
    this.repo.setMeta("sync_state", "error");
    this.repo.setMeta("sync_error", String(error));
    this.repo.setMeta("sync_error_code", error instanceof DomainRootConflictError ? error.code : "");
  }

  private ensureParserFingerprint(rebuild = false): void {
    const revision = PARSER_FINGERPRINT;
    if (!rebuild && this.repo.getMeta("parser_revision") === revision) return;
    this.repo.runInTransaction(() => {
      for (const file of this.repo.getAllFiles()) {
        this.repo.upsertFile(file.domain_id, file.path, file.archetype, "", file.line_count, -1, -1);
      }
      this.repo.clearVerticalSlices();
      this.repo.setMeta("slices_dirty", "1");
      this.repo.setMeta("parser_revision", revision);
    });
  }

  /**
   * JIT single-file ingestion: quickly verifies and updates a single file's AST,
   * symbols, and dependencies in SQLite if its mtime or content hash has changed.
   */
  /** Apply inside the caller's transaction after checking the source hash. */
  private publishParsedFile(domainId: number, file: {
    relPath: string;
    archetype: ArchetypeKind;
    contentHash: string;
    lineCount: number;
    mtimeMs: number;
    sizeBytes: number;
    ast: ParsedFileAST;
  }, markSlicesDirty = true): void {
    const { relPath, archetype, contentHash, lineCount, mtimeMs, sizeBytes, ast } = file;
    const fileId = this.repo.upsertFile(domainId, relPath, archetype, contentHash, lineCount, mtimeMs, sizeBytes);
    this.repo.replaceFileSymbols(fileId, ast.symbols);
    this.repo.replaceFileDependencies(fileId, ast.dependencies);
    if (markSlicesDirty) this.repo.setMeta("slices_dirty", "1");
  }

  private removeIndexedFile(path: string): void {
    this.repo.deleteFileByPath(path);
    this.repo.setMeta("slices_dirty", "1");
  }

  private updateFileDiagnostics(path: string, reason?: "file_too_large" | "unsupported"): void {
    const skipped: SkippedSourceFile[] = JSON.parse(this.repo.getMeta("skipped_files") || "[]");
    const unsupported: string[] = JSON.parse(this.repo.getMeta("unsupported_files") || "[]");
    this.repo.setMeta("skipped_files", JSON.stringify([
      ...skipped.filter(file => file.path !== path),
      ...(reason === "file_too_large" ? [{ path, reason }] : []),
    ]));
    this.repo.setMeta("unsupported_files", JSON.stringify([
      ...unsupported.filter(file => file !== path),
      ...(reason === "unsupported" ? [path] : []),
    ]));
  }

  public removeFile(path: string, reason?: "file_too_large" | "unsupported"): void {
    this.repo.runInTransaction(() => {
      this.removeIndexedFile(path);
      this.repo.clearVerticalSlices();
      this.updateFileDiagnostics(path, reason);
    });
  }

  public async ingestFile(targetFilePath: string, config: ValidatedSeptumConfig): Promise<boolean> {
    try { this.assertDomainOwnership(config, this.customWorkspaceRoot || resolveWorkspaceRoot()); }
    catch (error) { this.recordSyncFailure(error); throw error; }
    this.ensureParserFingerprint();
    const fullPath = resolve(targetFilePath);
    if (!existsSync(fullPath)) return false;

    let stat;
    try {
      stat = statSync(fullPath);
      if (!stat.isFile() || !this.isSourceFile(fullPath)) return false;
    } catch {
      return false;
    }

    const mtimeMs = stat.mtimeMs;
    const sizeBytes = stat.size;

    const projectRoot = this.customWorkspaceRoot || resolveWorkspaceRoot();
    const relPath = relative(projectRoot, fullPath).replace(/\\/g, "/");

    if (shouldIgnoreSourcePath(relPath, config.settings.ignore_patterns ?? [])) {
      return false;
    }

    const targetDomainName = new ModuleResolver(projectRoot, this.repo).resolveSourceDomain(fullPath, config);
    const targetDomainCfg = targetDomainName ? config.domains[targetDomainName] : null;

    if (!targetDomainName || !targetDomainCfg) {
      return false;
    }

    const domainId = this.repo.upsertDomain(targetDomainName, targetDomainCfg);
    const existingFile = this.repo.getFileByPath(relPath);

    let content: string;
    try { content = readSourceFile(fullPath); }
    catch (error) {
      if (!(error instanceof SourceFileLimitError)) throw error;
      this.removeFile(relPath, "file_too_large");
      return false;
    }
    const currentHash = computeContentHash(content);
    const archetype = detectArchetype(relPath, targetDomainCfg.archetypes ?? {});

    // Tier 2: Hash verification
    if (existingFile && existingFile.domain_id === domainId && existingFile.content_hash === currentHash) {
      if (existingFile.archetype !== archetype) {
        this.repo.runInTransaction(() => {
          this.repo.upsertFile(domainId, relPath, archetype, currentHash, existingFile.line_count, mtimeMs, sizeBytes);
          this.repo.setMeta("slices_dirty", "1");
        });
      } else if (existingFile.mtime_ms !== mtimeMs || existingFile.size_bytes !== sizeBytes) {
        this.repo.updateFileMetadataOnly(existingFile.id, mtimeMs, sizeBytes);
      }
      return false;
    }

    const lineCount = content.split("\n").length;
    const ast = await this.parserEngine.parseFile(fullPath, content);
    if (ast.status === "unsupported" || ast.status === "degraded") {
      this.removeFile(relPath, "unsupported");
      return false;
    }

    let latestHash: string | undefined;
    try { latestHash = computeContentHash(readSourceFile(fullPath)); }
    catch { /* A vanished, unreadable or oversized source must not publish the parsed version. */ }
    if (latestHash !== currentHash) {
      const message = `Source changed during synchronization: '${relPath}' changed during single-file parsing. Run sync against stable inputs.`;
      this.repo.setMeta("sync_state", "error");
      this.repo.setMeta("sync_error", message);
      throw new Error(message);
    }

    this.repo.runInTransaction(() => {
      this.publishParsedFile(domainId, { relPath, archetype, contentHash: currentHash, lineCount, mtimeMs, sizeBytes, ast });
      this.repo.clearVerticalSlices();
      this.updateFileDiagnostics(relPath);
    });

    return true;
  }
}

