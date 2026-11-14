export const SEPTUM_RULES_TEMPLATE = `# Septum: static code navigation and boundary checks

Use Septum to inspect indexed declarations, imports, domains and supported entrypoints. Its SQLite database stores extracted static evidence. Read freshness, coverage, diagnostics and omissions before relying on a result.

## Tool routing

| Task | Tool | Result |
| --- | --- | --- |
| Find domains and files | \`septum_map({action: "catalog", detail_level: "compact"})\` | Domain/file navigation, directed import relationships, static entrypoints and index health |
| Inspect a declaration | \`septum_symbol({action: "locate", query: "<name>"})\` | Indexed coordinates, declaration reference, candidates or suggestions |
| Read implementation and supporting declarations | \`septum_symbol({action: "context", query: "<name>", file_path: "<path>"})\` | Deep TypeScript context or bounded source inspection, according to the selected mode |
| Inspect potential consumers | \`septum_symbol({action: "impact", query: "<name>"})\` | Import dependents, supported static call sites and inferred caller hints |
| Inspect an entrypoint | \`septum_slice({query: "<route or handler>", max_depth: 5})\` | Static catalog match and related nodes with relationship evidence |
| Check proposed imports | \`septum_boundary({scope: "file", file_path: "<path>", proposed_imports: [...]})\` | Proposal decision and diagnostics under configured domain rules |
| Check the Git index | \`septum_boundary({scope: "staged"})\` | Boundary analysis using frozen staged source and interpretation files |

## Reading and acting on results

- Start with map when the relevant domain/file is unknown. Follow \`dependencies\`, \`entrypoints\`, \`health\` and \`next\`. Full detail expands navigation selection; use symbol for declaration bodies.
- Narrow ambiguous declarations with \`file_path\` or a returned \`symbol_ref\`. A found indexed declaration can still have stale or unavailable source.
- Choose \`context_mode: "deep"\` for supported TypeScript reference context. Choose \`context_mode: "source"\` for bounded source inspection. On the source path, \`include_source: false\` requests signature/dependency details.
- Deep-context \`budget_bytes\` controls response serialization. Source-mode line limits are a different contract. A setting is not a guarantee of task completeness.
- Continue deep context with the returned \`continuation\` and unchanged selection/options. Inspect omission accounting and diagnostics.
- Before changing a public contract, inspect impact and the relevant consumers. Read \`inbound_callers_complete\` and the limits of \`inbound_callers\`; static caller evidence requires application checks.
- Proposal approval does not audit existing imports. Use all/domain/staged scopes for their corresponding audits.
- \`unknown\` is not approval. \`rejected\` reports detected violations such as \`forbidden_dependency\`, \`disallowed_dependency\` or \`circular_dependency\`. \`approved\` concerns only the evaluated static scope.
- Slice confidence describes query-to-catalog matching. Imports do not prove calls; related nodes do not establish execution order or runtime dispatch.
- If tools are unavailable or evidence is incomplete, inspect relevant source directly and verify the behavior with appropriate project checks.

## Language and workspace scope

Declaration extraction and import resolution have separate language-specific limits. Python, Go, Rust, Ruby, Java and C# resolve supported local/manifest patterns; dynamic configuration, conditional builds, binary classpaths and runtime loading can remain unresolved or unsupported. Set \`workspace_path\` explicitly when selecting among repositories.

Generated client hooks need client enablement and a matching tool payload. Their presence does not prove that an edit was intercepted.
`;
