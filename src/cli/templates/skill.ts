export const USE_SEPTUM_SKILL_TEMPLATE = `---
name: use-septum
description: >-
  Route backend code exploration, symbol navigation, call-graph tracing, blast-radius analysis, and architectural boundary validation using Septum MCP tools (septum_map, septum_symbol, septum_slice, septum_boundary). Use when analyzing unfamiliar backend codebases, inspecting function and class declarations without full-file overhead, tracing end-to-end execution flows, evaluating refactoring blast radius, or validating dependency constraints before and after code changes.
---

# use-septum — Backend AST Static Analysis & Architectural Routing

Septum provides Abstract Syntax Tree (AST) indexing, call-graph analysis, and static boundary validation for backend architectures across TypeScript, JavaScript, PHP, Python, Go, Rust, Java, C#, and Ruby.

---

## 1. Core Architectural Principles & Rationale

### Selective Context Retrieval vs. Full-File Reads
Reading entire source files via file-reading tools creates two major failure modes:
1. **Working Memory Dilution:** Large blocks of boilerplate, markup, or unrelated methods consume context capacity and dilute attention on the target problem.
2. **Context Poisoning:** Ingesting legacy or non-standard implementation patterns in surrounding code increases the likelihood of replicating those anti-patterns in new code.

AST-based symbol extraction retrieves the target declaration, its local helper functions, and imported type contracts within a bounded 16 KB context window (\`budget_bytes: 16384\`), leaving full-file reads strictly as a fallback for wide-scope rewrites. For signature-only inspection, pass \`include_source: false\` to save over 85% tokens.

### Static Call Graph vs. Dynamic Runtime Behavior
- **Exact vs. Inferred Confidence:** Static AST parsers extract explicit signatures and direct imports with exact confidence. Inferred matches rely on framework naming conventions. Always verify coordinate boundaries (\`file:line\`) before refactoring.
- **Dynamic Dispatch Limits:** Static analysis detects declared references. Dynamic reflection, runtime dependency injection containers, service locators, and dynamic route registrations cannot be fully resolved statically. A \`not_found\` static query result indicates absence from the static index, not runtime non-existence.
- **Executable-Only Execution Flow:** \`septum_slice\` execution chains are strictly filtered to executable logic (\`class\`, \`function\`, \`method\`, \`struct\`, \`trait\`), eliminating non-executable constants and type interface noise.
- **Coverage Status:** When index coverage is marked \`partial\` or files are reported as skipped, treat unresolved dependencies as open operational risks.

### Dependency Constraints & Blast Radius
- **Interface Stability:** Modifying public class methods, function signatures, or data-transfer objects (DTOs) requires prior identification of all inbound call sites (\`inbound_callers\`) to prevent regression.
- **Layering & Inversion of Control:** Cross-module imports must adhere to declared domain boundaries. Circular dependencies and unauthorized cross-domain coupling must be detected and prevented before code is written.

---

## 2. Intent-to-Tool Routing Table

| Engineering Intent | MCP Tool & Action | Primary Arguments | Operational Output & Scope |
|---|---|---|---|
| **Survey domain architecture & package topology** | \`septum_map\` | \`action: "catalog"\`, \`detail_level: "compact"\` | Bounded inventory of registered domains, root directories, file counts, and dependency policies. |
| **Inspect domain file inventory & exported symbols** | \`septum_map\` | \`action: "catalog"\`, \`domain: "<name>"\`, \`detail_level: "compact"\` | File listing and bounded export declarations for a specific bounded context. |
| **Declare or update domain boundary constraints** | \`septum_map\` | \`action: "register"\`, \`domain: "..."\`, \`root: "..."\`, \`allowed_dependencies: [...]\`, \`forbidden_dependencies: [...]\` | Configures architectural boundaries and permitted import paths for a domain root. |
| **Locate symbol declaration coordinates** | \`septum_symbol\` | \`action: "locate"\`, \`query: "<SymbolName>"\` | Exact file path, line numbers, and unique \`symbol_ref\` identifier. |
| **Extract focused symbol implementation & types** | \`septum_symbol\` | \`action: "context"\` (or \`"inspect"\`), \`query: "..."\`, \`file_path: "..."\` | AST slice containing the symbol declaration, local helper functions, and imported type contracts (bounded to 16 KB closure). For bounded inspection, set \`include_source: false\` (signatures/DI only) or \`source_line_limit?: 120\`. For deep TypeScript context, pass \`budget_bytes?: 16384\` (do not combine with \`include_source\`). |
| **Analyze inbound callers & refactoring blast radius** | \`septum_symbol\` | \`action: "impact"\`, \`query: "<SymbolName>"\` | Direct inbound call sites (\`inbound_callers\`), dependent classes, and external module consumers. |
| **Trace end-to-end vertical execution slice** | \`septum_slice\` | \`query: "<route|controller@method|JOB <Name>|CLI <Cmd>|EVENT <Listener>|intent>"\`, \`max_depth?: 5\`, \`controller_file?: "..."\` | Control flow trace from ingress layer (HTTP, CLI, Queue, Event) through services and repositories to persistence. Strictly returns executable nodes without non-executable constants or types. |
| **Pre-flight import validation before editing** | \`septum_boundary\` | \`scope: "file"\`, \`file_path: "..."\`, \`proposed_imports: [...]\` | Validates candidate import statements against domain boundary rules before writing to disk. |
| **Post-change static validation before committing** | \`septum_boundary\` | \`scope: "staged"\` | Audits staged git index for boundary rule violations, forbidden imports, and circular dependencies; use \`scope: "all"\` for codebase-wide audits. |

---

## 3. Decision Workflow

Follow this sequence during backend development tasks:

\`\`\`
[0. Fullstack Handoff (from Strata)]
  Received backendTargetHint from Strata (Frontend)?
  ├── YES ──► Execute septum_slice(query: hint.suggestedSymbols[0] || route)
  └── NO  ──► Proceed to Discovery or Entrypoint identification

[1. Discovery]
  Need to understand domain layout or module boundaries?
  ├── YES ──► Execute septum_map(action: "catalog", detail_level: "compact")
  └── NO  ──► Proceed to entrypoint identification

[2. Flow Tracing & Targeted Inspection]
  Tracing a request path, controller action, or job handler?
  ├── YES ──► Execute septum_slice(query: "<route|handler>")
  └── NO  ──► Proceed to symbol retrieval

  Need to inspect logic or interface definitions?
  └── ALWAYS ──► Execute septum_symbol(action: "context", query: "...", file_path: "...")
                 Pass include_source: false if only checking method signatures or injected dependencies.
                 Do not read entire files unless performing broad multi-region refactoring.

[3. Impact Analysis & Pre-Flight Validation]
  Changing a public function signature, class method, or schema?
  └── ALWAYS ──► Execute septum_symbol(action: "impact", query: "...") to check inbound callers.

  Introducing a new cross-module or package import?
  └── ALWAYS ──► Execute septum_boundary(scope: "file", file_path: "...", proposed_imports: [...])

[4. Implementation & Verification]
  Apply targeted, minimal edits to source files.
  └── Execute septum_boundary(scope: "staged") to verify zero boundary violations and zero circular dependencies.
\`\`\`

---

## 4. Operational Boundaries & Diagnostic Verdicts

1. **Context Window Management:**
   - Always prioritize \`septum_symbol(action: "context")\` over reading raw source files.
   - Use \`include_source: false\` when inspecting signatures, member lists, or injected dependencies to maximize token preservation.
   - When a result contains a \`continuation_token\`, pass it to retrieve subsequent pages instead of estimating missing members.
2. **Boundary Audit Status Handling:**
   - \`status: "approved"\`: Zero architectural rule violations or circular dependency cycles found in the analyzed scope. Proceed with changes.
   - \`status: "rejected"\`: Boundary constraint violated:
     - \`forbidden_dependency\`: Import target is explicitly disallowed by domain policy.
     - \`disallowed_dependency\`: Import target is not listed in permitted dependencies.
     - \`circular_dependency\`: Proposed import induces a dependency loop.
     *Resolution:* Apply dependency inversion, extract shared abstractions into a common library, or decouple via asynchronous event messaging.
   - \`status: "ambiguous"\`: Multiple symbols match the query. Provide explicit \`file_path\` or use the exact \`symbol_ref\`.
3. **Fallback Boundaries:**
   - If an unindexed file type, non-standard framework convention, or dynamic runtime reflection is encountered, use direct file inspection and verify behavior via test suites.
`;

export const SEPTUM_MAP_SKILL_TEMPLATE = USE_SEPTUM_SKILL_TEMPLATE;
