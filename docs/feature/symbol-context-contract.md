# Feature SSOT: Symbol Context & In-Memory TypeScript Compiler Host

## 1. Background & Business Requirements

The primary purpose of the `context` action in `septum_symbol` is to provide target implementation slices along with **type and DTO declaration contracts** without injecting entire repositories or massive `node_modules` dependencies into the AI model's context window:
1. **Separation of Evidence:** Files, imports, method calls, and type contracts carry distinct evidential weight.
2. **Strict Memory Budgets:** Prevents token exhaustion by enforcing bounded byte limits (default: 16 KiB, range: 2 KiB – 2 MiB) and paginated continuation tokens.
3. **Public Interface Contracts:** Rather than including method bodies or private fields from referenced classes, Septum projects public instance signatures of relevant classes and DTOs.

---

## 2. Retrieval Policy (`referenced-typescript-declarations/v4`)

Regulated by the [context.ts](../../src/core/retrieval/context.ts) and [typescript-references.ts](../../src/core/retrieval/typescript-references.ts) engines:

1. **File Format Support:**
   Supports `.ts`, `.mts`, and `.cts` targets. For other formats (`.php`, `.py`, `.go`), queries route to bounded inspection mode (`source_start_line`, `source_line_limit`).
2. **Precise Line Spans & Content Hashing:**
   Retrieves target implementations with 1-based inclusive line spans and SHA-256 hashes validated directly against disk. Declarations exceeding byte budgets are delivered as paginated fragments reconstructible via `continuation` tokens.
3. **In-Memory TypeScript Compiler Host:**
   Septum constructs an in-memory compiler program (`noLib: true`, `noResolve: true`) avoiding disk thrashing and global library resolution overhead.
4. **Local Reference Traversal & Import Bindings:**
   The engine maps local declaration identifiers, helper functions, constants, named imports, aliases, defaults, and type-only bindings. Traversal is constrained to 3 import edge hops (maximum 64 files, 256 items, and 8 MiB source).
5. **Type-Only Class Signature Projection:**
   Supporting classes imported as types are projected into clean public interface contracts:
   * Constructor bodies, private/protected/static members, and initializers are stripped.
   * Public properties, methods, accessors, and constructor-promoted parameters are preserved.
   * Unknown or complex inferred types are conservatively denoted as `unknown`.
6. **Call Argument Branch Pruning:**
   When local call arguments match known literal values, the binder prunes dead conditional branches, generating concise, focused context for AI agents.

---

## 3. Invocation Format & Options Schema

```json
{
  "action": "context",
  "query": "submitOrder",
  "file_path": "src/services/order.service.ts",
  "budget_bytes": 32768
}
```

### Configuration Options:
* `budget_bytes`: Output byte quota (default: 16,384 bytes, range: 2,048 – 2,097,152 bytes).
* `continuation`: Base64url continuation token to retrieve subsequent context pages when content exceeds the budget.
* `include_source`: Whether to include symbol implementation source code (default: `true`).
* `source_line_limit`: Maximum number of source lines returned (default: 120 lines).

---

## 4. Context Output Structure

Results returned to the AI agent follow a structured schema:

1. **`source`:** Target implementation slice and directly referenced local helpers (`reason: "target_implementation"` or `"local_dependency"`).
2. **`type_contract`:** Projected public interface contracts for imported classes and DTOs (`projection: "public_instance_signatures"`).
3. **`relationship`:** Relevant import edge metadata connecting the target file to outside modules.
4. **`selection`:** Branch pruning diagnostics reflecting verified arguments (`known_call_arguments`).
5. **`diagnostic`:** Explicit advisories when resource thresholds are reached (`analysis_file_limit`, `side_effect_import_not_expanded`, or `source_differs_from_index`).

---

## 5. Relationship with Other Septum Features

* [septum-symbol.md](./septum-symbol.md): Defines public MCP tool interfaces for `locate`, `context`, and `impact` actions.
* [workspace-lifecycle.md](./workspace-lifecycle.md): Governs SQLite lifecycle, content hashing, and cache invalidation when type definitions (`types.ts`) or barrel exports (`index.ts`) are modified.
