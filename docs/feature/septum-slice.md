# Feature SSOT: `septum_slice` (Vertical Execution Chain Tracer)

## 1. Background & Business Requirements

In modern backend architectures, a client request never stops at the controller layer. Execution flows vertically through multiple layers:
$$\text{Ingress (Route / HTTP / CLI / Job)} \longrightarrow \text{Guard / Middleware} \longrightarrow \text{Validation DTO} \longrightarrow \text{Controller} \longrightarrow \text{Service / Use Case} \longrightarrow \text{Repository / ORM} \longrightarrow \text{Database Table}$$

**The Conventional Problem:**
When an AI agent needs to understand an endpoint such as `POST /orders`, it conventionally has to:
1. Search across source files for routing definitions.
2. Read the router file to find the controller handler.
3. Read the controller to identify the FormRequest / DTO and invoked service methods.
4. Read the service file to uncover mutated database tables or queries.
This consumes 5–8 separate tool calls and burns thousands of tokens from the agent's context window.

**The `septum_slice` Solution:**
`septum_slice` returns a bounded static catalog around supported entrypoints. Each relationship carries its evidence kind and derivation. Target-match confidence does not prove sequential execution or complete runtime reachability.

---

## 2. Omni-Trigger Support

`septum_slice` is not limited to HTTP endpoints; it natively supports 4 types of backend triggers:

1. **HTTP Endpoints & REST Routes:**
   * Method + URI: `POST /api/v1/orders`, `DELETE /users/{id}`
   * URI Path: `/orders/{id}/status`, `orders` (automatically matches route parameter placeholders `{id}`, `:id`, or `<int:id>`)
   * Named Routes: `orders.store`, `admin.users.index`, `api.checkout`
2. **Background Jobs / Queue Workers:**
   * Query: `JOB ProcessOrderJob` or `job:ProcessOrderJob`
   * Traces: Job dispatch $\to$ Job Handler $\to$ Service $\to$ DB Transaction.
3. **CLI Commands / Console Tasks:**
   * Query: `CLI order:cleanup` or `cli:order:cleanup`
   * Traces: Artisan / NestJS Commander / Click CLI command $\to$ Handler $\to$ Business Logic.
4. **Domain Events & Listeners:**
   * Query: `EVENT OrderPlacedListener` or `event:OrderPlacedListener`
   * Traces: Event trigger $\to$ Subscriber / Listener $\to$ Side effects (e.g., notifications).
5. **Controller & Action Method:**
   * Query: `OrderController@store`, `OrderController::updateStatus`, or `OrderController`.
6. **Task Intent / Natural Language:**
   * Query: `"Update order status in dashboard"` or `"checkout shopping cart"`. The engine tokenizes and scores similarity against known routes and execution graphs (`confidence: "inferred"`).

---

## 3. Two-Tier Slicing Architecture

```
                       septum_slice(query)
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │ Tier 1: Dedicated Framework Semantic         │
         │         Extractor (Laravel, NestJS, etc.)    │
         └──────────────────────┬───────────────────────┘
                                │
                    Extract supported adapter patterns
                    then identify uncovered entrypoint files
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │ Tier 2: Generic Tree-Sitter Call-Graph       │
         │         Tracer (bounded static fallback)    │
         └──────────────────────────────────────────────┘
```

### Tier 1: 12 Dedicated Framework Extractors
Septum includes semantic adapters tailored to framework decorators, routing constructs, validation contracts, and ORMs:
* **PHP:**
  * **Laravel:** `routes/web.php`, `routes/api.php`, FormRequest validation rules (`payload_props`), Controllers, Services, Eloquent Models, and database migration schemas.
  * **Symfony:** PHP 8 Attributes (`#[Route]`), Controller actions, and Doctrine Entities.
* **TypeScript / JavaScript:**
  * **NestJS:** Decorators `@Controller()`, `@Get()`, `@Post()`, `@Body() dto: CreateDto`, `@Injectable()` Services, and TypeORM / Prisma Repositories.
  * **Express.js:** `router.post()`, middleware chains, controller handlers, and service layers.
  * **Fastify:** Route schemas (`schema.body`, `schema.params`), handler functions, and encapsulated plugins.
  * **Hono & Elysia:** Modern TypeScript/Bun frameworks with support for Zod `zValidator` and TypeBox schemas.
  * **MCP / CLI:** Traces MCP server endpoints (`server.setRequestHandler`) and CLI command handlers.
* **Python:**
  * **FastAPI:** `@app.post()`, `@router.get()`, Pydantic `BaseModel` DTOs, `Depends()` injection, SQLAlchemy session queries.
  * **Django:** `urls.py`, Class-based Views (`APIView`, `ModelViewSet`), DRF Serializers, and Django ORM.
  * **Flask:** `@app.route()`, Blueprints, Marshmallow schemas, and views.
* **Go (Golang):**
  * Supports 5 Go web framework paradigms: **Standard `net/http`**, **Gin**, **Echo**, **Chi**, and **Fiber**.
  * Extracts request struct bindings (`c.ShouldBindJSON(&req)`), handler functions, service structs, and DB queries (GORM / sqlx).

### Tier 2: Generic Call-Graph Fallback
`slice-catalog.ts` owns extraction and publication for both ingestion and query refresh. Generic declarative routes complement files not already covered by an adapter. Router files already covered by an adapter are excluded to avoid inventing unprefixed duplicates of mounted routes. Inferred controller entrypoints are retained only when no adapter slices were produced.

The shared source inventory applies ignore patterns, containment and scan-error handling to adapters and ingestion. Semantic files can be outside registered domain roots. The fallback uses available indexed declarations and static heuristics; parsing a language does not establish complete call resolution. Languages with declaration support include:
* **Rust** (`.rs`)
* **Java** (`.java`)
* **C# / .NET** (`.cs`)
* **Ruby** (`.rb`)

---

## 4. Execution Chain Stage Anatomy

Each item within the output `chain` represents an explicit architectural execution stage:

| Stage | Description & Extracted Properties |
|---|---|
| **`ingress`** | Entrypoint trigger (HTTP Method, Route URI, CLI Command name, or Event name). |
| **`guard`** | Authentication middleware, RBAC checks, or guard decorators (e.g., `@UseGuards(AuthGuard)`). |
| **`validation`** | DTO class / FormRequest / Pydantic schema along with payload property fields (`payload_props: ["customer_id", "items", "amount"]`). |
| **`controller` / `action`** | Controller class, handler method name, and precise source line coordinates. |
| **`orchestrator` / `use_case`** | CQRS handler or application orchestrator class (in Clean / DDD architectures). |
| **`service`** | Domain business service invoked by the controller. |
| **`repository` / `entity`** | Data persistence layer (Repository, DAO, Prisma Client, Eloquent Model). |
| **`table`** | Concrete database table name and its schema migration definition file. |
| **`side_effect` / `event`** | Emitted domain events, dispatched background jobs, or transaction markers (`transactions: true`). |

---

## 5. JSON Input & Output Contracts

### Input Schema
```json
{
  "query": "POST /api/v1/orders",    // Required: Route URI, Method + URI, Controller@action, or task intent
  "max_depth": 5,                     // Optional: Traversal depth (1–8, default: 5)
  "controller_file": "src/orders/order.controller.ts", // Optional: Filter candidate matches in case of ambiguity
  "workspace_path": "/path/to/project" // Optional: Workspace target path
}
```

### Output Schema (Success)
```json
{
  "status": "success",
  "found": true,
  "confidence": "exact",
  "architecture_style": "controller_service_repository",
  "max_depth_applied": 5,
  "entrypoint": {
    "method": "POST",
    "uri": "/api/v1/orders",
    "name": "orders.store",
    "controller": "OrderController",
    "action": "store",
    "file": "app/Http/Controllers/OrderController.php",
    "line": 28
  },
  "chain": [
    {
      "stage": "ingress",
      "symbol": "POST /api/v1/orders",
      "file": "routes/api.php",
      "line": 42
    },
    {
      "stage": "validation",
      "symbol": "CreateOrderRequest",
      "file": "app/Http/Requests/CreateOrderRequest.php",
      "line": 15,
      "payload_props": ["customer_id", "items", "payment_method"]
    },
    {
      "stage": "controller",
      "symbol": "OrderController@store",
      "file": "app/Http/Controllers/OrderController.php",
      "line": 28,
      "relationship": { "kind": "calls", "derivation": "source" }
    },
    {
      "stage": "service",
      "symbol": "OrderService@createOrder",
      "file": "app/Services/OrderService.php",
      "line": 54,
      "relationship": { "kind": "calls", "derivation": "source" }
    },
    {
      "stage": "repository",
      "symbol": "orders",
      "table": "orders",
      "schema_file": "database/migrations/2026_01_01_create_orders_table.php",
      "columns_summary": "id, customer_id, total_amount, status"
    }
  ],
  "summary": "[ENTRYPOINT] POST /api/v1/orders -> OrderController@store -> OrderService@createOrder -> orders (table)"
}
```

### Ambiguity Recovery
When multiple route handlers match a query (e.g., across API versions), Septum does not guess arbitrarily. Instead, it returns `status: "ambiguous"` with candidate options in `alternatives`:
```json
{
  "status": "ambiguous",
  "found": false,
  "query": "POST /orders",
  "candidate_count": 2,
  "alternatives": [
    { "controller": "V1\\OrderController", "file": "app/Http/Controllers/V1/OrderController.php" },
    { "controller": "V2\\OrderController", "file": "app/Http/Controllers/V2/OrderController.php" }
  ],
  "message": "Multiple route handlers match query 'POST /orders'. Narrow your query using 'controller_file'."
}
```
The AI agent simply re-executes the tool call providing `controller_file` to target the intended controller.
