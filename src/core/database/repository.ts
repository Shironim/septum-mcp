import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ArchetypeKind,
  DomainCatalogResponse,
  DomainConfig,
  DomainRecord,
  NavigationFile,
  NavigationEntrypoint,
  ExtractedDependency,
  ExtractedSymbol,
  FileRecord,
  GetSymbolDetailsResponse,
  GetSymbolImpactResponse,
  InboundCaller,
  SymbolKind,
  SymbolRecord,
  SymbolReference,
  SymbolCandidate,
  SymbolSelectionOptions,
  VerticalSliceRecord,
} from "../../types/index.ts";

export type {
  ArchetypeKind,
  DomainCatalogResponse,
  DomainConfig,
  DomainRecord,
  ExtractedDependency,
  ExtractedSymbol,
  FileRecord,
  GetSymbolDetailsResponse,
  GetSymbolImpactResponse,
  InboundCaller,
  SymbolKind,
  SymbolRecord,
  VerticalSliceRecord,
} from "../../types/index.ts";
import { DependencyRepository } from "./repositories/dependency.repository.ts";
import { DomainRepository } from "./repositories/domain.repository.ts";
import { FileRepository } from "./repositories/file.repository.ts";
import { MetaRepository } from "./repositories/meta.repository.ts";
import { SymbolRepository } from "./repositories/symbol.repository.ts";
import {
  buildDomainFileConnections,
  buildFileConnections,
  buildFileInboundImpact,
  buildImportEvidence,
  buildImportRelationships,
  buildScopedImportRelationships,
  buildSymbolImpact,
} from "../resolver/dependency-analysis.ts";
import { buildSymbolDetails } from "../retrieval/symbol-details.ts";

export type DatabaseRepository = SeptumRepository;

export class SeptumRepository {
  private indexIdentityCache?: { stamp: string; digest: string };
  public readonly domains: DomainRepository;
  public readonly files: FileRepository;
  public readonly symbols: SymbolRepository;
  public readonly dependencies: DependencyRepository;
  public readonly meta: MetaRepository;

  constructor(private db: Database) {
    this.domains = new DomainRepository(db);
    this.files = new FileRepository(db);
    this.symbols = new SymbolRepository(db);
    this.dependencies = new DependencyRepository(db);
    this.meta = new MetaRepository(db);
  }

  public runInTransaction<T>(fn: () => T, immediate = false): T {
    const transaction = this.db.transaction(fn);
    return immediate ? transaction.immediate() : transaction();
  }

  public checkpoint(): void {
    try {
      this.db.run("PRAGMA wal_checkpoint(PASSIVE);");
    } catch {
      // Ignore if locked or busy
    }
  }

  public getNavigationFiles(): NavigationFile[] {
    return this.db.query<NavigationFile, []>(`
      SELECT f.path, d.name AS domain, f.archetype, COUNT(s.id) AS symbol_count,
        (SELECT name FROM symbols WHERE file_id = f.id AND kind IN ('function','class','struct','interface') ORDER BY line_start, name LIMIT 1) AS anchor
      FROM files f JOIN domains d ON d.id = f.domain_id
      LEFT JOIN symbols s ON s.file_id = f.id
      GROUP BY f.id ORDER BY f.path
    `).all();
  }

  public getNavigationEntrypoints(): NavigationEntrypoint[] {
    return this.db.query<NavigationEntrypoint, []>(`
      SELECT DISTINCT http_method AS method, route_uri AS target,
        controller_file AS file, action_name AS handler
      FROM vertical_slices ORDER BY controller_file, http_method, route_uri, action_name
    `).all();
  }

  /** Stable content identity without materializing/sorting the index in JS.
   * SQLite counters invalidate the cache for local writes and other connections;
   * the digest excludes insertion IDs and operational timestamps.
   */
  public getIndexIdentity(): string {
    // total_changes does not rewind on rollback. Never publish a digest of
    // uncommitted facts into the connection cache.
    const cacheable = !this.db.inTransaction;
    return this.runInTransaction(() => {
      const stamp = JSON.stringify([
        this.db.query("PRAGMA data_version").get(),
        this.db.query("SELECT total_changes() AS changes").get(),
        this.db.query("PRAGMA schema_version").get(),
      ]);
      if (cacheable && this.indexIdentityCache?.stamp === stamp) return this.indexIdentityCache.digest;
      const hash = createHash("sha256");
      for (const sql of [
        `SELECT json_array(name, root_path, allowed_deps_json, forbidden_deps_json, archetypes_json) AS fact
         FROM domains ORDER BY fact`,
        `SELECT json_array(f.path, f.content_hash, d.name) AS fact
         FROM files f JOIN domains d ON d.id = f.domain_id ORDER BY fact`,
        `SELECT json_array(f.path, s.name, s.kind, s.signature, s.visibility, s.line_start, s.line_end, s.line_count, s.nesting_depth) AS fact
         FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY fact`,
        `SELECT json_array(f.path, d.name, dep.target_symbol_or_path, dep.import_statement, dep.line_number, dep.is_external) AS fact
         FROM dependencies dep JOIN files f ON f.id = dep.source_file_id JOIN domains d ON d.id = f.domain_id ORDER BY fact`,
        `SELECT json_array(key, value) AS fact FROM repo_meta WHERE key IN ('sync_state', 'parser_revision') ORDER BY key`,
      ]) {
        hash.update("\0");
        for (const { fact } of this.db.query<{ fact: string }, []>(sql).iterate()) hash.update(fact + "\n");
      }
      const digest = hash.digest("hex");
      if (cacheable) this.indexIdentityCache = { stamp, digest };
      return digest;
    });
  }

  // --- Domain Methods ---
  public upsertDomain(name: string, config: DomainConfig, workspaceRoot?: string): number {
    return this.domains.upsertDomain(name, config, workspaceRoot);
  }

  public getDomainByName(name: string): DomainRecord | null {
    return this.domains.getDomainByName(name);
  }

  public getAllDomains(): DomainRecord[] {
    return this.domains.getAllDomains();
  }

  public pruneDomainsNotIn(activeNames: string[]): { prunedDomains: number; removedFiles: number } {
    return this.domains.pruneDomainsNotIn(activeNames);
  }

  // --- File Methods ---
  public getFileByPath(path: string): FileRecord | null {
    return this.files.getFileByPath(path);
  }

  public countFiles(): number {
    return this.files.countFiles();
  }

  public getFilesByDomain(domainId: number): FileRecord[] {
    return this.files.getFilesByDomain(domainId);
  }

  public getAllFiles(): FileRecord[] {
    return this.files.getAllFiles();
  }

  public upsertFile(
    domainId: number,
    path: string,
    archetype: ArchetypeKind,
    contentHash: string,
    lineCount: number,
    mtimeMs: number = 0,
    sizeBytes: number = 0
  ): number {
    return this.files.upsertFile(
      domainId,
      path,
      archetype,
      contentHash,
      lineCount,
      mtimeMs,
      sizeBytes
    );
  }

  public updateFileMetadataOnly(id: number, mtimeMs: number, sizeBytes: number): void {
    this.files.updateFileMetadataOnly(id, mtimeMs, sizeBytes);
  }

  public deleteFilesNotInPaths(domainId: number, validPaths: string[]): number {
    return this.files.deleteFilesNotInPaths(domainId, validPaths);
  }

  public rebindFilesToDomain(rootPrefix: string, domainId: number): number {
    return this.files.rebindFilesToDomain(rootPrefix, domainId);
  }

  public deleteFile(path: string): void {
    this.files.deleteFile(path);
  }

  public deleteFileByPath(path: string): void {
    this.files.deleteFileByPath(path);
  }

  public getDomainCatalog(
    domainName: string,
    archetypeFilter?: string,
    options?: { detailLevel?: "compact" | "full"; fileFilter?: string; workspaceRoot?: string }
  ): DomainCatalogResponse | null {
    return this.domains.getDomainCatalog(domainName, archetypeFilter, options);
  }

  // --- Symbol Methods ---
  public getDependenciesByFileId(fileId: number): ExtractedDependency[] {
    return this.db.query<ExtractedDependency, [number]>(`
      SELECT target_symbol_or_path AS target, import_statement AS statement,
             line_number, is_external FROM dependencies WHERE source_file_id = ? ORDER BY id
    `).all(fileId);
  }

  public replaceFileSymbols(fileId: number, symbols: ExtractedSymbol[]): void {
    this.symbols.replaceFileSymbols(fileId, symbols);
  }

  public getSymbolsByFileId(fileId: number): SymbolRecord[] {
    return this.symbols.getSymbolsByFileId(fileId);
  }

  public findSymbolsByName(
    name: string,
    options: SymbolSelectionOptions = {}
  ): SymbolCandidate[] {
    return this.symbols.findSymbolsByName(name, options);
  }

  public findContainers(
    containerName: string
  ): Array<{ file: FileRecord; symbol?: SymbolRecord }> {
    return this.symbols.findContainers(containerName);
  }

  public findFuzzySymbolCandidates(
    query: string,
    options?: { domainId?: number; filePath?: string; limit?: number }
  ): Array<SymbolRecord & { file_path: string }> {
    return this.symbols.findFuzzySymbolCandidates(query, options);
  }

  public getAllSymbolsWithFiles(filter?: { domainId?: number; filePath?: string }): Array<SymbolRecord & { file_path: string }> {
    return this.symbols.getAllSymbolsWithFiles(filter);
  }

  // --- Dependency & Slice Methods ---
  public replaceFileDependencies(fileId: number, deps: ExtractedDependency[]): void {
    this.dependencies.replaceFileDependencies(fileId, deps);
  }

  public upsertVerticalSlice(
    slice: Omit<VerticalSliceRecord, "id" | "created_at">
  ): void {
    this.dependencies.upsertVerticalSlice(slice);
  }

  public insertVerticalSlice(slice: Omit<VerticalSliceRecord, "id" | "created_at">): void {
    this.dependencies.insertVerticalSlice(slice);
  }

  public insertVerticalSlices(slices: ReadonlyArray<Omit<VerticalSliceRecord, "id" | "created_at">>): void {
    this.dependencies.insertVerticalSlices(slices);
  }

  public findVerticalSlices(searchTerm: string): VerticalSliceRecord[] {
    return this.dependencies.findVerticalSlices(searchTerm);
  }

  public getAllVerticalSlices(): VerticalSliceRecord[] {
    return this.dependencies.getAllVerticalSlices();
  }

  public findExactVerticalSlices(rawQuery: string, controllerFile?: string): VerticalSliceRecord[] {
    return this.dependencies.findExactVerticalSlices(rawQuery, controllerFile);
  }

  public countVerticalSlices(): number {
    return this.dependencies.countVerticalSlices();
  }

  public clearVerticalSlices(domainId?: number): void {
    this.dependencies.clearVerticalSlices(domainId);
  }

  public getImportEvidence(workspaceRoot: string, verifyFile?: (file: string) => boolean) {
    return buildImportEvidence(this.dependencies, workspaceRoot, undefined, verifyFile);
  }

  public getImportRelationships(workspaceRoot?: string, sourceFile?: string) {
    return buildImportRelationships(this.dependencies, workspaceRoot, sourceFile);
  }

  public getScopedImportRelationships(
    workspaceRoot?: string,
    options: {
      sourceFiles?: ReadonlySet<string>;
      targetCandidateFiles?: ReadonlySet<string>;
      sourceOrTargetPaths?: ReadonlySet<string>;
    } = {}
  ) {
    return buildScopedImportRelationships(this.dependencies, workspaceRoot, options);
  }

  public getDomainFileConnections(domainId?: number, workspaceRoot?: string) {
    return buildDomainFileConnections(this.dependencies, domainId, workspaceRoot);
  }

  public getFileConnections(filePath: string, workspaceRoot?: string) {
    return buildFileConnections(this.dependencies, filePath, workspaceRoot);
  }

  public getAllDependenciesWithDomains(): Array<{
    source_file: string;
    source_domain: string;
    line_number: number;
    target: string;
    statement: string;
    is_external: boolean;
  }> {
    return this.dependencies.getAllDependenciesWithDomains();
  }

  public findSymbolWithDomain(
    symbolName: string
  ): {
    symbol_name: string;
    kind: string;
    file_path: string;
    domain_name: string;
  } | null {
    return this.symbols.findSymbolWithDomain(symbolName);
  }

  public findSymbolWithMembers(symbolName: string): {
    symbol_name: string;
    kind: string;
    signature: string;
    file_path: string;
    domain_name: string;
    methods: string[];
    properties: string[];
  } | null {
    return this.symbols.findSymbolWithMembers(symbolName);
  }

  public getFileWithDomain(filePath: string): {
    file_id: number;
    file_path: string;
    domain_name: string;
  } | null {
    return this.symbols.getFileWithDomain(filePath);
  }

  public findConstructorSignature(fileId: number, classOwner: string): string | null {
    return this.symbols.findConstructorSignature(fileId, classOwner);
  }

  public getInternalImportStatements(fileId: number): string[] {
    return this.symbols.getInternalImportStatements(fileId);
  }

  public getSymbolDetails(
    symbolQuery: string,
    options: SymbolSelectionOptions & { includeDependencies?: boolean; workspaceRoot?: string } = {}
  ): GetSymbolDetailsResponse | null {
    return buildSymbolDetails(this, symbolQuery, options);
  }

  public getSymbolImpact(
    symbolName: string,
    options: { domain?: string; workspaceRoot?: string; filePath?: string; reference?: SymbolReference } = {}
  ): GetSymbolImpactResponse {
    return buildSymbolImpact(this.dependencies, symbolName, options);
  }

  public getFileInboundImpact(
    filePath: string,
    precomputedRelationships?: ReturnType<SeptumRepository["getImportRelationships"]>
  ): {
    direct_dependents_count: number;
    top_consumers: string[];
    symbols_count: number;
    risk_level: "low" | "medium" | "high";
  } {
    return buildFileInboundImpact(this.dependencies, filePath, precomputedRelationships);
  }

  // --- Metadata Methods ---
  public getMeta(key: string): string | null {
    return this.meta.getMeta(key);
  }

  public setMeta(key: string, value: string): void {
    this.meta.setMeta(key, value);
  }

  public getAllMeta(): Record<string, string> {
    return this.meta.getAllMeta();
  }
}

