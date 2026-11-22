import { symbolReference, matchesSymbolName, matchesSymbolReference } from "../../resolver/symbol-reference.ts";
import type { Database } from "bun:sqlite";
import type {
  ExtractedSymbol,
  FileRecord,
  SymbolKind,
  SymbolRecord,
  SymbolCandidate,
  SymbolSelectionOptions,
} from "../../../types/index.ts";

const SQL_KEYWORD_BLACKLIST = new Set([
  "VALUES",
  "WHERE",
  "SELECT",
  "FROM",
  "JOIN",
  "LIKE",
  "INSERT",
  "UPDATE",
  "DELETE",
]);

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

export function computeSymbolLeafName(name: string): string {
  const trimmed = name.trim().replace(/\(\)$/, "");
  return trimmed.split(/::|->|[.#/\\]/).pop() ?? trimmed;
}

export class SymbolRepository {
  constructor(private db: Database) {}

  public replaceFileSymbols(fileId: number, symbols: ExtractedSymbol[]): void {
    this.db.query("DELETE FROM symbols WHERE file_id = ?").run(fileId);
    if (symbols.length === 0) return;

    const stmt = this.db.query(
      `INSERT INTO symbols (file_id, name, leaf_name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const sym of symbols) {
      const lineCount = sym.line_count ?? Math.max(1, sym.line_end - sym.line_start + 1);
      const nestingDepth = sym.nesting_depth ?? 1;
      stmt.run(
        fileId,
        sym.name,
        computeSymbolLeafName(sym.name),
        sym.kind,
        sym.signature,
        sym.visibility,
        sym.line_start,
        sym.line_end,
        lineCount,
        nestingDepth
      );
    }
  }

  public getSymbolsByFileId(fileId: number): SymbolRecord[] {
    return this.db
      .query<SymbolRecord, [number]>(
        "SELECT * FROM symbols WHERE file_id = ? ORDER BY line_start ASC"
      )
      .all(fileId);
  }

  public findSymbolsByName(
    name: string,
    options: SymbolSelectionOptions = {}
  ): SymbolCandidate[] {
    const target = name.trim().replace(/\(\)$/, "");
    if (!target) return [];
    const leaf = computeSymbolLeafName(target);
    let query = `SELECT s.*, f.path AS file_path, f.content_hash AS indexed_content_hash, d.name AS domain_name
      FROM symbols s JOIN files f ON s.file_id = f.id JOIN domains d ON f.domain_id = d.id
      WHERE (s.name = ? OR s.leaf_name = ?)`;
    const params: string[] = [target, leaf];
    if (options.domain) { query += " AND d.name = ?"; params.push(options.domain); }
    const filePath = options.filePath ?? options.reference?.file_path;
    if (filePath) { query += " AND f.path = ?"; params.push(filePath); }
    query += " ORDER BY f.path, s.line_start, s.line_end, s.signature, s.id";
    return this.db.query<SymbolCandidate, string[]>(query).all(...params)
      .filter(row => matchesSymbolName(row, target))
      .map(row => ({ ...row, symbol_ref: symbolReference(row) }))
      .filter(row => !options.reference || matchesSymbolReference(row.symbol_ref, options.reference));
  }

  public findContainers(
    containerName: string
  ): Array<{ file: FileRecord; symbol?: SymbolRecord }> {
    const symbolQuery = `
      SELECT s.*, f.path AS file_path, f.id AS f_id, f.domain_id AS f_domain_id, 
             f.archetype AS f_archetype, f.content_hash AS f_content_hash, 
             f.line_count AS f_line_count, f.mtime_ms AS f_mtime_ms, 
             f.size_bytes AS f_size_bytes, f.last_scanned_at AS f_last_scanned_at
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE (s.name = ? OR s.name LIKE ? OR s.name LIKE ?)
        AND s.kind IN ('class', 'interface', 'trait', 'enum')
      LIMIT 10
    `;
    const rows = this.db
      .query<any, [string, string, string]>(symbolQuery)
      .all(containerName, `%\\${containerName}`, `%/${containerName}`);

    if (rows.length > 0) {
      return rows.map((r) => ({
        file: {
          id: r.f_id,
          domain_id: r.f_domain_id,
          path: r.file_path,
          archetype: r.f_archetype,
          content_hash: r.f_content_hash,
          line_count: r.f_line_count,
          mtime_ms: r.f_mtime_ms,
          size_bytes: r.f_size_bytes,
          last_scanned_at: r.f_last_scanned_at,
        },
        symbol: {
          id: r.id,
          file_id: r.file_id,
          name: r.name,
          kind: r.kind,
          signature: r.signature,
          visibility: r.visibility,
          line_start: r.line_start,
          line_end: r.line_end,
          line_count: r.line_count ?? (r.line_end - r.line_start + 1),
          nesting_depth: r.nesting_depth ?? 1,
        },
      }));
    }

    const fileQuery = `
      SELECT * FROM files
      WHERE path LIKE ? OR path LIKE ?
      LIMIT 10
    `;
    const files = this.db
      .query<FileRecord, [string, string]>(fileQuery)
      .all(`%/${containerName}.%`, `%\\${containerName}.%`);

    return files.map((file) => ({ file }));
  }

  public findFuzzySymbolCandidates(
    queryStr: string,
    options?: { domainId?: number; filePath?: string; limit?: number }
  ): Array<SymbolRecord & { file_path: string }> {
    const targetLeaf = computeSymbolLeafName(queryStr);
    const clauses = [
      "s.kind IN ('class', 'interface', 'trait', 'struct', 'enum', 'type', 'method', 'function', 'constant')",
    ];
    const params: Array<string | number> = [];
    if (options?.filePath) {
      clauses.push("f.path = ?");
      params.push(options.filePath);
    }
    if (options?.domainId !== undefined) {
      clauses.push("f.domain_id = ?");
      params.push(options.domainId);
    }
    if (targetLeaf.length >= 2) {
      const minLen = Math.max(1, Math.floor(targetLeaf.length * 0.4));
      const maxLen = Math.max(targetLeaf.length + 12, Math.ceil(targetLeaf.length * 2.5));
      clauses.push("length(s.leaf_name) BETWEEN ? AND ?");
      params.push(minLen, maxLen);
    }
    if (targetLeaf.length >= 4) {
      const lower = targetLeaf.toLowerCase().replace(/[^a-z0-9]/g, "");
      const distinct: string[] = [];
      for (const ch of lower) {
        if (!distinct.includes(ch)) {
          distinct.push(ch);
          if (distinct.length >= 4) break;
        }
      }
      if (distinct.length > 0) {
        const charClauses = distinct.map(() => "instr(lower(s.leaf_name), ?) > 0");
        clauses.push(`(${charClauses.join(" OR ")})`);
        params.push(...distinct);
      }
    }
    const limit = Math.max(1, options?.limit ?? 500);
    params.push(targetLeaf.length, limit);
    const query = `
      SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY abs(length(s.leaf_name) - ?) ASC, s.line_start ASC
      LIMIT ?
    `;
    return this.db.query<SymbolRecord & { file_path: string }, Array<string | number>>(query).all(...params);
  }

  public getAllSymbolsWithFiles(filter?: { domainId?: number; filePath?: string }): Array<SymbolRecord & { file_path: string }> {
    const clauses = ["s.kind IN ('class', 'interface', 'trait', 'struct', 'enum', 'type', 'method', 'function', 'constant')"];
    const params: Array<string | number> = [];
    if (filter?.filePath) {
      clauses.push("f.path = ?");
      params.push(filter.filePath);
    }
    if (filter?.domainId !== undefined) {
      clauses.push("f.domain_id = ?");
      params.push(filter.domainId);
    }
    const query = `
      SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.line_start ASC, s.name ASC
    `;
    return this.db.query<SymbolRecord & { file_path: string }, Array<string | number>>(query).all(...params);
  }

  public findSymbolWithDomain(symbolName: string): {
    symbol_name: string;
    kind: string;
    file_path: string;
    domain_name: string;
  } | null {
    const query = `
      SELECT 
        s.name AS symbol_name,
        s.kind,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE s.name = ?
      LIMIT 1
    `;
    return this.db.query<any, [string]>(query).get(symbolName) ?? null;
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
    const rootQuery = `
      SELECT 
        s.id AS symbol_id,
        s.file_id,
        s.name AS symbol_name,
        s.kind,
        s.signature,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE s.name = ?
      LIMIT 1
    `;
    const root = this.db.query<any, [string]>(rootQuery).get(symbolName);
    if (!root) return null;

    const membersQuery = `
      SELECT name, kind, signature
      FROM symbols
      WHERE file_id = ? AND name LIKE ?
      ORDER BY line_start ASC
    `;
    const members = this.db
      .query<any, [number, string]>(membersQuery)
      .all(root.file_id, `${symbolName}::%`);

    const methods: string[] = [];
    const properties: string[] = [];

    for (const m of members) {
      if (m.kind === "method") {
        methods.push(m.signature);
      } else if (m.kind === "property") {
        properties.push(m.signature);
      }
    }

    return {
      symbol_name: root.symbol_name,
      kind: root.kind,
      signature: root.signature,
      file_path: root.file_path,
      domain_name: root.domain_name,
      methods,
      properties,
    };
  }

  public getFileWithDomain(filePath: string): {
    file_id: number;
    file_path: string;
    domain_name: string;
  } | null {
    const query = `
      SELECT 
        f.id AS file_id,
        f.path AS file_path,
        d.name AS domain_name
      FROM files f
      JOIN domains d ON f.domain_id = d.id
      WHERE f.path = ?
      LIMIT 1
    `;
    return this.db.query<any, [string]>(query).get(filePath) ?? null;
  }

  public findConstructorSignature(fileId: number, classOwner: string): string | null {
    const ctor = this.db
      .query<{ signature: string }, [number, string, string, string, string]>(
        "SELECT signature FROM symbols WHERE file_id = ? AND (name = ? OR name = ? OR name = ? OR name LIKE ?) LIMIT 1"
      )
      .get(
        fileId,
        `${classOwner}::__construct`,
        `${classOwner}::constructor`,
        `${classOwner}::__init__`,
        `%::__construct`
      );
    return ctor?.signature ?? null;
  }

  public getInternalImportStatements(fileId: number): string[] {
    return this.db
      .query<{ import_statement: string }, [number]>(
        "SELECT import_statement FROM dependencies WHERE source_file_id = ? AND is_external = 0"
      )
      .all(fileId)
      .map((dep) => dep.import_statement || "");
  }
}
