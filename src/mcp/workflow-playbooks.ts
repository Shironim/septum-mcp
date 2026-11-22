import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

function normalizeTrimmedArg(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function userTextMessage(description: string, lines: string[]) {
  return {
    description,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: lines.join("\n"),
        },
      },
    ],
  };
}

const PLAYBOOKS = [
  {
    name: "septum_apps",
    description: "Open the interactive Septum Architecture MCP App UI and report workspace coverage or partial-index gaps with actionable next steps.",
    arguments: [
      {
        name: "workspace_path",
        description: "Optional explicit workspace root path.",
        required: false,
      },
    ],
    render(args: Record<string, string | undefined>) {
      const workspacePath = normalizeTrimmedArg(args.workspace_path);
      const mapArgs = JSON.stringify({
        action: "catalog",
        detail_level: "compact",
        ...(workspacePath ? { workspace_path: workspacePath } : {}),
      });
      return userTextMessage("Launch Septum Architecture MCP App UI and surface coverage diagnostics.", [
        "Open the Septum Architecture MCP App and inspect workspace coverage:",
        `1. Call \`septum_map\` with \`${mapArgs}\` to open the interactive Septum Architecture UI and retrieve domain topology and health.`,
        "2. Check `status` and `health` (`index`, `coverage`, `sync_needed`, `unsupported_files`, `skipped_files`, `unresolved_imports`, `reasons`). If the client supports MCP resources, you may also read `septum://apps` for detailed partial-file samples.",
        "3. If the workspace is `NOT_INDEXED` or `coverage` is `partial`, report which files/conditions are uncovered and list concrete actionable next steps (`septum init`, `septum sync`, `septum_map(action='register')`, or `ignore_patterns` / alias fixes).",
      ]);
    },
  },
  {
    name: "septum_spaghetti_audit",
    description: "Diagnose messy/coupled codebases by ranking circular dependencies, forbidden imports, and high-coupling domains.",
    arguments: [
      {
        name: "domain",
        description: "Optional domain name to focus the audit.",
        required: false,
      },
      {
        name: "workspace_path",
        description: "Optional explicit workspace root path.",
        required: false,
      },
    ],
    render(args: Record<string, string | undefined>) {
      const domain = normalizeTrimmedArg(args.domain);
      const workspacePath = normalizeTrimmedArg(args.workspace_path);
      const target = { ...(domain && { domain }), ...(workspacePath && { workspace_path: workspacePath }) };
      const mapArgs = JSON.stringify({ action: "catalog", detail_level: "compact", ...target });
      const boundaryArgs = JSON.stringify({ scope: domain ? "domain" : "all", ...target });
      return userTextMessage("Prioritized messy-code and coupling audit.", [
        "Audit the codebase for architectural decay, coupling, and boundary violations:",
        `1. Call \`septum_map\` with \`${mapArgs}\` to inspect domain sizes, cross-domain dependency counts, and unresolved imports.`,
        `2. Call \`septum_boundary\` with \`${boundaryArgs}\` to collect all circular dependencies and forbidden dependency violations.`,
        "3. Rank remediation priorities for the user: (a) break circular dependencies first, (b) fix forbidden cross-domain imports with exact `file:line`, and (c) highlight domains with excessive fan-out/coupling or missing coverage.",
      ]);
    },
  },
  {
    name: "septum_pre_commit_guard",
    description: "Audit staged git changes against domain boundaries and circular dependency constraints before committing.",
    arguments: [
      {
        name: "workspace_path",
        description: "Optional explicit workspace root path.",
        required: false,
      },
    ],
    render(args: Record<string, string | undefined>) {
      const workspacePath = normalizeTrimmedArg(args.workspace_path);
      const boundaryArgs = JSON.stringify({
        scope: "staged",
        ...(workspacePath ? { workspace_path: workspacePath } : {}),
      });
      return userTextMessage("Pre-commit staged boundary guard.", [
        "Verify staged git changes before committing:",
        `1. Call \`septum_boundary\` with \`${boundaryArgs}\`.`,
        "2. If `status` is `rejected`, list every violation with `file:line`, `rule`, and import direction, and propose concrete refactors or abstractions so the commit stays compliant.",
        "3. If `status` is `approved`, confirm staged changes introduce no known boundary or circular-dependency violations (noting any partial coverage caveats).",
      ]);
    },
  },
  {
    name: "septum_refactor_plan",
    description: "Analyze blast radius and domain rules before splitting or moving a messy module or symbol.",
    arguments: [
      {
        name: "target",
        description: "Optional target symbol name or file path to refactor (uses active conversation context if omitted).",
        required: false,
      },
      {
        name: "workspace_path",
        description: "Optional explicit workspace root path.",
        required: false,
      },
    ],
    render(args: Record<string, string | undefined>) {
      const target = normalizeTrimmedArg(args.target);
      const workspacePath = normalizeTrimmedArg(args.workspace_path);
      const wsPart = workspacePath ? `, workspace_path: ${JSON.stringify(workspacePath)}` : "";
      const targetStep = target
        ? `1. Call \`septum_symbol\` with \`{ action: "impact", query: ${JSON.stringify(target)}${wsPart} }\` to map all static callers and import dependents.`
        : `1. Identify the target symbol or file from the current conversation (ask the user if unclear), then call \`septum_symbol\` with \`{ action: "impact", query: "<target>"${wsPart} }\`.`;
      const mapArgs = JSON.stringify({
        action: "catalog",
        detail_level: "compact",
        ...(workspacePath ? { workspace_path: workspacePath } : {}),
      });
      return userTextMessage("Blast-radius and domain-safe refactor plan.", [
        "Build a safe, domain-compliant refactoring plan:",
        targetStep,
        `2. Call \`septum_map\` with \`${mapArgs}\` to verify source and destination domain \`allowed_dependencies\` / \`forbidden_dependencies\`.`,
        "3. Produce a step-by-step migration order (from leaf dependents to core definitions) and note any boundary checks (`septum_boundary(scope='file')`) needed before moving imports.",
      ]);
    },
  },
  {
    name: "septum_trace_feature",
    description: "Trace an HTTP/GraphQL/CLI entrypoint through handlers, services, and repositories to understand tangled flows.",
    arguments: [
      {
        name: "query",
        description: "Optional route URI, controller action, or CLI command (discovers entrypoints via septum_map if omitted).",
        required: false,
      },
      {
        name: "workspace_path",
        description: "Optional explicit workspace root path.",
        required: false,
      },
    ],
    render(args: Record<string, string | undefined>) {
      const query = normalizeTrimmedArg(args.query);
      const workspacePath = normalizeTrimmedArg(args.workspace_path);
      const wsArgs = workspacePath ? { workspace_path: workspacePath } : {};
      const sliceArgs = query
        ? JSON.stringify({ query, max_depth: 5, ...wsArgs })
        : null;
      const mapArgs = JSON.stringify({ action: "catalog", detail_level: "compact", ...wsArgs });
      return userTextMessage("Feature execution-slice trace.", [
        "Trace the end-to-end static execution flow of the feature:",
        sliceArgs
          ? `1. Call \`septum_slice\` with \`${sliceArgs}\` to open the Slice UI and inspect the static chain.`
          : `1. Call \`septum_map\` with \`${mapArgs}\` to list static entrypoints, pick the relevant route/command from context (or ask the user), and then call \`septum_slice\`.`,
        "2. Summarize each stage (entrypoint -> handler/controller -> service -> repository/job) with `file:line`, and call out any skipped layers, direct DB access from controllers, or unresolved hops.",
      ]);
    },
  },
] as const;

export const SEPTUM_PROMPTS = PLAYBOOKS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args }));

export function listSeptumPrompts() {
  return { prompts: [...SEPTUM_PROMPTS] };
}

export function getSeptumPrompt(name: string, args: Record<string, string | undefined> = {}) {
  const playbook = PLAYBOOKS.find(entry => entry.name === name);
  if (!playbook) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: '${name}'`);
  return playbook.render(args);
}
