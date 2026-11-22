# septum_slice

This tool matches a query against a stored static entrypoint catalog and returns related architectural nodes. It does not run handlers or prove that nodes execute sequentially.

```json
{
  "query":"POST /orders",
  "max_depth":5,
  "format":"text",
  "controller_file":"src/orders/controller.ts",
  "workspace_path":"/path/to/project"
}
```

`query` is required. `max_depth` defaults to 5; normalization truncates/clamps numeric values to 1–8. `format` defaults to `"text"` (token-efficient compact markdown summary with indented call-tree hierarchy; pass `"json"` for the structured JSON payload). `controller_file` narrows the candidate set when routes are ambiguous. Method-scoped slice expansion bridges same-file local helper calls (AST-verified for TypeScript/JavaScript and lexical local-call bridging for polyglot files) so thin wrapper handlers expose downstream services and repositories.

## Query matching

The tracer first attempts an exact indexed SQL lookup (`findExactVerticalSlices`) for literal `METHOD /uri`, `/uri`, `Controller@action`, `Controller::action` and named-route queries before falling back to full catalog scoring for parameterized URIs, omni-triggers, symbol matches and token-scored task intent. Supported examples include:

- `POST /orders`, `/orders/{id}` and named routes.
- `OrderController@store`, `OrderController::store` or a controller name.
- `JOB ProcessOrderJob`, `CLI command:check`, `MCP tool:septum_symbol`, `EVENT OrderPlacedListener` (and `RPC`/`QUEUE`/`CRON`/`WS` triggers).
- `tool:septum_map` for a cataloged MCP tool and `command:sync` for a cataloged CLI command.
- Task text, matched through token scores against catalog fields.

Colon forms such as `job:ProcessOrderJob` can match stored route URIs. The dedicated omni-trigger parser (`JOB|CLI|EVENT|MCP|RPC|QUEUE|CRON|WS`) expects whitespace after the trigger word and produces `confidence: "exact"` (`is_exact_match: true`) when matching a single catalog target; colon syntax is not a universal trigger alias. A query only works when the corresponding catalog record or another matching signal exists.

Literal catalog matches can be exact. Parameterized/semantic matches can be inferred. Multiple matches or top-score ties return `ambiguous` instead of selecting one chain. Alternatives are bounded and can include omission counts; use `controller_file` or a narrower query to resolve them.

An HTTP method query can match a catalog row with method `ANY`. The match is inferred when the query specifies a concrete method. Literal rows for that method and `ANY` at the same URI can produce an ambiguous result.

An explicit method such as `PURGE` stays part of the lookup even when the catalog contains no registration for that method. Rebuilding the catalog preserves separate registrations with identical methods, paths and handler names. A query can return two alternatives in the same controller file.

## Catalog construction

The registry contains 12 semantic adapters:

| Adapter group | Registered adapters |
| --- | --- |
| PHP | Laravel, Symfony |
| TypeScript/JavaScript | NestJS, Express, Fastify, Hono, Elysia, MCP/CLI |
| Python | FastAPI, Django, Flask |
| Go | One Go HTTP adapter covering selected standard HTTP/Gin/Echo/Chi/Fiber patterns |

Registration does not mean an adapter applies to every repository, nor that all framework syntax is recognized. Adapters extract selected literal/decorator/routing and lexical patterns. They can provide validation, service, persistence, event and schema hints where implemented.

Generic extraction complements uncovered route files. Files already represented by an adapter are excluded from generic declarative-route extraction to avoid duplicate/unprefixed mounted routes. Uncovered controller files retain convention-based entrypoints when another file gains an adapter route. Generic TypeScript/JavaScript route discovery recognizes literal calls on unbound conventional router names in route modules. These calls and controller conventions carry inferred ingress evidence. Locally declared receivers require adapter recognition. The shared source inventory applies containment and ignore rules; semantic files can be outside registered domain roots.

Both ingestion and query refresh use the shared slice-catalog publisher with bulk prepared SQLite inserts. All 12 semantic adapters use entrypoint-first discovery or fast text pre-filters (such as two-pass URLconf-to-view parsing in Django, route-call/decorator pre-filters in Express, NestJS, Fastify, Hono, Elysia, FastAPI, Flask, Symfony and Go) so non-routing files are not redundantly re-parsed. `CallGraphTracer` and `ImportCandidateResolver` load symbols, dependencies and import evidence lazily per visited file and compute outbound controller dependencies once per controller file rather than repeating BFS per method. Catalog inputs, filesystem observations, membership and adapter counts are tracked. Dirty/changed catalogs can be refreshed; extraction failure is surfaced rather than certifying a complete empty catalog. Stored generic chains are constructed to the supported maximum depth; query depth limits returned expansion.

SQLite stores convention-based entries as `inferred_http_route`. The framework registration probe compares the remaining entries with its expected registrations. TypeScript handler binding uses the workspace import resolver, including supported `tsconfig.json` path aliases that resolve to one indexed source file.

## Response interpretation

The MCP response contains `status`, `found`, `confidence`, `entrypoint`, `chain`, alternatives, diagnostics and recovery hints. Status can be `success`, `not_found`, `ambiguous` or `unknown`; diagnostics can make a found result unknown.

The response explicitly sets:

```json
{
  "confidence_scope":"query_to_catalog_target_only",
  "execution_order":"not_established"
}
```

This is a field excerpt. `chain` can contain ingress, guard, validation, controller/action, service/use-case, repository/entity, table and side-effect/event nodes. AST-traced nodes also include `parent_symbol` and `depth`, which `format: "text"` renders as an indented tree (`(via <caller>)`). Presence and stage detail depend on adapter evidence; this is not a required sequence or a guarantee that every layer appears.

A node's `relationship.kind` and `derivation` describe its evidence. Missing metadata is unknown. Import nodes are filtered from the returned execution-context chain. Lexical heuristics remain partial and can span mutually exclusive branches. The summary labels nodes with their relation/derivation instead of claiming one proven runtime path.

## Go HTTP routes

The adapter visits call nodes in the Go AST. It follows supported router constructors, typed receivers, local aliases and selected imports within workspace Go modules.

- **`net/http`** reads `Handle` and `HandleFunc` on the package and supported mux receivers, including `DefaultServeMux`. It accepts literal path patterns and method/path pairs such as `GET /orders`. It can follow a handler wrapped in `http.HandlerFunc`.
- **Gin, Echo and Fiber** follow selected `Group` calls and combine their literal prefixes with route paths. **Chi** follows selected `Route` and `Group` callbacks and `With` chains. **Chi and Fiber** can follow literal `Mount` calls for locally identified routers or sub-apps.
- If the handler resolves to a local declaration, the controller node includes that declaration's file and line. The ingress node uses the registration call's location. Comments, strings containing examples, and lookalike methods on unrelated receiver types do not supply route calls.

Dynamic paths or unresolved router wiring can leave routes absent. Service and persistence details still use selected declaration and naming patterns. Interface dispatch and build conditions remain outside this adapter.

## Laravel routes

The adapter reads facade calls in `routes/web.php` and `routes/api.php`, using the PHP AST to distinguish code from comments and strings. It resolves recognized facade aliases and reads literal prefix, name and controller settings from closure groups. Nested groups supply context to routes declared inside their callbacks.

It handles supported HTTP verb calls and `view`, controller/method arrays, invokable controllers, closures and selected string actions. `resource` and `apiResource` expand into rows for the supported actions, with literal `only` or `except` filters. Resource rows use the catalog's normalized `{id}` placeholder and `PUT` for update.

For an imported controller, the adapter resolves the qualified class through the PHP import resolver, then locates the method inside that class's AST. A conventional short name can use the workspace's controller directories when there is a unique candidate. A route can remain in the catalog with a null controller file when the declared target cannot be found.

Dynamic group values and unsupported resource customizations can leave routes absent. Inherited controller methods, provider-loaded route files and runtime registration are outside this path. Controller behavior and downstream service hints use heuristics. The Laravel schema provider reads migration source to summarize table fields.

## Symfony attribute routes

The adapter reads PHP route attributes under `src/Controller`, or under `src` when the controller directory is absent. It recognizes Symfony's routing attribute and legacy annotation class used as a PHP attribute. It follows fully qualified names and class or namespace aliases, including grouped imports.

Each supported method attribute can produce catalog rows. The adapter combines literal paths and explicit name prefixes from the class and method and merges their method lists. An empty combined method list is cataloged as `ANY`. A class attribute can supply routes for a locally declared `__invoke` when the class has no method route attributes. Controller coordinates point to the method declaration.

Computed route fields and localized path arrays can leave routes absent. YAML and PHP route configurators, inherited actions, generated route names, and host or environment filtering are outside the attribute adapter. Request and service hints use method parameter types.

## NestJS HTTP routes

The adapter recognizes decorators bound to `@nestjs/common`, including named aliases and namespace imports. It combines literal controller and method paths, including path arrays and the `path` field of a controller options object. It recognizes verb decorators and supported `RequestMapping` options using `RequestMethod`. `All` and `RequestMethod.ALL` produce `ANY` catalog rows. Controller coordinates point to the method declaration in its own file.

The catalog represents decorator declarations. Runtime module registration, global prefixes, versioning and inherited handlers are outside the adapter's static evidence. Computed paths or methods and unresolved decorator bindings can leave entries absent.

## Python HTTP routes

- **FastAPI.** The adapter reads supported module-level verb decorators, `api_route`, and `add_api_route` on identified app or router bindings. It follows constructor aliases, local router aliases, and selected imported routers passed to `include_router`. It combines literal prefixes through each known mount chain. A path of `""` uses the composed prefix and a path of `"/"` retains the trailing slash. Decorator and router dependency hints remain partial.
- **Flask.** The adapter reads supported module-level decorators and `add_url_rule` with a locally identified view. It follows nested Blueprint registrations and literal `url_prefix` overrides. A missing override or `None` uses the Blueprint default. An empty string overrides it with no added prefix. Catalog methods describe explicit registrations or the default GET and omit implicit HEAD and OPTIONS. Route names use the local Blueprint or explicit endpoint where available.
- **Django and DRF.** The adapter reads supported `urlpatterns` lists, concatenation, append and extend calls, and explicitly mounted router URLs. It follows literal URLConf inclusions and selected imported module aliases. View binding uses the declaring file and symbol. Selected function decorators, class methods, literal ViewSet action maps, and mounted SimpleRouter or DefaultRouter actions contribute methods. Django catalog paths normalize trailing slashes and convert named groups and converters to placeholders. DRF detail paths use `{id}`. An ordinary function-based view contributes an `ANY` row when the adapter observes no recognized method restriction.

Computed paths, method lists, and mount prefixes can leave routes absent. Framework setup functions, configuration-driven wiring, arbitrary callbacks, and runtime route policies are outside these supported patterns. Standalone router declarations can appear with their own literal prefixes as static catalog candidates.

## MCP tools and CLI commands

- **MCP.** In `src/mcp/server.*`, the adapter reads SDK `McpServer.registerTool` and `.tool` calls. For low-level SDK `Server`, it reads literal names returned by the `ListToolsRequestSchema` handler and looks for a matching dispatch case in the `CallToolRequestSchema` handler on the same instance.
- **CLI.** The adapter reads workspace-contained source entrypoints named in `package.json#bin`. It follows supported `switch` dispatch on command-line arguments or positionals from `parseArgs`. A file under `commands/` alone supplies no registration evidence.
- **Handler binding.** Local functions, aliases and supported relative imports can identify the declaration. The CLI also follows handlers destructured from a literal `import()` in a dispatch case. A known name with an unresolved handler is stored as `unresolved_handler` with no controller file or controller node. Computed names and unsupported registration patterns are omitted.

For the analyzer's own stdio interface, see [MCP resources and prompts](mcp-resources-and-prompts.md).

## Implementation and regression evidence

- [Slice tool handler](../../src/mcp/tools/slice.ts), [matching and selection](../../src/core/resolver/slice-selection.ts), [vertical slice tracer](../../src/core/resolver/vertical-slice-tracer.ts), [compact text formatter](../../src/mcp/formatters/compact-text.ts)
- [Catalog publication](../../src/core/resolver/slice-catalog.ts), [adapter registry](../../src/core/parser/extractors/registry.ts)
- [Relationship formatting](../../src/core/resolver/slice-format.ts), [schema provider](../../src/core/parser/schema/schema-provider-registry.ts)
- [Call graph tracer](../../src/core/resolver/call-graph-tracer.ts), [AST method tracer](../../src/core/resolver/ast-method-tracer.ts), [polyglot slice tracer](../../src/core/resolver/polyglot-slice-tracer.ts), [Go route extractor](../../src/core/parser/extractors/go-semantic.ts)
- [Framework slice integrity tests](../../tests/unit/framework-slice-integrity.test.ts), [vertical slice output tests](../../tests/unit/vertical-slice-output.test.ts), [v0.4.0 output curation](../../tests/unit/v040-output-curation.test.ts)
- [Tracer tests](../../tests/vertical-slice-tracer.test.ts), [selection integrity](../../tests/unit/slice-selection-integrity.test.ts), [shared extraction contracts](../../tests/unit/refactor-contracts.test.ts)
