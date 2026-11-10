# Feature SSOT: `septum_slice` (Vertical Execution Chain Tracer)

## 1. Latar Belakang & Kebutuhan Bisnis (Business Requirements)

Dalam arsitektur backend modern, sebuah permintaan tidak pernah berhenti di layer controller. Permintaan pengguna mengalir secara vertikal:
$$\text{Ingress (Route / HTTP / CLI / Job)} \longrightarrow \text{Guard / Middleware} \longrightarrow \text{Validation DTO} \longrightarrow \text{Controller} \longrightarrow \text{Service / Use Case} \longrightarrow \text{Repository / ORM} \longrightarrow \text{Database Table}$$

**Masalah Konvensional:**
AI agent yang ingin memahami endpoint `POST /orders` biasanya harus:
1. Menjalankan pencarian teks untuk file router.
2. Membaca router untuk menemukan controller handler.
3. Membaca controller untuk menemukan FormRequest / DTO dan method service yang dipanggil.
4. Membaca service untuk mengetahui query atau tabel database yang dimutasi.
Ini menghabiskan 5–8 tool calls terpisah dan ribuan token context window.

**Solusi `septum_slice`:**
`septum_slice` menyediakan **pelacak eksekusi vertikal end-to-end dalam satu tool call**. Engine memetakan seluruh relasi dari titik masuk (*entrypoint*) hingga lapisan persistensi data paling dalam secara deterministik.

---

## 2. Cakupan Pemicu Eksekusi (*Omni-Trigger Support*)

`septum_slice` bukan hanya pelacak HTTP route, melainkan mendukung 4 jenis pemicu sistem backend:

1. **HTTP Endpoints & REST Routes:**
   * Method + URI: `POST /api/v1/orders`, `DELETE /users/{id}`
   * URI Path: `/orders/{id}/status`, `orders` (otomatis mencocokkan parameter dinamis `{id}`, `:id`, atau `<int:id>`)
   * Named Route: `orders.store`, `admin.users.index`, `api.checkout`
2. **Background Jobs / Queue Workers:**
   * Query: `JOB ProcessOrderJob` atau `job:ProcessOrderJob`
   * Melacak: Job dispatch $\to$ Job Handler $\to$ Service $\to$ DB Transaction.
3. **CLI Commands / Console Tasks:**
   * Query: `CLI order:cleanup` atau `cli:order:cleanup`
   * Melacak: Artisan / NestJS Commander / Click CLI command $\to$ handler $\to$ business logic.
4. **Domain Events & Listeners:**
   * Query: `EVENT OrderPlacedListener` atau `event:OrderPlacedListener`
   * Melacak: Event trigger $\to$ subscriber/listener $\to$ side effect (misal: notifikasi).
5. **Controller & Action Method:**
   * Query: `OrderController@store`, `OrderController::updateStatus`, atau `OrderController`.
6. **Task Intent / Natural Language:**
   * Query: `"Ubah status order di dashboard"` atau `"checkout shopping cart"`. Engine melakukan tokenisasi dan pembobotan skor kemiripan pada rute dan rantai eksekusi (`confidence: "inferred"`).

---

## 3. Arsitektur 2-Lapis (*Two-Tier Slicing Architecture*)

```
                       septum_slice(query)
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │ Lapis 1: Dedicated Framework Semantic        │
         │          Extractor (Laravel, NestJS, dll.)   │
         └──────────────────────┬───────────────────────┘
                                │
                      Ada Adapter Cocok?
                       ├── Ya ──> Ekstrak Ingress, DTO props, Controller, Service, DB Table
                       └── Tidak
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │ Lapis 2: Generic Tree-Sitter Call-Graph      │
         │          Tracer (Fallback Universal AST)     │
         └──────────────────────────────────────────────┘
```

### Lapis 1: 12 Dedicated Framework Extractors
Septum memiliki adapter semantik khusus yang memahami decorator, framework routing, FormRequest, dan ORM:
* **PHP:**
  * **Laravel:** `routes/web.php`, `routes/api.php`, FormRequest validation rules (`payload_props`), Controller, Service, Eloquent Model, dan migrasi skema tabel DB.
  * **Symfony:** PHP 8 Attributes (`#[Route]`), Controller actions, dan Doctrine Entity.
* **TypeScript / JavaScript:**
  * **NestJS:** Decorator `@Controller()`, `@Get()`, `@Post()`, `@Body() dto: CreateDto`, `@Injectable()` Services, dan TypeORM/Prisma Repositories.
  * **Express.js:** `router.post()`, middleware chaining, controller handler, dan service layer.
  * **Fastify:** Route schema (`schema.body`, `schema.params`), handler function, dan plugin encapsulations.
  * **Hono & Elysia:** Framework modern TypeScript/Bun, mendukung Zod `zValidator` dan TypeBox schemas.
  * **MCP / CLI:** Menelusuri endpoint tool MCP (`server.setRequestHandler`) dan CLI handlers.
* **Python:**
  * **FastAPI:** `@app.post()`, `@router.get()`, Pydantic `BaseModel` DTO payload, `Depends()` injection, SQLAlchemy session queries.
  * **Django:** `urls.py`, Class-based Views (`APIView`, `ModelViewSet`), DRF Serializers, dan Django ORM.
  * **Flask:** `@app.route()`, Blueprints, Marshmallow schemas, dan views.
* **Go (Golang):**
  * Mendukung 5 pola web framework Go: **Standard `net/http`**, **Gin**, **Echo**, **Chi**, dan **Fiber**.
  * Mengekstrak request struct binding (`c.ShouldBindJSON(&req)`), handler functions, service structs, dan query DB (GORM / sqlx).

### Lapis 2: Generic Call-Graph Fallback
Jika framework tidak memiliki adapter semantik khusus atau proyek menggunakan arsitektur in-house kustom, Septum mengeksekusi `CallGraphTracer` menggunakan parser AST Tree-Sitter WASM yang mencakup:
* **Rust** (`.rs`)
* **Java** (`.java`)
* **C# / .NET** (`.cs`)
* **Ruby** (`.rb`)

---

## 4. Anatomi Node Rantai Eksekusi (*Execution Chain Stages*)

Setiap node di dalam array `chain` hasil ekstraksi memiliki tipe tahapan (*stage*) yang jelas:

| Stage | Keterangan & Properti yang Dihasilkan |
|---|---|
| **`ingress`** | Titik masuk (HTTP Method, Route URI, nama Command CLI, atau nama Event). |
| **`guard`** | Middleware autentikasi, RBAC permissions, atau guard decorator (misal `@UseGuards(AuthGuard)`). |
| **`validation`** | Class DTO / FormRequest / Pydantic schema beserta daftar field payload-nya (`payload_props: ["customer_id", "items", "amount"]`). |
| **`controller` / `action`** | Class controller dan nama fungsi handler beserta nomor baris spesifik. |
| **`orchestrator` / `use_case`** | CQRS handler atau orchestrator class (pada arsitektur Clean/DDD). |
| **`service`** | Business logic service yang dipanggil oleh controller. |
| **`repository` / `entity`** | Data access layer (Repository, DAO, Prisma Client, Eloquent Model). |
| **`table`** | Nama tabel database riil dan skema migrasi tabel tersebut. |
| **`side_effect` / `event`** | Event yang di-*emit*, job yang di-*dispatch*, atau informasi transaksi database (`transactions: true`). |

---

## 5. Spesifikasi Kontrak Input & Output JSON

### Input Schema
```json
{
  "query": "POST /api/v1/orders",    // Wajib: route URI, method+URI, Controller@action, atau task intent
  "max_depth": 5,                     // Opsional: kedalaman penelusuran (1–8, default: 5)
  "controller_file": "src/orders/order.controller.ts", // Opsional: penyaring kandidat jika terjadi ambiguitas
  "workspace_path": "/path/to/project" // Opsional: target workspace
}
```

### Output Schema (Sukses)
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

### Penanganan Ambiguitas (*Ambiguity Recovery*)
Jika sebuah URI dimiliki oleh lebih dari satu handler atau controller (misalnya versi API berbeda), Septum tidak menebak sembarangan, melainkan mengembalikan `status: "ambiguous"` beserta daftar `alternatives`:
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
AI agent cukup mengulangi panggilan dengan menyertakan parameter `controller_file` untuk mengunci target yang dimaksud.
