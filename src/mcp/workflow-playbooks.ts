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
    name: "open-apps",
    description: "Open the Septum Architecture UI and report workspace coverage or partial-index gaps with next steps.",
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
      const appsUri = workspacePath ? `septum://apps?workspace=${encodeURIComponent(workspacePath)}` : "septum://apps";
      const workspaceHint = workspacePath
        ? ""
        : " If the server runs globally without client roots, include `workspace_path` with the active workspace root (and `?workspace=<path>` when reading `septum://apps`).";
      return userTextMessage("Open Septum Architecture UI and inspect workspace coverage.", [
        "Open the Septum Architecture UI and inspect workspace coverage:",
        "1. Open Septum Architecture from the host's app controls when available. The host uses the app-only `septum_app` entrypoint.",
        `2. Call \`septum_map\` with \`${mapArgs}\` to inspect topology and index health. Check \`status\` and \`health\`, including \`coverage\`, \`unresolved_imports\` and \`incomplete_imports\`. Read \`${appsUri}\` for partial-file samples when supported.${workspaceHint}`,
        "3. If `status` is `NOT_INDEXED` or `coverage` is `partial`, list the uncovered files or conditions and give concrete next steps (`septum init`, `septum sync`, `septum_map(action='register')`, or `ignore_patterns` / alias fixes).",
      ]);
    },
  },
  {
    name: "audit-coupling",
    description: "Find circular dependencies, forbidden imports, and high-coupling domains, ranked by remediation priority.",
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
      const workspaceHint = workspacePath ? "" : " Include `workspace_path` with the active workspace root if the server runs globally.";
      return userTextMessage("Prioritized coupling and boundary audit.", [
        "Audit the codebase for coupling, circular dependencies, and boundary violations:",
        `1. Call \`septum_map\` with \`${mapArgs}\` to inspect domain sizes, cross-domain import counts, and unresolved imports.${workspaceHint}`,
        `2. Call \`septum_boundary\` with \`${boundaryArgs}\` to list all circular dependencies and forbidden imports.`,
        "3. Rank fixes by priority: (1) break circular dependencies, (2) resolve forbidden cross-domain imports with exact `file:line`, and (3) flag high fan-out domains or missing coverage.",
      ]);
    },
  },
  {
    name: "check-staged",
    description: "Check staged git changes for domain boundary and circular dependency violations before committing.",
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
      const workspaceHint = workspacePath ? "" : " Include `workspace_path` with the active workspace root if the server runs globally.";
      return userTextMessage("Check staged git changes against domain boundaries.", [
        "Verify staged git changes before committing:",
        `1. Call \`septum_boundary\` with \`${boundaryArgs}\`.${workspaceHint}`,
        "2. If `status` is `rejected`, list each violation with `file:line`, `rule`, and import direction, then propose concrete refactors to satisfy the boundary.",
        "3. If `status` is `approved`, confirm staged changes introduce no boundary or circular-dependency violations (and note any partial-coverage caveats).",
      ]);
    },
  },
  {
    name: "plan-refactor",
    description: "Map blast radius and domain rules before moving or splitting a module or symbol.",
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
      const workspaceHint = workspacePath ? "" : " Include `workspace_path` with the active workspace root if the server runs globally.";
      const targetStep = target
        ? `1. Call \`septum_symbol\` with \`{ action: "impact", query: ${JSON.stringify(target)}${wsPart} }\` to map static callers and import dependents.${workspaceHint}`
        : `1. Identify the target symbol or file from conversation context (ask the user if unclear), then call \`septum_symbol\` with \`{ action: "impact", query: "<target>"${wsPart} }\`.${workspaceHint}`;
      const mapArgs = JSON.stringify({
        action: "catalog",
        detail_level: "compact",
        ...(workspacePath ? { workspace_path: workspacePath } : {}),
      });
      return userTextMessage("Blast-radius and domain-safe refactor plan.", [
        "Build a domain-compliant refactoring plan:",
        targetStep,
        `2. Call \`septum_map\` with \`${mapArgs}\` to check source and target domain \`allowed_dependencies\` and \`forbidden_dependencies\`.`,
        "3. Outline a leaf-to-core migration order and note any `septum_boundary(scope='file')` checks needed before moving imports.",
      ]);
    },
  },
  {
    name: "trace-feature",
    description: "Trace an HTTP, GraphQL, job, or CLI entrypoint through handlers, services, and repositories.",
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
      const workspaceHint = workspacePath ? "" : " Include `workspace_path` with the active workspace root if the server runs globally.";
      return userTextMessage("Trace feature execution slice.", [
        "Trace the end-to-end static execution flow of the feature:",
        sliceArgs
          ? `1. Call \`septum_slice\` with \`${sliceArgs}\` to open the Slice view and inspect the static chain.${workspaceHint}`
          : `1. Call \`septum_map\` with \`${mapArgs}\` to list static entrypoints, pick the relevant route or command from context (or ask the user), then call \`septum_slice\`.${workspaceHint}`,
        "2. Summarize each stage (entrypoint -> handler/controller -> service -> repository/job) with `file:line`, flagging skipped layers, direct DB access from controllers, or unresolved hops.",
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
