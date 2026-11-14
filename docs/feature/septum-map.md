# Feature SSOT: `septum_map` (Macro Architecture & Domain Catalog)

## 1. Navigation contract (`navigation/v1`)

`septum_map` answers where to look and which paths connect. `septum_symbol` inspects declarations, signatures, contracts and implementation after a target is selected. Catalog responses no longer include per-file symbol arrays, source bodies, full declarations, or the complete capability registry by default.

### Workspace overview

```json
{ "action": "catalog" }
```

Returns domain roots, indexed file counts and declared dependency policies. `dependencies` aggregates resolved static imports between domains; each edge carries `from`, `to`, `relation: "imports"` and `count`. Workspace `files` is empty because domain records are the navigation nodes. `entrypoints` provides up to 20 static catalog targets, with `runtime_verified: false`.

### Domain and file navigation

```json
{ "action": "catalog", "domain": "ordering" }
```

Each file contains `path`, `domain`, `archetype`, `symbol_count` and one indexed symbol-name `anchor` (or null). Anchors support targeted symbol lookup; they are not declaration inventories. Dependencies use actual file paths and include both incoming and outgoing imports touching the selected scope. A neighboring path can belong to another domain.

```json
{ "action": "catalog", "domain": "ordering", "file_filter": "order.service.ts" }
```

`file_filter` is a case-insensitive path substring; `archetype_filter` narrows the architectural layer. Files are ordered by static entrypoint membership, connection degree, then path. `next` offers a slice lookup for an entrypoint or a symbol lookup using a real indexed anchor and its file.

### Detail and omission accounting

Compact selects up to 40 files; `detail_level: "full"` selects up to 100. Full expands navigation coverage, not declaration detail. `file_limit` (maximum 100) and `file_offset` remain available, but `pagination` appears only when more matching files remain. Continue with `pagination.next_file_offset` and unchanged filters. Dependency edges are capped at 100 and entrypoints at 20. `accounting` exposes returned and omitted counts; refine the scope to recover relevant edges or entrypoints. These are item limits, not a strict serialized-byte budget.

`health` reports sync state, sync-needed status, unresolved import count, unsupported/skipped file counts and bounded reasons. Coverage remains `partial`: an import edge is not a call, execution order, or runtime proof. Static entrypoints can be inferred. Missing and unindexed targets remain uncertain.

### Optional diagnostics

```json
{ "action": "catalog", "file_filter": "src/orders/order.service.ts", "include_evidence": true }
```

Evidence requires a filter matching exactly one indexed file. It returns at most 20 raw import relationships with explicit accounting, plus up to five unresolved diagnostic examples. The raw evidence describes imports originating in that file; incoming connections remain available in the navigation edges.

`include_capabilities: true` explicitly adds parser and semantic-adapter capabilities. With `detail_level: "full"`, that registry is expanded. Normal navigation includes the small runtime-version metadata but omits the registry.

### Compatibility

Catalog input aliases and registration behavior remain supported. The response shape changes intentionally to `navigation/v1`: consumers reading `telescope_view`, `connections`, file symbol arrays or full declarations must migrate. Use `dependencies`, `files`, `health` and `next`, then `septum_symbol` for depth. The programmatic repository declaration-catalog API remains available; MCP map does not call it. No database migration is required.

---

## 3. Sub-Operation `action: "register"` (Dynamic Domain Registration)
When engineers or AI agents introduce a new module or bounded context, domains can be registered dynamically without manual configuration file edits:

```json
// Request
{
  "action": "register",
  "name": "shipping",
  "root": "src/modules/shipping",
  "allowed_dependencies": ["common", "ordering"],
  "forbidden_dependencies": ["billing"],
  "ingest_now": true
}
```
* **Root Collision Validation:** Two names cannot own the same physical root. Nested roots are supported.
* **Policy Ownership:** With `septum.config.json`, registration updates the file and records the effective domain in SQLite. Without it, SQLite owns policy. The response identifies `policy_owner` (`file` or `database`). Omitted fields retain the current owner's values; explicit empty arrays clear them.
* **Write Failures:** A lock or stale file snapshot rejects registration. A failed file write rolls back the database update. The file is replaced atomically, but the filesystem and SQLite do not form a distributed transaction; the file remains authoritative after a crash between their commits.
* **Ingestion:** With `ingest_now: true`, registration also synchronizes source. Registration success without ingestion does not certify index freshness.

Catalog construction returns structured data first; shared guidance is derived from its status and the MCP handler serializes it. Full capabilities distinguish registered adapters, applicability and counts from the last successful extraction. Those counts describe supported patterns, not runtime completeness.

---

## 4. Automatic Topology Discovery (`TopologyDetector`)

When initialized in a workspace, the **`TopologyDetector`** engine ([topology-detector.ts](../../src/core/discovery/topology-detector.ts)) automatically discovers languages, frameworks, and architectural styles without prior configuration:

```
                            Project Root
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
1. Language Detection                           2. Framework Detection
   • PHP: composer.json, artisan                   • Laravel: artisan
   • Go: go.mod                                    • Symfony: bin/console, symfony.lock
   • Python: pyproject.toml, requirements.txt      • NestJS: @nestjs/core in package.json
   • TS/JS: tsconfig.json, package.json            • Express, Fastify, Hono, Elysia
                                                   • FastAPI, Django, Flask (Python)
                                                   • Gin, Echo, Chi, Fiber (Go)
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
3. Project Type Classification                  4. Architectural Style Mapping
   • monorepo (pnpm, turbo, lerna, nx)             • monorepo-workspaces (apps/*, packages/*)
   • backend (standalone API framework)            • modular-ddd (domains/*, modules/*)
   • fullstack (Next.js, Nuxt, Laravel Blade)      • layered-monolith (app/Http/Controllers, etc.)
   • cli-mcp (MCP server SDK, CLI)                 • clean-architecture (Go cmd/*, internal/*)
```

### Automatic Domain Partition Rules
* **Monorepo Workspaces:** Every package under `apps/*` and `packages/*` is mapped as an independent domain. Default dependency rules permit `apps` to import `packages`, while prohibiting `packages` from importing `apps`.
* **Modular DDD:** Directory structures such as `src/domains/*`, `src/modules/*`, `app/Domain/*`, or `features/*` are isolated into bounded domains with dependencies restricted to `shared` or `common`.
* **Go Clean Architecture:** `cmd/` is designated as the entrypoint domain, `internal/` as private domain logic, and `pkg/` as public shared libraries. Rules enforce that `internal` is never imported externally, and `pkg` cannot depend on `cmd`.
* **Layered Monolith (Laravel MVC / NestJS Layered):** Mapped into domain layers (`app/Http/Controllers`, `app/Services`, `app/Models`, etc.).

---

## 5. SSOT Metadata Summary in SQLite (`repo_meta`)

All discovered topological facts are persisted in the embedded database:
* `repo_meta.framework`: Framework name (e.g., `"laravel"`, `"nestjs"`, `"fastapi"`, `"gin"`).
* `repo_meta.language`: Primary language (`"typescript"`, `"php"`, `"python"`, `"go"`).
* `repo_meta.architecture_style`: Architectural style (`"modular-ddd"`, `"clean-architecture"`, etc.).
* `repo_meta.project_type`: Project classification (`"backend"`, `"monorepo"`, `"fullstack"`).
