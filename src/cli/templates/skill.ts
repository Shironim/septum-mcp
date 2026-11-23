export const USE_SEPTUM_SKILL_TEMPLATE = `---
name: use-septum
description: >-
  Inspect backend declarations, imports, domain boundaries and supported static entrypoints with Septum MCP. Use for code navigation, consumer inspection and proposed/staged import checks; inspect coverage and freshness before using results to plan edits.
---

# use-septum

Septum indexes selected source declarations, imports, domain ownership and static entrypoints. It returns static evidence and diagnostics. It does not run the analyzed application or provide a complete runtime caller graph.

## Select the tool

All 4 tools default to \`format: "text"\` (token-efficient compact markdown summary); pass \`format: "json"\` when structured JSON is required.

| Need | Request | Read from the result |
| --- | --- | --- |
| Workspace/domain/file navigation | \`septum_map\`, \`action: "catalog"\`, \`detail_level: "compact"\`, optional \`domain\`/\`file_filter\`/\`format\` | \`submodules\` + aggregated dependencies (for large domains >25 files), files/anchors, directed \`dependencies\`, static \`entrypoints\`, \`health\`, \`next\` |
| Domain policy registration | \`septum_map\`, \`action: "register"\`, \`domain\`, \`root\`, dependency lists | Recorded policy, \`policy_owner\` and any ingestion result |
| Declaration lookup | \`septum_symbol\`, \`action: "locate"\`, \`query\` | Indexed coordinates, \`symbol_ref\`, token/camelCase-ranked suggestions and retrieval freshness |
| TypeScript reference context | \`septum_symbol\`, \`action: "context"\`, \`context_mode: "deep"\`, optional \`max_depth\` (1–4, default 2) | True hop-ordered (\`hop 0→1→2\`, direct local/imported callees & contracts first) source/contracts, diagnostics, accounting and continuation |
| Source/signature inspection | \`septum_symbol\`, \`action: "context"\`, \`context_mode: "source"\` | Source slice or signature/dependency details and source status |
| Potential consumers | \`septum_symbol\`, \`action: "impact"\` | Separated \`call_sites\`, \`runtime_imports\`, \`type_only_imports\`, warnings and uncertainty |
| Supported route/handler/job/CLI/event | \`septum_slice\`, \`query\`, optional \`controller_file\`, \`max_depth\`, \`format\` | Catalog target (\`exact\` match for \`METHOD target\`), indented parent-attributed chain and diagnostics |
| Proposed imports | \`septum_boundary\`, \`scope: "file"\`, \`file_path\`, \`proposed_imports\` | Proposal decision and evaluated scope |
| Existing indexed or staged imports | \`septum_boundary\`, \`scope: "all" / "domain" / "staged"\` | Scoped violations, incomplete resolution and recovery hints |

## Context selection

Deep context supports indexed \`.ts\`, \`.tsx\`, \`.mts\` and \`.cts\` declarations. It follows bounded supported references up to \`max_depth\` import edges (default \`2\`, max \`4\`), ranks items hop-first (\`depth 0 → 1 → 2\`, direct calls and contracts ahead of transitive helpers), and can project public type contracts. It does not establish a complete business dependency closure.

Use \`budget_bytes\` and \`max_depth\` only for deep context. Do not combine them with \`include_source\`, \`source_start_line\` or \`source_line_limit\`. Those options select bounded source inspection when no explicit mode is supplied. \`inspect\` is an alias for \`context\`.

Source mode includes target source by default. Use \`include_source: false\` for signature/dependency details. When a source slice is truncated, follow \`next_start_line\`. One-hop delegation expansion (including same-file local helper delegation for polyglot files) is heuristic; inspect the selected dependency before treating it as a callee.

For deep-context pages, pass the returned \`continuation\` with unchanged target, workspace, configuration, \`max_depth\` and budget. Restart retrieval on invalid/stale continuation. Capacity omissions are distinct from pagination.

## Workflow and evidence limits

1. Use map when the target domain or file is unknown. Full map detail expands navigation selection, not declaration detail.
2. Locate a declaration and resolve ambiguity through \`file_path\` or \`symbol_ref\`. Read freshness before using indexed coordinates.
3. Retrieve the relevant source/contracts. Inspect diagnostics and omissions, and read further source when needed.
4. Before a public-contract change, inspect impact and relevant consumers. \`inbound_callers_complete: false\` means the caller list is incomplete; risk is advisory.
5. Evaluate proposed imports against policy. Proposal approval does not certify existing imports or all possible cycles.
6. Check the relevant workspace/domain/staged scope and run application checks for behavior affected by the edit.

A slice's exact match applies to its catalog target. Imports do not prove calls; static relationships do not prove execution order or runtime dispatch. Validation/schema/entity nodes are context, not a required executed sequence.

Boundary \`approved\` describes the evaluated static scope. \`rejected\` reports known violations, including \`circular_dependency\`. \`unknown\` requires inspecting or recovering missing evidence. Resolve ambiguity by narrowing the request.

Language declaration support does not imply equivalent module resolution. Rust/Cargo, Ruby requires, Java source projects and C# namespaces have bounded resolver support; dynamic loaders, macros, conditional builds and missing binary metadata remain limited.

Set \`workspace_path\` when selecting among repositories. If the MCP tools are unavailable or insufficient, use direct source inspection and appropriate project verification.

## Resources & Prompts

- **MCP Resources:** \`septum://domains\`, \`septum://health\`, \`septum://boundaries\`, \`septum://apps\`, \`ui://septum/app.html\`, and \`septum://domain/{name}\` provide workspace snapshots and the MCP App UI (append \`?workspace=\` to select a workspace; use the 4 MCP tools with \`workspace_path\` for multi-root queries).
- **MCP Prompts:** \`open-apps\`, \`audit-coupling\`, \`check-staged\`, \`plan-refactor\`, and \`trace-feature\` provide step-by-step workflow playbooks.

Describe the operation and observed result. Do not promise token savings, response speed, memory savings, complete caller discovery or universal language/framework coverage.
`;

export const SEPTUM_MAP_SKILL_TEMPLATE = USE_SEPTUM_SKILL_TEMPLATE;
