export const SEPTUM_RULES_TEMPLATE = `# RULE: Septum-MCP Backend Architectural & Structural Intelligence Engine

## 1. Directive & Core Mission
Prioritize using \`septum\` MCP tools over performing raw text searches (\`grep_search\`, \`find_by_name\`, or reading full files via \`read_file\`) when analyzing backend architecture, controllers, execution flows, and module boundaries:
- **TypeScript / Node.js** (NestJS, Express, Fastify, Hono, Elysia)
- **PHP** (Laravel, Symfony)
- **Python** (FastAPI, Django, Flask)
- **Go** (Standard HTTP, Gin, Echo, Chi, Fiber)
- **Rust, C#, Java, Ruby**

An embedded database (\`.septum/septum.db\`) maintains the Single Source of Truth (SSOT) for the project symbol table, call graph, and dependency graph. Code modifications must respect module boundaries and reuse existing abstractions.

## 2. Tool Routing Matrix

| Backend Scenario | Septum MCP Tool | Advantage vs Raw File Reading |
|---|---|---|
| Exploring domains, layers, or file inventories | \`septum_map({ action: "catalog", detail_level: "compact" })\` | Instant macro architecture overview without dumping thousands of lines of source code. |
| Tracing route execution, controller actions, or jobs | \`septum_slice({ query: "<route|controller@action>", max_depth: 5 })\` | Extracts pure vertical execution chain (Ingress -> Controller -> Service -> DB) without reading 20 controller files. Scale up to \`max_depth: 8\` for deep event/queue traces. |
| Locating function, class, or struct declarations | \`septum_symbol({ action: "locate", query: "<name>" })\` | Pinpoints exact file path and line coordinates in milliseconds via Damerau-Levenshtein fuzzy matching. |
| Inspecting implementation logic & type contracts | \`septum_symbol({ action: "context", query: "<SymbolName>", file_path: "<path>" })\` | Delivers focused AST slice bounded to 16 KB closure; use \`include_source: false\` for signatures and dependencies only. |
| Assessing refactoring blast radius before editing | \`septum_symbol({ action: "impact", query: "<SymbolName>" })\` | Discovers all direct callers (\`inbound_callers\`) and dependent modules before altering public signatures. |
| Pre-flight import validation before writing code | \`septum_boundary({ scope: "file", file_path: "<path>", proposed_imports: [...] })\` | Simulates architectural compliance and prevents circular/forbidden dependencies before touching disk. |
| Post-edit audit before git commit | \`septum_boundary({ scope: "staged" })\` | Verifies Git index snapshot against domain rules without interference from unstaged files; use \`scope: "all"\` for full audits. |

## 3. Protocol & Execution Principles (Selective Context & Map First)
- **Map First, Inspect Selectively:** Survey domain topology using \`septum_map({ action: "catalog", domain: "<domain_name>", detail_level: "compact" })\` before opening specific files. Review imported modules (\`connections.imports_from\`) and consumer count (\`connections.imported_by_count\`).
- **Inspect Contracts Over Bodies:** When discovering service interfaces, call \`septum_symbol\` with \`action: "context"\` or \`include_source: false\` to inspect method signatures and injected dependencies without code bloat.
- **No Blind Probing:** Never read a 1,000-line controller or service file from line 1. Slice it via \`septum_slice\` or extract the target symbol slice via \`septum_symbol\`.
- **Pre-Refactor Impact Verification:** Always inspect \`inbound_callers\` with \`septum_symbol({ action: "impact", query: "ClassNameOrFunction" })\` before modifying method parameters or public function contracts.
- **Pre-Flight Boundary Simulation:** Always validate candidate cross-module imports via \`septum_boundary({ scope: "file", file_path: "src/modules/order/service.ts", proposed_imports: ["../billing/service"] })\` before adding import statements.
- **Verify Against Circular Dependencies & Leaks:** Run \`septum_boundary({ scope: "staged" })\` prior to committing changes. If the check returns \`rejected\` (due to \`forbidden_dependency\`, \`disallowed_dependency\`, or \`circular_dependency\`), refactor the import hierarchy to preserve clean dependency inversion.
- **Executable-Only Execution Flow:** \`septum_slice\` returns true executable components (\`class\`, \`function\`, \`method\`, \`struct\`); non-executable types and constants are excluded.
- **Fullstack Bridge (Strata -> Septum):** When receiving \`backendTargetHint\` from Strata (Frontend), route it immediately to \`septum_slice({ query: "<endpoint|suggestedSymbol>" })\` or \`septum_symbol({ action: "context", query: "<symbol>" })\` for seamless end-to-end tracing.
`;
