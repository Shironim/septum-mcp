import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const architectureAuditArgs = z.object({
  domain: z.string().trim().min(1).optional(),
  workspace_path: z.string().trim().min(1).optional(),
}).strict();

const PLAYBOOKS = [
  {
    name: "septum-pre-edit-check",
    description: "Inspect bounded symbol context, static impact, and boundary rules before editing a file or symbol.",
    arguments: [
      {
        name: "target",
        description: "Target symbol name or file path to inspect before editing.",
        required: true,
      },
    ],
    render(args: Record<string, string | undefined>) {
      const target = args.target?.trim();
      if (!target) {
        throw new McpError(ErrorCode.InvalidParams, "Use a non-empty target argument.");
      }
      return {
        description: "Pre-edit context, consumer impact, and boundary verification workflow.",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Before editing '${target}', run Septum checks in order:`,
                `1. Call \`septum_symbol\` with \`{ action: "locate", query: ${JSON.stringify(target)} }\` (or pass \`file_path\`) to get exact coordinates and \`symbol_ref\`.`,
                `2. Call \`septum_symbol\` with \`{ action: "context", query: ${JSON.stringify(target)} }\` to read bounded implementation and supporting declarations.`,
                `3. Call \`septum_symbol\` with \`{ action: "impact", query: ${JSON.stringify(target)} }\` to inspect static dependents before changing public contracts.`,
                `4. Before adding imports, call \`septum_boundary\` with \`{ scope: "file", file_path: "...", proposed_imports: [...] }\` to verify domain rules.`,
              ].join("\n"),
            },
          },
        ],
      };
    },
  },
  {
    name: "septum-architecture-audit",
    description: "Review domain topology, cross-domain leaks, and circular dependencies.",
    arguments: [
      {
        name: "domain",
        description: "Optional domain name to scope the audit.",
        required: false,
      },
      {
        name: "workspace_path",
        description: "Optional explicit workspace root shared by both audit calls.",
        required: false,
      },
    ],
    render(args: Record<string, string | undefined>) {
      const parsed = architectureAuditArgs.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Use non-empty strings for optional domain and workspace_path arguments.");
      }
      const { domain, workspace_path } = parsed.data;
      const target = { ...(domain && { domain }), ...(workspace_path && { workspace_path }) };
      const mapArgs = JSON.stringify({ action: "catalog", detail_level: "compact", ...target });
      const boundaryArgs = JSON.stringify({ scope: domain ? "domain" : "all", ...target });
      return {
        description: "Domain topology and static boundary audit workflow.",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Review the selected workspace's static domain boundaries.",
                "Use the same workspace for both calls. Resolve workspace ambiguity before running either call.",
                "1. Read ownership, dependencies, and coverage with septum_map using these arguments.",
                mapArgs,
                "2. If the requested scope is available, use septum_boundary with these arguments. Inspect the verdict and diagnostics.",
                boundaryArgs,
                "Report known violations with file, line, rule, and import direction. Report missing coverage and unresolved evidence even when violations are present.",
                "Treat unknown as inconclusive. Limit any approval to the evaluated static scope.",
              ].join("\n"),
            },
          },
        ],
      };
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
