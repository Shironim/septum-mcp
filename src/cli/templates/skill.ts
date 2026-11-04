export const SEPTUM_MAP_SKILL_TEMPLATE = `---
name: septum-map
description: Framework-agnostic codebase architecture and dependency graph analysis. Use when initializing project boundaries, inspecting the symbol table, validating cross-module imports, or reviewing static analysis check results.
---

# \`septum-map\` — Codebase Architecture & Static Analysis

> **Core Principle:** Static analysis indexes AST declarations and dependency graphs to provide deterministic structural evidence. Treat index data as static structural facts, not full runtime trace validation.

## Scope

Use this skill to navigate the project architecture, verify module boundaries, locate reusable symbols, trace execution flows, and validate dependency rules. This skill guides architectural compliance; domain business decisions remain governed by project specifications.

## Tool & Command Reference

The active MCP schema and \`septum --help\` represent the authoritative interface contracts:

| Tool | Capability | Considerations |
|---|---|---|
| \`septum_domain\` | \`catalog\` inspects module architecture (supports \`detail_level: "compact"\`); \`register\` defines domain roots; \`topology\` logs infrastructure layers. | One owner per physical root. On conflict, update the named owner or explicitly move a domain to a distinct root; nested domains remain allowed. Registration mutates database state. |
| \`septum_symbol\` | \`locate\`, \`inspect\`, \`context\`, \`impact\`, or \`hotspots\`. | \`context\` selects a TypeScript target and bound local/import references up to three import edges, with byte budget, hashes and omissions. Impact is partial; imports do not prove calls. |
| \`septum_slice\` | Navigates static context from supported entrypoints; \`max_depth\` bounds import expansion. | Ambiguity returns candidates without selecting a chain: narrow query and copy \`controller_file\`. Read relationship kind/derivation, coverage and diagnostics. Exact confidence applies only to target matching; missing edge evidence is unknown. |
| \`septum_boundary\` | Default check uses file/staged/domain/all scopes. Action plan checks per-file changes and saves a baseline; verify compares subsequent worktree/index deltas to plan_ref. | Plans are not human approval. dry_run previews do not save. Verify covers worktree policy; a different staged blob still needs a staged audit. |
| \`septum_feature\` | \`get\` retrieves active task context; \`lock\` registers task touchpoints; \`release\` clears locks. | Restricts edits to authorized module touchpoints during concurrent development sessions. |

Common CLI commands: \`septum init\` initializes project configuration and agent hooks; \`septum sync\` updates the AST index; \`septum check\` runs static boundary checks on staged or workspace files.

For TypeScript changes, locate the target first, then call \`septum_symbol(action: "context", symbol_ref: <returned reference>, budget_bytes: 65536)\`. Read freshness, completeness and omissions before editing. Context v2 follows supported local and named/default/type-only import bindings up to three import edges in .ts/.mts/.cts; TSX, namespace/barrel expansion and full business closure are outside this policy. Copy continuation with the same target/budget; stale tokens require new retrieval. Use bounded inspect for oversized declarations and impact separately for consumers. Context does not acquire feature locks.

Locate/inspect/impact return \`retrieval\` evidence. Compare \`retrieval.target_id\` with \`context.target_id\` for the same workspace/declaration version, then check source hashes, freshness scope, reasons and implementation revisions. Current selected source does not certify caller/dependency freshness or complete analysis. Treat input IDs as evidence identities, not continuation tokens; ambiguous/stale references have no selected target ID.

## Architectural Review Workflow

1. **Verify Project Context:** Ensure working directory is aligned. Check that \`.septum/septum.db\` is present. Pass \`workspace_path\` when operating in multi-root workspaces.
2. **Inspect Module Inventory:** Query the domain catalog to determine registered modules, AST index status, and file coverage metrics. If files are marked unsupported or skipped, note partial coverage.
3. **Differentiate Evidence from Assumptions:** Use concrete AST symbols, public exports, and declared configuration as evidence. Never guess interfaces or assume unverified dependencies.
4. **Identify Reusable Components:** Search existing services, models, and utility classes before introducing new declarations to adhere to the DRY principle.
5. **Analyze Refactoring Blast Radius:** Check inbound callers (\`septum_symbol impact\`) before modifying public method signatures or removing exported declarations.
6. **Plan Before Editing:** Call \`septum_boundary({action:"plan",changes:[{file_path:"src/orders.ts",proposed_imports:["./shared"]}]})\` using actual paths/import targets. Declare each file separately; use operation delete for intended deletions. Save the returned plan_ref. One saved plan replaces the previous workspace plan; it includes pre-existing dirty state and excludes Git-ignored files/Septum state.
7. **Verify Actual Changes:** Call \`septum_boundary({action:"verify",plan_ref:<returned reference>})\` after edits. Resolve outside-plan paths, undeclared imports, incomplete analysis and policy/session changes. Run scope staged before committing and application checks for business behavior. Verification never changes its baseline automatically.

## Interpreting Analysis Results

- \`approved\`: No architectural violations or circular dependencies detected within the evaluated scope.
- \`rejected\`: A boundary violation (\`forbidden_dependency\`, \`disallowed_dependency\`, or \`circular_dependency\`) occurred. The import hierarchy must be refactored.
- \`unknown\` or partial index status: Indexing is incomplete; review unsupported files before concluding compliance.
- \`stale_plan\`: Policy/session/revision changed or the saved plan was replaced; review and create a new plan.
- Absence of a symbol: No match in the analyzed index/capability; investigate spelling, index state and unsupported patterns before concluding that implementation is absent.

## Standardized Reporting Format

When summarizing architectural checks:
- **Scope & Action:** Audited file path or module, tool invoked, and whether database state was modified.
- **Structural Evidence:** Exact symbol declarations, caller counts, or dependency paths identified.
- **Status & Violations:** Clear pass/fail outcome with specific rule violations or circular dependency paths if detected.
- **Recommended Action:** Remediation steps (e.g. dependency inversion, extracting shared interfaces, or reusing existing utilities).
`;
