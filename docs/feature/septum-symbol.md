# Feature SSOT: `septum_symbol` (AST Symbol Intelligence & Blast Radius)

## 1. Background & Business Requirements

AI Coding Agents performing code modifications frequently struggle with 3 critical limitations:
1. **Coordinate Blindness:** Agents struggle to pinpoint exact line numbers of functions or classes without brute-force `grep`, especially when identical method names exist across multiple files.
2. **Token Bloat vs. Hollow Slicing:** Reading an entire 1,000-line controller file rapidly exhausts token budgets. Conversely, reading only a 3-line delegating wrapper method (`return this.service.handle()`) starves the agent of essential business logic.
3. **Refactoring Blast Radius Blindness:** Altering public parameters or function contracts without discovering all upstream call sites across the codebase introduces regressions and breaks dependent modules.

`septum_symbol` serves as the primary AST symbol intelligence tool, offering 3 core sub-operations (*actions*): `locate`, `context`, and `impact`.

---

## 2. Sub-Operation 1: `action: "locate"` (Precision Coordinate Discovery)

### Internal Mechanics & Algorithms
1. **Error Log & Stack-Trace Parser:**
   AI agents can pass raw error messages directly from compiler or runtime output. The parser isolates the container class and target method ([symbol-locator.ts](../../src/core/resolver/symbol-locator.ts)):
   * `"Call to undefined method App\Http\Controllers\OrderController::calculateTotal()"` $\to$ Container: `OrderController`, Member: `calculateTotal`.
   * `"'OrderService' object has no attribute 'calculate_total'"` $\to$ Container: `OrderService`, Member: `calculate_total`.
   * Flexible syntax: `OrderController::store`, `OrderService->calculateTotal`, `OrderService.calculateTotal`, or bare `calculateTotal`.
2. **Multi-Signal Similarity Engine (0.0 – 1.0):**
   When typos occur, Septum calculates a combined similarity score:
   * **Damerau-Levenshtein Distance:** Handles typos and character transpositions.
   * **Token Jaccard Similarity:** Deconstructs identifiers across *CamelCase*, *snake_case*, *kebab-case*, and namespace segments.
   * **Prefix & Substring Bonus:** Grants extra weight for partial name matches.
3. **Sibling Methods & Suggestions:**
   If a symbol is absent from the target container, Septum returns `sibling_methods` (other methods defined in the same container).
4. **Just-In-Time (JIT) Delta Sync:**
   If a file changed on disk since the previous sync, Septum reparses it on-the-fly so `start_line` and `end_line` coordinates remain accurate.

### Input & Output Schema
```json
// Request
{
  "action": "locate",
  "query": "OrderController::calculateTotal"
}

// Response
{
  "found": true,
  "query": "OrderController::calculateTotal",
  "file_path": "app/Http/Controllers/OrderController.php",
  "container_name": "OrderController",
  "exact_symbol": {
    "name": "calculateTotal",
    "kind": "method",
    "signature": "public function calculateTotal(OrderRequest $request): JsonResponse",
    "visibility": "public",
    "start_line": 52,
    "end_line": 78,
    "total_lines": 27
  },
  "sibling_methods": ["index", "store", "show", "cancel"]
}
```
*(Note: If a symbol exceeds the 300-line threshold, `complexity_smell` is emitted with `is_high_complexity: true` and `threshold: 300`.)*

---

## 3. Sub-Operation 2: `action: "context"` (Bounded Slicing & DTO Extraction)

### Internal Mechanics & Algorithms
`action: "context"` (or alias `"inspect"`) accepts explicit `context_mode: "deep" | "source"`. Without that option, legacy automatic selection by language and bounded options remains available. Responses identify the selected mode:
1. **In-Memory TypeScript Compiler Host (`.ts`, `.mts`, `.cts` when bounded line options are omitted):**
   Runs the `referenced-typescript-declarations/v4` policy ([context.ts](../../src/core/retrieval/context.ts)) within a strict byte budget (`budget_bytes`, default: 16 KB), returning `items` (`source`, `type_contract`, `relationship`, `selection`, `diagnostic`) and pagination `continuation` tokens (see [symbol-context-contract.md](./symbol-context-contract.md)).
2. **Bounded Source Slicing (Polyglot files or when `include_source` / `source_line_limit` is specified):**
   Extracts only the requested symbol lines (default limit: 120 lines, max: 200 lines) via [get-symbol.ts](../../src/mcp/tools/get-symbol.ts).
3. **Anti-Hollow Slicing (1-Hop Transitive Delegator Expansion):**
   If a polyglot/bounded method ($\le 15$ lines, or `semantic_depth: 2`) is a thin delegate to an injected dependency across PHP (`$this->prop->method(`), TypeScript/JS (`this.prop.method(`), Python (`self.prop.method(`), Go (`recv.prop.Method(`), or static calls (`Class::method(`):
   ```php
   public function calculate(OrderRequest $request) {
       return $this->orderService->calculateTotal($request->validated());
   }
   ```
   Septum inspects constructor/field/type-hint DI bindings, identifies `OrderService`, and **automatically embeds the target method's implementation** (`delegated_implementation`) in the same response without requiring a second tool call.
4. **Dependency & Outbound Call Resolution:**
   When `include_source: false` (signature/contract inspection mode), lists injected services (`dependencies_injected`) and resolved external method invocations (`outbound_calls`, `resolved_outbound_calls`).

### Input & Output Schema (Bounded Polyglot Mode)
```json
// Request
{
  "action": "context",
  "query": "OrderController::calculateTotal"
}

// Response
{
  "symbol": "OrderController::calculateTotal",
  "kind": "method",
  "file_path": "app/Http/Controllers/OrderController.php",
  "exact_range": {
    "start_line": 52,
    "end_line": 78,
    "total_lines": 27
  },
  "source_slice": {
    "status": "current",
    "file_path": "app/Http/Controllers/OrderController.php",
    "start_line": 52,
    "end_line": 78,
    "text": "public function calculateTotal(OrderRequest $request): JsonResponse {\n    $total = $this->orderService->calculateTotal($request->validated());\n    return response()->json(['total' => $total]);\n}",
    "related_dependency_analysis": "delegated_implementation_expanded",
    "delegated_implementation": {
      "symbol": "OrderService::calculateTotal",
      "file_path": "app/Services/OrderService.php",
      "start_line": 80,
      "end_line": 105,
      "text": "public function calculateTotal(array $payload): float {\n    // Concrete calculation implementation in Service...\n}"
    }
  }
}
```

---

## 4. Sub-Operation 3: `action: "impact"` (Blast Radius & Inbound Callers)
`call_sites` separately reports supported TypeScript/JavaScript identifier calls bound to a named import, including aliases. Comments, strings and locally shadowed bindings are excluded by AST symbol identity. Method dispatch and namespace/default imports without a proven binding remain limited; this is not a complete caller graph. `inbound_callers` retains legacy evidence for compatibility. Risk remains advisory and explicitly states its scope.


### Internal Mechanics & Algorithms
1. **Inverse Dependency, Same-File & Same-Package Traversal:**
   Scans the repository for all files that import the file declaring the target symbol, plus same-file callers (outside the target symbol's own declaration line span) and same-package/namespace files in `.go`, `.php`, `.java`, and `.cs` that invoke the target without explicit import statements.
2. **Batch Enclosing Symbol Resolution (Zero N+1 Query):**
   Septum loads symbols from calling files in a single batch SQLite query to resolve callers: *“Which method encloses line 115?”* Output provides concrete caller method identifiers rather than plain line numbers.
3. **Method-Level Invocation Hints:**
   Import dependencies are returned separately from lexical caller hints. Matching the following syntax does not prove receiver identity, runtime dispatch or a complete caller set:
   * `->methodName(` (PHP)
   * `.methodName(` (TypeScript, JavaScript, Python, Go)
   * `::methodName(` (Static calls in PHP, C++)
4. **Regression Risk Level Calculation:**
   * **`low`:** Invoked by < 2 files within the same domain.
   * **`medium`:** Invoked by 2–5 files or spans 2 domains.
   * **`high`:** Invoked by > 5 files or spans > 2 architectural domains.

Caller scanning and risk calculation live in `core/resolver/symbol-impact.ts`; database candidate queries remain in `DependencyRepository`. Results retain `coverage: "partial"` and `inbound_callers_complete: false`. Per-target `capabilities` distinguish declaration extraction, import resolution, source/deep context and heuristic caller analysis.

### Input & Output Schema
```json
// Request
{
  "action": "impact",
  "query": "OrderService::cancelOrder"
}

// Response
{
  "target_symbol": "OrderService::cancelOrder",
  "found_in_index": true,
  "impact_summary": {
    "total_dependents": 3,
    "risk_level": "medium",
    "affected_files_count": 2
  },
  "inbound_callers": [
    {
      "file": "app/Http/Controllers/OrderController.php",
      "caller": "OrderController@cancel",
      "line": 85,
      "kind": "method",
      "domain": "ordering"
    },
    {
      "file": "app/Jobs/ExpireUnpaidOrdersJob.php",
      "caller": "ExpireUnpaidOrdersJob@handle",
      "line": 42,
      "kind": "method",
      "domain": "ordering"
    },
    {
      "file": "app/Http/Controllers/Admin/OrderAdminController.php",
      "caller": "OrderAdminController@forceCancel",
      "line": 120,
      "kind": "method",
      "domain": "admin"
    }
  ]
}
```

---

## 5. Programming Language Support

`septum_symbol` provides full AST symbol navigation for:
* **TypeScript & JavaScript:** Classes, methods, arrow functions, interfaces, type aliases, enums.
* **PHP (Laravel & Symfony):** Classes, Traits, Interfaces, Enums, Constructor Property Promotion (PHP 8), Attributes.
* **Python (FastAPI, Django, Flask):** Classes, async/sync defs, Pydantic models.
* **Go (Golang):** Structs, Interfaces, standalone functions, method receivers (`func (s *Service) Method()`).
* **Rust, C#, Java, Ruby:** Native declaration indexing for structs, classes, and methods via Tree-Sitter WASM grammars.
