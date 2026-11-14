# Feature SSOT: `septum_boundary` (Architectural Boundary & Circular Dependency Guard)

## 1. Background & Business Requirements

AI Coding Agents often prioritize immediate local problem-solving (making code run) without evaluating long-term architectural integrity. This frequently causes **Architectural Drift**:
1. **Module Boundary Leaks:** An isolated domain (e.g., *Ordering*) directly imports internal services from another domain (*Billing*), violating *Dependency Inversion* and *Hexagonal / Clean Architecture* principles.
2. **Circular Dependencies:** File A imports File B, and File B imports File A, leading to runtime deadlocks, memory leaks, or module initialization failures.

`septum_boundary` operates as an AST-powered **Architectural Circuit Breaker** that verifies import compliance both before and after code modifications.

---

## 2. Four Violation Rules

The `BoundaryEvaluator` engine ([evaluator.ts](../../src/core/boundary/evaluator.ts)) evaluates 4 core rules:

### 1. `forbidden_dependency` (Hard Violation)
Triggered when a domain is explicitly prohibited from importing a target domain in the configuration:
```json
{
  "domains": {
    "ordering": {
      "forbidden_dependencies": ["billing"]
    }
  }
}
```
If any file within `ordering` imports a file from `billing`, Septum rejects the change immediately and requires decoupled communication via events/messaging or shared interfaces.

### 2. `disallowed_dependency` (Strict Mode)
When `settings.enforcement = "strict"`, a domain is **only permitted** to import domains explicitly listed in `allowed_dependencies`. All imports targeting unlisted domains are treated as boundary violations.

### 3. `circular_dependency` (Cycle Detection)
Detects import loops using Depth-First Search (DFS):
* **Domain Cycles:** Domain A $\to$ Domain B $\to$ Domain A.
* **File Cycles:** `serviceA.ts` $\to$ `serviceB.ts` $\to$ `serviceA.ts`.
* **Smart Type-Only Import Erasure:** Septum ignores type-only imports (`import type { ... }` in TypeScript) during circular dependency evaluation, as type definitions are erased at compile time and do not induce runtime cycles.

### 4. `unmapped_domain`
Triggered when a source file imports an internal path that sits outside any recognized domain defined in the project configuration.

---

## 3. Three Operational Scopes

### A. Pre-Flight Proposal Mode (`scope: "file"`)
Used by AI agents **before writing changes to disk** to simulate whether candidate imports satisfy architectural rules:

```json
// Request
{
  "file_path": "src/modules/ordering/order.service.ts",
  "proposed_imports": ["../billing/billing.service"]
}

// Response (Rejected)
{
  "status": "rejected",
  "total_violations": 1,
  "circular_dependencies_count": 0,
  "violations": [
    {
      "file": "src/modules/ordering/order.service.ts",
      "line": 1,
      "source_domain": "ordering",
      "target_domain": "billing",
      "imported_target": "../billing/billing.service",
      "rule": "forbidden_dependency",
      "message": "Forbidden cross-domain dependency detected: 'ordering' is strictly prohibited from importing domain 'billing'."
    }
  ]
}
```

### B. Git Staged Audit Mode (`scope: "staged"`)
Freezes the Git index as a tree before analysis ([staged-auditor.ts](../../src/core/boundary/staged-auditor.ts)). Source and interpretation inputs are read from that snapshot, including unchanged source needed to resolve imports and cycles. Binary assets are inventoried without materializing their bytes or applying the source-size cap to them.
* Reports violations relevant to changed files; manifest changes can widen the affected scope.
* Unresolved or unsupported evidence yields `unknown`; approval applies to the analyzed static scope and does not certify runtime behavior.
* Snapshot file-count/total-byte limits and source-size limits remain enforced. Symlinks and submodules are conservatively rejected.

```json
// Request
{ "scope": "staged" }

// Response (Approved)
{
  "status": "approved",
  "scope": "staged",
  "total_checked": 3,
  "total_violations": 0,
  "circular_dependencies": [],
  "domain_violation_breakdown": {},
  "violations": [],
  "message": "All 3 staged file(s) approved. No boundary violations detected."
}
```

### C. Full Codebase / Domain Scope (`scope: "all"` or `scope: "domain"`)
Incomplete-resolution output includes up to ten relationship examples, total/returned/omitted accounting, reason counts and a recovery hint. A resolved import can still yield `unknown` if its target source is not indexed; registering/indexing the target root can resolve that uncertainty. Sampling diagnostics does not change the underlying decision.
Executes a comprehensive audit across the entire SQLite dependency graph to ensure ongoing architectural health across the repository.
