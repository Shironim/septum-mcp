import type { Database } from "bun:sqlite";
import { computeSymbolLeafName } from "./repositories/symbol.repository.ts";

export const CURRENT_SCHEMA_VERSION = 5;

export const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    root_path TEXT NOT NULL,
    allowed_deps_json TEXT NOT NULL DEFAULT '[]',
    forbidden_deps_json TEXT NOT NULL DEFAULT '[]',
    archetypes_json TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    path TEXT NOT NULL UNIQUE,
    archetype TEXT NOT NULL DEFAULT 'unknown',
    content_hash TEXT NOT NULL,
    line_count INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    last_scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    leaf_name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    signature TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    line_start INTEGER NOT NULL DEFAULT 0,
    line_end INTEGER NOT NULL DEFAULT 0,
    line_count INTEGER NOT NULL DEFAULT 1,
    nesting_depth INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER NOT NULL,
    target_symbol_or_path TEXT NOT NULL,
    import_statement TEXT NOT NULL,
    line_number INTEGER NOT NULL DEFAULT 0,
    is_external BOOLEAN NOT NULL DEFAULT 0,
    resolved_target_file TEXT,
    FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS vertical_slices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER,
    feature_key TEXT,
    http_method TEXT NOT NULL,
    route_uri TEXT NOT NULL,
    route_name TEXT,
    controller_class TEXT NOT NULL,
    action_name TEXT NOT NULL,
    controller_file TEXT,
    controller_line INTEGER DEFAULT 0,
    architecture_style TEXT NOT NULL DEFAULT 'clean',
    entry_kind TEXT NOT NULL DEFAULT 'http_route',
    execution_chain_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS repo_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
];

export const INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_domains_name ON domains(name);",
  "CREATE INDEX IF NOT EXISTS idx_files_domain_id ON files(domain_id, id);",
  "CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);",
  "CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);",
  "CREATE INDEX IF NOT EXISTS idx_symbols_file_lines ON symbols(file_id, line_start, line_end);",
  "CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);",
  "CREATE INDEX IF NOT EXISTS idx_symbols_leaf_name ON symbols(leaf_name);",
  "CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);",
  "CREATE INDEX IF NOT EXISTS idx_dependencies_source ON dependencies(source_file_id);",
  "CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(target_symbol_or_path);",
  "CREATE INDEX IF NOT EXISTS idx_dependencies_resolved_target ON dependencies(resolved_target_file);",
  "CREATE INDEX IF NOT EXISTS idx_slices_route_uri ON vertical_slices(route_uri);",
  "CREATE INDEX IF NOT EXISTS idx_slices_route_name ON vertical_slices(route_name);",
  "CREATE INDEX IF NOT EXISTS idx_slices_controller ON vertical_slices(controller_class, action_name);",
];

const DROP_ALL_TABLES = `
  DROP TABLE IF EXISTS environment_nodes;
  DROP TABLE IF EXISTS environment_topology;
  DROP TABLE IF EXISTS repo_meta;
  DROP TABLE IF EXISTS vertical_slices;
  DROP TABLE IF EXISTS dependencies;
  DROP TABLE IF EXISTS symbols;
  DROP TABLE IF EXISTS files;
  DROP TABLE IF EXISTS domains;
`;

export function initializeDatabaseSchema(db: Database): void {
  const versionRow = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
  const userVersion = versionRow?.user_version ?? 0;

  if (userVersion !== 0 && userVersion !== CURRENT_SCHEMA_VERSION) {
    // Outdated schema versions are cleanly dropped and recreated
    db.run(DROP_ALL_TABLES);
  }

  for (const tableSql of TABLE_STATEMENTS) {
    db.run(tableSql);
  }

  // Additive migration for existing v5 databases without resolved_target_file column
  const depCols = db.query<{ name: string }, []>("PRAGMA table_info(dependencies);").all();
  if (!depCols.some(col => col.name === "resolved_target_file")) {
    db.run("ALTER TABLE dependencies ADD COLUMN resolved_target_file TEXT;");
  }

  // Additive migration for existing v5 databases without symbols.leaf_name column
  const symCols = db.query<{ name: string }, []>("PRAGMA table_info(symbols);").all();
  if (!symCols.some(col => col.name === "leaf_name")) {
    db.run("ALTER TABLE symbols ADD COLUMN leaf_name TEXT NOT NULL DEFAULT '';");
    const rows = db.query<{ id: number; name: string }, []>("SELECT id, name FROM symbols WHERE leaf_name = ''").all();
    if (rows.length > 0) {
      const updateStmt = db.query("UPDATE symbols SET leaf_name = ? WHERE id = ?");
      db.transaction(() => {
        for (const row of rows) {
          updateStmt.run(computeSymbolLeafName(row.name), row.id);
        }
      })();
    }
  }

  for (const indexSql of INDEX_STATEMENTS) {
    db.run(indexSql);
  }

  db.run(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
}
