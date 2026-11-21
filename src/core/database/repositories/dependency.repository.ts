import type { Database } from "bun:sqlite";
import type { DependencyQueryStore } from "../../resolver/dependency-analysis.ts";
import type { IndexedDependency } from "../../resolver/import-evidence.ts";
import type {
  ExtractedDependency,
  VerticalSliceRecord,
} from "../../../types/index.ts";

export class DependencyRepository implements DependencyQueryStore {
  constructor(private db: Database) {}

  public replaceFileDependencies(fileId: number, deps: ExtractedDependency[]): void {
    this.db.query("DELETE FROM dependencies WHERE source_file_id = ?").run(fileId);
    if (deps.length === 0) return;

    const stmt = this.db.query(
      `INSERT INTO dependencies (source_file_id, target_symbol_or_path, import_statement, line_number, is_external) 
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const dep of deps) {
      stmt.run(fileId, dep.target, dep.statement, dep.line_number, dep.is_external ? 1 : 0);
    }
  }

  public upsertVerticalSlice(
    slice: Omit<VerticalSliceRecord, "id" | "created_at">
  ): void {
    const existing = this.db
      .query<VerticalSliceRecord, [string, string, number | null, string | null, string, string, string]>(
        `SELECT id FROM vertical_slices WHERE http_method = ? AND route_uri = ?
         AND domain_id IS ? AND controller_file IS ? AND controller_class = ? AND action_name = ? AND entry_kind = ?`
      )
      .get(slice.http_method, slice.route_uri, slice.domain_id, slice.controller_file,
        slice.controller_class, slice.action_name, slice.entry_kind ?? "http_route");

    if (existing) {
      this.db
        .query(
          `UPDATE vertical_slices
           SET domain_id = ?, feature_key = ?, route_name = ?, controller_class = ?,
               action_name = ?, controller_file = ?, controller_line = ?,
               architecture_style = ?, entry_kind = ?, execution_chain_json = ?
           WHERE id = ?`
        )
        .run(
          slice.domain_id,
          slice.feature_key,
          slice.route_name,
          slice.controller_class,
          slice.action_name,
          slice.controller_file,
          slice.controller_line,
          slice.architecture_style ?? "clean",
          slice.entry_kind ?? "http_route",
          slice.execution_chain_json,
          existing.id
        );
    } else {
      this.insertVerticalSlice(slice);
    }
  }

  public insertVerticalSlice(slice: Omit<VerticalSliceRecord, "id" | "created_at">): void {
    this.db
      .query(
        `INSERT INTO vertical_slices (
          domain_id, feature_key, http_method, route_uri, route_name,
          controller_class, action_name, controller_file, controller_line,
          architecture_style, entry_kind, execution_chain_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        slice.domain_id,
        slice.feature_key,
        slice.http_method,
        slice.route_uri,
        slice.route_name,
        slice.controller_class,
        slice.action_name,
        slice.controller_file,
        slice.controller_line,
        slice.architecture_style ?? "clean",
        slice.entry_kind ?? "http_route",
        slice.execution_chain_json
      );
  }

  public findVerticalSlices(searchTerm: string): VerticalSliceRecord[] {
    const term = searchTerm.trim();
    const wild = `%${term}%`;
    const query = `
      SELECT * FROM vertical_slices
      WHERE route_uri LIKE ?
         OR route_name LIKE ?
         OR controller_class LIKE ?
         OR action_name LIKE ?
         OR feature_key LIKE ?
         OR execution_chain_json LIKE ?
      ORDER BY id ASC
    `;
    return this.db.query<VerticalSliceRecord, [string, string, string, string, string, string]>(query).all(
      wild, wild, wild, wild, wild, wild
    );
  }

  public getAllVerticalSlices(): VerticalSliceRecord[] {
    return this.db.query<VerticalSliceRecord, []>("SELECT * FROM vertical_slices ORDER BY id ASC").all();
  }

  public countVerticalSlices(): number {
    const row = this.db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM vertical_slices")
      .get();
    return row?.cnt ?? 0;
  }

  public clearVerticalSlices(domainId?: number): void {
    if (domainId) {
      this.db.query("DELETE FROM vertical_slices WHERE domain_id = ?").run(domainId);
    } else {
      this.db.query("DELETE FROM vertical_slices").run();
    }
  }

  public getAllDependenciesWithDomains(sourceFile?: string): IndexedDependency[] {
    const query = `
      SELECT 
        f.path AS source_file,
        d.name AS source_domain,
        dep.line_number,
        dep.target_symbol_or_path AS target,
        dep.import_statement AS statement,
        dep.is_external
      FROM dependencies dep
      JOIN files f ON dep.source_file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      ${sourceFile === undefined ? "" : "WHERE f.path = ?"}
      ORDER BY d.name, f.path, dep.line_number
    `;
    return this.db.query<IndexedDependency, string[]>(query).all(...(sourceFile === undefined ? [] : [sourceFile]));
  }

  public getWorkspaceRootMeta(): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM repo_meta WHERE key = ?").get("workspace_root")?.value;
  }

  public getIndexedFilesForEvidence(sourceFile?: string): Array<{ path: string; content_hash: string; domain_id: number }> {
    return this.db
      .query<{ path: string; content_hash: string; domain_id: number }, string[]>(
        `SELECT path, content_hash, domain_id FROM files ${sourceFile === undefined ? "" : "WHERE path = ?"} ORDER BY path ASC`
      )
      .all(...(sourceFile === undefined ? [] : [sourceFile]));
  }

  public getDomainsForEvidence(): Array<{ name: string; root_path: string }> {
    return this.db.query<{ name: string; root_path: string }, []>("SELECT name, root_path FROM domains").all();
  }

  public hasIndexedFile(path: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM files WHERE path = ?").get(path));
  }

  public getAllFileSummaries(): Array<{ id: number; domain_id: number; path: string }> {
    return this.db
      .query<{ id: number; domain_id: number; path: string }, []>("SELECT id, domain_id, path FROM files ORDER BY path ASC")
      .all();
  }

  public getAllInternalDependencyTargets(): Array<{ source_file_id: number; target_symbol_or_path: string }> {
    return this.db
      .query<{ source_file_id: number; target_symbol_or_path: string }, []>(
        "SELECT source_file_id, target_symbol_or_path FROM dependencies WHERE is_external = 0"
      )
      .all();
  }

  public findImpactMethodCandidates(
    trimmed: string,
    container: string,
    method: string,
    domain?: string
  ): Array<{
    name: string;
    kind: string;
    signature: string;
    line_start: number;
    line_end: number;
    file_path: string;
    domain_name?: string | null;
  }> {
    let sql = `
      SELECT s.name, s.kind, s.signature, s.line_start, s.line_end, f.path AS file_path, dom.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      LEFT JOIN domains dom ON f.domain_id = dom.id
    `;
    const params: any[] = [];
    if (domain) {
      sql += ` WHERE LOWER(dom.name) = LOWER(?) AND `;
      params.push(domain);
    } else {
      sql += ` WHERE `;
    }
    sql += ` (s.name = ? OR s.name = ? OR (s.name = ? AND s.kind = 'method')) `;
    params.push(trimmed, `${container}::${method}`, method);
    return this.db.query<any, any[]>(sql).all(...params);
  }

  public findImpactContainerCandidates(
    trimmed: string,
    container: string,
    domain?: string
  ): Array<{
    name: string;
    kind: string;
    line_start: number;
    line_end: number;
    file_path: string;
    domain_name?: string | null;
  }> {
    let sql = `
      SELECT s.name, s.kind, s.line_start, s.line_end, f.path AS file_path, dom.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      LEFT JOIN domains dom ON f.domain_id = dom.id
    `;
    const params: any[] = [];
    if (domain) {
      sql += ` WHERE LOWER(dom.name) = LOWER(?) AND `;
      params.push(domain);
    } else {
      sql += ` WHERE `;
    }
    sql += ` (s.name = ? OR s.name = ? OR s.name LIKE ? OR s.name LIKE ?) `;
    params.push(trimmed, container, `${container}::%`, `%::${container}`);
    return this.db.query<any, any[]>(sql).all(...params);
  }

  public queryDependenciesForImpact(patterns: {
    container: string;
    trimmed: string;
    stems: string[];
  }): Array<{
    file: string;
    line_number: number;
    target_symbol_or_path: string;
    import_statement: string;
    domain_name?: string | null;
  }> {
    const whereClauses: string[] = [
      "d.target_symbol_or_path LIKE ?",
      "d.import_statement LIKE ?",
      "d.target_symbol_or_path LIKE ?",
    ];
    const queryParams: string[] = [
      `%${patterns.container}%`,
      `%${patterns.container}%`,
      `%${patterns.trimmed}%`,
    ];

    for (const stem of patterns.stems) {
      whereClauses.push("d.target_symbol_or_path LIKE ?");
      queryParams.push(`%${stem}%`);
    }

    const depSql = `
      SELECT 
        f.path AS file,
        d.line_number,
        d.target_symbol_or_path,
        d.import_statement,
        dom.name AS domain_name
      FROM dependencies d
      JOIN files f ON d.source_file_id = f.id
      LEFT JOIN domains dom ON f.domain_id = dom.id
      WHERE ${whereClauses.join(" OR ")}
      ORDER BY f.path ASC, d.line_number ASC
    `;
    return this.db.query<any, string[]>(depSql).all(...queryParams);
  }

  public findSameDirectoryPackageFiles(dirs: string[]): Array<{ path: string; domain_name: string | null }> {
    if (dirs.length === 0) return [];
    const dirClauses: string[] = [];
    const dirParams: string[] = [];
    for (const dir of dirs) {
      if (dir === "") {
        dirClauses.push("f.path NOT LIKE '%/%'");
      } else {
        dirClauses.push("(f.path LIKE ? AND SUBSTR(f.path, LENGTH(?) + 2) NOT LIKE '%/%')");
        dirParams.push(`${dir}/%`, dir);
      }
    }
    return this.db
      .query<{ path: string; domain_name: string | null }, string[]>(
        `SELECT f.path, dom.name AS domain_name
         FROM files f
         LEFT JOIN domains dom ON f.domain_id = dom.id
         WHERE ${dirClauses.join(" OR ")}`
      )
      .all(...dirParams);
  }

  public findSymbolsForFiles(filePaths: string[]): Array<{
    name: string;
    kind: string;
    signature: string;
    line_start: number;
    line_end: number;
    path: string;
  }> {
    if (filePaths.length === 0) return [];
    const placeholders = filePaths.map(() => "?").join(",");
    return this.db
      .query<
        { name: string; kind: string; signature: string; line_start: number; line_end: number; path: string },
        string[]
      >(
        `SELECT s.name, s.kind, s.signature, s.line_start, s.line_end, f.path
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE f.path IN (${placeholders})
         ORDER BY (s.line_end - s.line_start) ASC`
      )
      .all(...filePaths);
  }

  public findFileSymbolNames(cleanPath: string): string[] {
    return this.db
      .query<{ name: string }, [string, string]>(
        `SELECT s.name 
         FROM symbols s 
         JOIN files f ON s.file_id = f.id 
         WHERE f.path = ? OR f.path LIKE ?`
      )
      .all(cleanPath, `%${cleanPath}`)
      .map((s) => s.name);
  }

  public queryDependenciesForFileInbound(
    cleanPath: string,
    baseName: string,
    symbolNames: string[]
  ): Array<{ file: string; target: string; stmt: string }> {
    const orConditions: string[] = [];
    const params: string[] = [];

    if (baseName.length >= 3) {
      orConditions.push("d.target_symbol_or_path LIKE ?");
      params.push(`%${cleanPath}%`);
      orConditions.push("d.target_symbol_or_path LIKE ?");
      params.push(`%${baseName}%`);
    }

    for (const sym of symbolNames.slice(0, 8)) {
      const symName = sym.split("::").pop() || sym;
      if (symName.length >= 4) {
        orConditions.push("d.target_symbol_or_path LIKE ?");
        params.push(`%${symName}%`);
        orConditions.push("d.import_statement LIKE ?");
        params.push(`%${symName}%`);
      }
    }

    if (orConditions.length === 0) return [];
    params.push(`%${cleanPath}`);
    return this.db
      .query<{ file: string; target: string; stmt: string }, string[]>(
        `SELECT DISTINCT f.path AS file, d.target_symbol_or_path AS target, d.import_statement AS stmt
         FROM dependencies d
         JOIN files f ON d.source_file_id = f.id
         WHERE (${orConditions.join(" OR ")})
           AND f.path NOT LIKE ?`
      )
      .all(...params);
  }
}
