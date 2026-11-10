# Feature SSOT: Workspace Lifecycle, SQLite Database & Invalidation Engine

## 1. Background & Business Requirements

As a static code analysis engine for backends, Septum's central engineering challenge is **guaranteeing data freshness** without placing unnecessary loads on CPU and disk I/O.
1. **Zero Stale State:** If a developer edits a file in their editor, the AI agent must never receive shifted line numbers or deleted method references.
2. **Incremental Sync Efficiency:** Reparsing the entire repository on every single-file modification is prohibitively expensive. Septum must isolate only modified files.
3. **Transitive Dependency & Type Invalidation:** If an external type file (`types.ts`) or barrel export (`index.ts`) is modified, consumers must be automatically refreshed or marked stale.
4. **Global Configuration Responsiveness:** Changes to project manifests (such as path aliases `@/*` in `tsconfig.json` or PSR-4 autoload rules in `composer.json`) must trigger deterministic re-evaluation of import graphs.

---

## 2. SQLite Embedded Database Architecture (`septum.db`)

Septum utilizes an embedded SQLite database located at `.septum/septum.db`, operating in **WAL (Write-Ahead Logging)** mode to facilitate high-concurrency read operations:

* **`domains` table:** Stores registered bounded contexts, root directories, and boundary policies (`allowed_deps_json`, `forbidden_deps_json`, `archetypes_json`).
* **`files` table:** Stores file metadata, archetype classifications, SHA-256 content hashes (`content_hash`), line counts, byte sizes, and modification timestamps (`mtime_ms`).
* **`symbols` table:** Stores symbols extracted via Tree-Sitter (name, kind, signature, visibility, `line_start`, `line_end`).
* **`dependencies` table:** Stores file-to-file import edges (`source_file_id`, `target_symbol_or_path`, `import_statement`, `is_external`).
* **`vertical_slices` table:** Caches vertical route-to-database execution slices generated from semantic analysis.
* **`repo_meta` table:** Stores global repository state, including configuration revisions, parser fingerprints, and indexing status.

---

## 3. Transitive Invalidation: Type & Barrel Files

### Problem Scenario:
A backend service `UserService.ts` imports `UserDTO` from a type file `types.ts` or through a barrel export `index.ts`. A developer updates `types.ts` (e.g., adding `role: string`), but does not modify `UserService.ts`.

### Septum Solution:
```
types.ts / index.ts (Modified on disk)
       │
       ▼
1. File Watcher / Incremental Hashing
       │  └── Hash for types.ts updates in `files` table
       │  └── Sets `slices_dirty = 1` flag in SQLite database
       │
2. Dual-Layer Edge Invalidation (`dependencies` & `import_relationships`)
       │  └── Edge relation UserService -> types.ts marked as `freshness: "stale"`
       │
3. Stale-Reference Refusal
       │  └── If agent queries symbol using outdated hash,
       │      Septum refuses: `status: "stale_reference"` and triggers sync
       │
4. Dynamic On-The-Fly AST Binding (`retrieveContext`)
       └── Parser loads updated AST for types.ts into memory
       └── Emits new `type_contract` reflecting the added field immediately!
```

1. **Edge Freshness Tracking:** Every relationship in `dependencies` and `import_relationships` binds an `indexed_content_hash`. During context queries, Septum compares actual disk content hashes against index hashes. Mismatches automatically transition edges to `freshness: "stale"`.
2. **Stale Reference Refusal:** Septum refuses to return stale cached signatures, emitting `status: "stale_reference"` so agents never hallucinate outdated type contracts.
3. **Dynamic AST Binding:** When functions in `UserService.ts` are inspected, the `context` engine reads the modified `types.ts` directly from disk and projects updated `type_contract` interfaces on the fly.

---

## 4. Global Configuration Changes (*Config Fingerprint*)

### Problem Scenario:
A developer modifies project configuration files such as `tsconfig.json` (rerouting `@/*` path aliases), `composer.json` (changing PSR-4 namespace mappings), `go.mod`, or `pyproject.toml`.

### Septum Solution:
Septum uses a **Manifest Hashing Engine** and **Multi-Tier Cryptographic Revisions**:

1. **Manifest Hashing Map (`manifests`):**
   Whenever configuration manifests are loaded (`tsconfig.json`, `composer.json`, `go.mod`, etc.), Septum computes SHA-256 hashes and caches them in memory:
   ```typescript
   manifests[path.relative(this.root, file)] = computeContentHash(text);
   ```
   Supports recursive traversal for `extends` clauses in `tsconfig.json` (e.g., `tsconfig.base.json`).
2. **Deterministic `config_revision` Computation:**
   Import resolution results bind a deterministic revision token:
   $$\text{config\_revision} = \text{SHA256}(\text{root} + \text{RESOLVER\_REVISION} + \text{manifests})$$
   A single character change in any manifest causes `config_revision` to invalidate completely.
3. **Multi-Tier Revisions:**
   * `PARSER_FINGERPRINT`: Compiled Tree-Sitter parser logic and WASM binary assets.
   * `SEMANTIC_FINGERPRINT`: Code revision for the 12 semantic framework extractors.
   * `RESOLVER_REVISION`: Version token for path and alias resolution logic.
4. **Automatic Clean Rebuild & Cache Flush:**
   If any revision token or manifest configuration differs from values stored in `repo_meta`:
   * Stale route caches are cleared (`clearVerticalSlices()`).
   * The `slices_dirty` flag is set to `"1"`.
   * `TopologyDetector.detect()` is re-executed to discover new topology.
   * All import resolution graphs are rebuilt from a clean state.

---

## 5. File Watcher Mechanics & JIT Delta Sync

To optimize system resource consumption, Septum synchronizes workspace state across two modes:

1. **Bounded Watch Budget:**
   * Uses native `fs.watch` with safe file-descriptor limits to guard against descriptor exhaustion (`EMFILE`).
   * If directory watch counts exceed limits, Septum falls back gracefully to bounded polling.
2. **Just-In-Time (JIT) Delta Sync on Query:**
   * When `septum_slice` or `septum_symbol` is called, if `slices_dirty === "1"` or input files have uncommitted changes, Septum executes a rapid re-trace within a single SQLite transaction.
   * Agents always receive consistent, accurate data without requiring manual server restarts.
