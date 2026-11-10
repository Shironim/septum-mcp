# Feature SSOT: `septum_map` (Macro Architecture & Domain Catalog)

## 1. Background & Business Requirements

When first working in a large backend repository, AI Coding Agents encounter the **"Cold Start"** dilemma:
1. The agent lacks awareness of the project's architectural pattern (*Clean Architecture*, *Modular DDD*, *Layered MVC*, or *Monorepo*).
2. The agent is unfamiliar with module boundaries (*bounded contexts*) and dependency permissions between domains.
3. The agent frequently issues ad-hoc terminal commands (`ls`, `find`, `grep`) that burn tokens and waste latency.

`septum_map` eliminates this friction by delivering an **instant macro architectural map (*Telescope View*)** and **structured per-domain file catalogs** before an agent ever touches source code.

---

## 2. Two Primary Modes for `action: "catalog"`

### Mode A: Macro Bird's-Eye View (When `domain` is omitted)
Provides a high-level architectural overview of the entire system:
* **Telescope View:** Displays project classification (`project_type`), detected framework (`framework`), architectural style (`architecture_style`), and total execution slices (`total_vertical_slices`).
* **Bounded Domain List:** Surfaces registered domains, root directories, detected archetypes, and declared dependency constraints (`allowed_dependencies` and `forbidden_dependencies`).
* **Scanned vs Ignored Folders:** Distinguishes indexed source directories from deliberately excluded directories (e.g., `tests`, `public`, `dist`, `vendor`).

```json
// Request
{ "action": "catalog" }

// Response
{
  "telescope_view": {
    "project_type": "backend",
    "framework": "nestjs",
    "architecture_style": "modular-ddd",
    "total_domains": 3,
    "total_vertical_slices": 48,
    "scanned_folders": ["src/modules/ordering", "src/modules/billing", "src/modules/common"],
    "ignored_folders": ["node_modules", "dist", "tests", "coverage"]
  },
  "domains": [
    {
      "name": "ordering",
      "root": "src/modules/ordering",
      "archetypes": ["controller", "service", "repository", "dto", "entity"],
      "allowed_dependencies": ["common"],
      "forbidden_dependencies": ["billing"]
    },
    {
      "name": "billing",
      "root": "src/modules/billing",
      "archetypes": ["controller", "service", "repository", "dto"],
      "allowed_dependencies": ["common", "ordering"],
      "forbidden_dependencies": []
    }
  ]
}
```

### Mode B: Granular Domain Catalog (When `domain: "<name>"` is provided)
When an agent zooms in on a specific bounded context:
* **`detail_level: "compact"` (Default, Token-Efficient):** Lists files in the target domain, their archetype (controller, service, model), line counts, and symbol summaries (`methods_count`, `properties_count`, line span).
* **`detail_level: "full"`:** Returns full symbol declarations, method signatures, and file import dependency edges.
* **Archetype Filtering (`archetype_filter`):** Enables filtering by specific layer components:
  ```json
  { "action": "catalog", "domain": "ordering", "archetype_filter": "controller" }
  ```

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
* **Root Collision Validation:** Septum verifies that `root` does not overlap or conflict with existing domain paths.
* **Instant Persistence:** Configuration is saved directly to the SQLite `domains` table; if `ingest_now: true`, contained files are indexed immediately.

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
