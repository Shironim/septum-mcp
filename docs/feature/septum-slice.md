# septum_slice

This tool matches a query against a stored static entrypoint catalog and returns related architectural nodes. It does not run handlers or prove that nodes execute sequentially.

```json
{
  "query":"POST /orders",
  "max_depth":5,
  "controller_file":"src/orders/controller.ts",
  "workspace_path":"/path/to/project"
}
```

`query` is required. `max_depth` defaults to 5; normalization truncates/clamps numeric values to 1–8. `controller_file` narrows the candidate set when routes are ambiguous.

## Query matching

The tracer attempts method/URI, URI-only, named-route, trigger, controller/action, symbol and token-scored matching. Supported examples include:

- `POST /orders`, `/orders/{id}` and named routes.
- `OrderController@store`, `OrderController::store` or a controller name.
- `JOB ProcessOrderJob`, `CLI order:cleanup`, `EVENT OrderPlacedListener`.
- Task text, matched through token scores against catalog fields.

Colon forms such as `job:ProcessOrderJob` can match stored route URIs. The dedicated JOB/CLI/EVENT parser expects whitespace after the trigger word; colon syntax is not a universal trigger alias. A query only works when the corresponding catalog record or another matching signal exists.

Literal catalog matches can be exact. Parameterized/semantic matches can be inferred. Multiple matches or top-score ties return `ambiguous` instead of selecting one chain. Alternatives are bounded and can include omission counts; use `controller_file` or a narrower query to resolve them.

## Catalog construction

The registry contains 12 semantic adapters:

| Adapter group | Registered adapters |
| --- | --- |
| PHP | Laravel, Symfony |
| TypeScript/JavaScript | NestJS, Express, Fastify, Hono, Elysia, MCP/CLI |
| Python | FastAPI, Django, Flask |
| Go | One Go HTTP adapter covering selected standard HTTP/Gin/Echo/Chi/Fiber patterns |

Registration does not mean an adapter applies to every repository, nor that all framework syntax is recognized. Adapters extract selected literal/decorator/routing and lexical patterns. They can provide validation, service, persistence, event and schema hints where implemented.

Generic extraction complements uncovered route files. Files already represented by an adapter are excluded from generic declarative-route extraction to avoid duplicate/unprefixed mounted routes. Inferred controller entrypoints are retained only when no adapter slices were produced. The shared source inventory applies containment and ignore rules; semantic files can be outside registered domain roots.

Both ingestion and query refresh use the shared slice-catalog publisher. Catalog inputs, filesystem observations, membership and adapter counts are tracked. Dirty/changed catalogs can be refreshed; extraction failure is surfaced rather than certifying a complete empty catalog. Stored generic chains are constructed to the supported maximum depth; query depth limits returned expansion.

## Response interpretation

The MCP response contains `status`, `found`, `confidence`, `entrypoint`, `chain`, alternatives, diagnostics and recovery hints. Status can be `success`, `not_found`, `ambiguous` or `unknown`; diagnostics can make a found result unknown.

The response explicitly sets:

```json
{
  "confidence_scope":"query_to_catalog_target_only",
  "execution_order":"not_established"
}
```

This is a field excerpt. `chain` can contain ingress, guard, validation, controller/action, service/use-case, repository/entity, table and side-effect/event nodes. Presence and stage detail depend on adapter evidence; this is not a required sequence or a guarantee that every layer appears.

A node's `relationship.kind` and `derivation` describe its evidence. Missing metadata is unknown. Import nodes are filtered from the returned execution-context chain. Lexical heuristics remain partial and can span mutually exclusive branches. The summary labels nodes with their relation/derivation instead of claiming one proven runtime path.

Go package-import expansion is omitted; extracted handler/service relationships remain lexical. Migration-derived table fields are static summaries, not proof of deployed database state. The registered schema provider is Laravel migration analysis; dynamic or unreadable migration operations can prevent a reliable summary.

A missing catalog match does not prove that an endpoint, job or listener is absent at runtime.

## Implementation and regression evidence

- [Public handler](../../src/mcp/tools/trace-vertical-slice.ts), [matching and output selection](../../src/core/resolver/vertical-slice-tracer.ts)
- [Catalog publication](../../src/core/resolver/slice-catalog.ts), [adapter registry](../../src/core/parser/extractors/registry.ts)
- [Relationship formatting](../../src/core/resolver/slice-format.ts), [schema provider](../../src/core/parser/schema/schema-provider-registry.ts)
- [Tracer tests](../../tests/vertical-slice-tracer.test.ts), [selection integrity](../../tests/unit/slice-selection-integrity.test.ts), [output tests](../../tests/unit/vertical-slice-output.test.ts), [shared extraction contracts](../../tests/unit/refactor-contracts.test.ts)
