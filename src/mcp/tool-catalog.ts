import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceContext } from "./workspace-manager.ts";
import { MapToolSchema, SymbolToolSchema, SliceToolSchema, BoundaryToolSchema } from "./schemas.ts";
import { handleMapTool } from "./tools/map.ts";
import { handleSymbolTool } from "./tools/symbol.ts";
import { handleSliceTool } from "./tools/slice.ts";
import { handleBoundaryTool } from "./tools/boundary.ts";

function defineTool<Name extends string, Args>(
  definition: Omit<Tool, "name"> & {
    name: Name;
    schema: { parse(input: unknown): Args };
    execute(ctx: WorkspaceContext, args: Args, signal?: AbortSignal): ReturnType<typeof handleMapTool> | ReturnType<typeof handleSymbolTool> | ReturnType<typeof handleSliceTool> | ReturnType<typeof handleBoundaryTool>;
  },
) {
  const { name, description, inputSchema, schema, execute } = definition;
  return {
    name, description, inputSchema,
    parse(input: unknown) {
      const args = schema.parse(input ?? {});
      return { name, args, execute: (ctx: WorkspaceContext, signal?: AbortSignal) => execute(ctx, args, signal) };
    },
  };
}

export const TOOL_CATALOG = [
  defineTool({
    name: "septum_map",
    schema: MapToolSchema,
    execute: (ctx, args, signal) => handleMapTool(ctx.repo, ctx.config, args, ctx.root, signal),
    description:
      "Navigate architecture: workspace domains and cross-domain import adjacency, domain/file neighborhoods, static entrypoints and coverage. Output schema navigation/v1. Signatures, member lists and source belong to septum_symbol; full expands navigation only. Use file_filter to focus, include_evidence for one file's import details, or septum_slice for static handler relationships. Example: {action:'catalog',domain:'mcp'}.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["catalog", "register"],
          default: "catalog",
          description: "Sub-operation to execute: 'catalog' (inspect domain/macro map) or 'register' (dynamically register bounded-context domain).",
        },
        domain: {
          type: "string",
          description: "Target domain name (e.g. 'orders', 'core'). If omitted in catalog action, returns project-wide Macro Semantic Map.",
        },
        detail_level: {
          type: "string",
          enum: ["compact", "full"],
          default: "compact",
          description: "Navigation extent: compact selects up to 40 files (or submodule zoom-in for large domains >25 files), full up to 100. Neither includes signatures or source; use septum_symbol for declaration inspection.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description: "Output format: 'text' (default token-efficient compact markdown summary) or 'json' (structured navigation/v1 payload).",
        },
        archetype_filter: {
          type: "string",
          description: "Optional archetype filter (e.g. 'service', 'model', 'controller', 'repository').",
        },
        file_filter: {
          type: "string",
          description: "Optional substring filter to inspect specific file(s) within the domain.",
        },
        file_offset: { type: "integer", minimum: 0, description: "Start of the catalog file page; copy next_file_offset from pagination." },
        file_limit: { type: "integer", minimum: 1, maximum: 100, description: "Optional navigation selection limit. Small scopes return together; pagination appears only when files remain." },
        include_evidence: { type: "boolean", description: "Opt in to up to 20 raw import-evidence records; requires file_filter matching exactly one file." },
        include_capabilities: { type: "boolean", description: "Opt in to language/parser capabilities; omitted from navigation by default." },
        root: {
          type: "string",
          description: "Root directory path for domain registration (action='register').",
        },
        description: {
          type: "string",
          description: "Architectural purpose of the domain (action='register').",
        },
        allowed_dependencies: {
          type: "array",
          items: { type: "string" },
          description: "List of domain names this domain is allowed to import (action='register').",
        },
        forbidden_dependencies: {
          type: "array",
          items: { type: "string" },
          description: "List of domain names strictly forbidden from being imported (action='register').",
        },
        archetypes: {
          type: "object",
          description: "Layer archetypes mapping (action='register').",
        },
        ingest_now: {
          type: "boolean",
          default: false,
          description: "Whether to immediately run AST ingestion on domain files upon registration.",
        },
        workspace_path: {
          type: "string",
          description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
        },
      },
      required: [],
    },
  }),
  defineTool({
    name: "septum_symbol",
    schema: SymbolToolSchema,
    execute: (ctx, args, signal) => handleSymbolTool(ctx.repo, ctx.config, args, ctx.pipeline, ctx.root, signal),
    description:
      "Locate indexed declarations, retrieve source/contracts, or inspect potential consumers. action='context' (alias 'inspect') selects deep TypeScript references or bounded source inspection; read mode, freshness, diagnostics and omissions. action='impact' separates import dependents from supported static call sites and inferred caller hints; the caller set is incomplete. Use septum_map for domain/file navigation and septum_slice for static entrypoint context. Example: {action:'context',query:'handleOrder',file_path:'src/orders.ts'}.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["locate", "context", "inspect", "impact"],
          default: "locate",
          description: "'locate' finds declarations; 'context' (or 'inspect') retrieves declaration source along with local/import-bound supporting declarations for TypeScript within budget_bytes, or bounded source for polyglot files; 'impact' reports static caller hints. Example: {action:'context',query:'submit',file_path:'src/submit.ts'}.",
        },
        query: {
          type: "string",
          description: "Symbol name, call syntax (e.g. 'OrderController::cancelOrder'), or search query.",
        },
        domain: {
          type: "string",
          description: "Optional domain filter (e.g. 'orders').",
        },
        file_path: {
          type: "string",
          description: "Exact indexed repository-relative file path. Use it to select one candidate when names are ambiguous.",
        },
        symbol_ref: {
          type: "object",
          description: "Declaration reference returned by locate or catalog. Stale indexed fingerprints are refused.",
          properties: {
            file_path: { type: "string", minLength: 1 },
            language: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            kind: { type: "string", minLength: 1 },
            signature: { type: "string" },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
            indexed_content_hash: { type: "string", minLength: 1 },
            container: { type: "string" },
            receiver: { type: "string" },
          },
          required: ["file_path", "language", "name", "kind", "signature", "start_line", "end_line", "indexed_content_hash"],
        },
        include_source: {
          type: "boolean",
          description: "Explicit true selects bounded source; explicit false selects declaration details without source. Omit for deep TypeScript context or default polyglot source. Source hashes must match disk.",
        },
        source_start_line: {
          type: "number",
          minimum: 1,
          description: "First line to return within the selected symbol range.",
        },
        source_line_limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          description: "Select bounded source inspection with this line limit (capped at 200). Bounded mode uses 120 lines when omitted.",
        },
        context_mode: {
          type: "string", enum: ["deep", "source"],
          description: "Explicit context mode. deep selects referenced TypeScript declarations; source selects bounded source inspection. Omit for legacy automatic selection.",
        },
        include_dependencies: {
          type: "boolean",
          default: true,
          description: "Whether to include injected dependencies and outbound calls.",
        },
        budget_bytes: {
          type: "integer",
          minimum: 2048,
          maximum: 2097152,
          default: 16384,
          description: "For deep TypeScript context (including inspect alias): maximum UTF-8 bytes of the serialized MCP tool result, including evidence and continuation. Do not combine with bounded source options.",
        },
        max_depth: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          default: 2,
          description: "For deep TypeScript context: maximum import edge depth to traverse from the target declaration (default: 2, min: 1, max: 4).",
        },
        continuation: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "For action='context': copy the previous page token with the same target and budget.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return for locate (default: 10).",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description: "Output format: 'text' (default token-efficient compact summary) or 'json' (structured payload).",
        },
        workspace_path: {
          type: "string",
          description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
        },
      },
      required: [],
    },
  }),
  defineTool({
    name: "septum_slice",
    schema: SliceToolSchema,
    execute: (ctx, args, signal) => handleSliceTool(ctx.repo, ctx.config, args, ctx.root, signal),
    description:
      "Match a supported static entrypoint and inspect related nodes with relationship evidence and diagnostics. Supports cataloged routes, handlers, jobs, CLI commands and events; results do not establish runtime execution order or complete reachability. Use septum_symbol for declarations and septum_boundary for import policy. Example: {query:'POST /orders/{id}/pay',max_depth:5} or {query:'OrderController@pay'}.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Route URI (e.g. 'POST /orders/{id}/pay'), action (e.g. 'OrderController@pay'), or high-level task intent.",
        },
        controller_file: {
          type: "string",
          minLength: 1,
          description: "Exact catalog controller/handler file copied from an ambiguity candidate. Filters target selection.",
        },
        max_depth: {
          type: "number",
          default: 5,
          minimum: 1,
          maximum: 8,
          description: "Maximum depth to trace (default: 5, min: 1, max: 8). Use 6-8 for deep Event/Job/Queue traces.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description: "Output format: 'text' (default token-efficient compact summary) or 'json' (structured payload).",
        },
        workspace_path: {
          type: "string",
          description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
        },
      },
      required: ["query"],
    },
  }),
  defineTool({
    name: "septum_boundary",
    schema: BoundaryToolSchema,
    execute: (ctx, args, signal) => handleBoundaryTool(ctx.evaluator, ctx.config, args, ctx.repo, ctx.root),
    description:
      "Architectural firewall: validate proposed or staged imports against domain boundaries and circular dependency constraints. When to use: (1) scope='file' with proposed_imports BEFORE writing new import statements, (2) scope='staged' BEFORE git commit to prevent cross-domain leaks, (3) scope='all' or 'domain' for codebase audits. When NOT to use: do NOT use to read source code or locate symbols. Status 'approved' confirms zero violations; 'rejected' requires refactoring. Example: {scope:'file',file_path:'src/order/service.ts',proposed_imports:['../billing/repo']}.",
    inputSchema: {
      type: "object",
      properties: {
        max_bytes: {
          type: "integer",
          minimum: 512,
          maximum: 2097152,
          description: "Optional maximum UTF-8 byte size of the serialized tool result. Narrow the scope if the complete verdict and evidence exceed it.",
        },
        scope: {
          type: "string",
          enum: ["file", "staged", "all", "domain"],
          default: "file",
          description: "'file' evaluates proposed imports against domain policies; 'staged' audits git index changes; 'domain' checks a specific domain's violations; 'all' audits the entire workspace.",
        },
        file_path: {
          type: "string",
          description: "Path of the file being edited or created (scope='file' only). Use either file_path or file_paths.",
        },
        file_paths: {
          type: "array",
          items: { type: "string" },
          description: "Non-empty list of file paths for batch proposed-import checks (scope='file' only).",
        },
        proposed_imports: {
          type: "array",
          items: { type: "string" },
          description: "List of proposed import statements or target symbols (scope='file' only).",
        },
        domain: {
          type: "string",
          description: "Registered domain name, required for scope='domain'; optional for staged/file checks.",
        },
        staged: {
          type: "boolean",
          description: "Convenience flag equivalent to scope='staged'.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description: "Output format: 'text' (default token-efficient compact summary) or 'json' (structured payload).",
        },
        workspace_path: {
          type: "string",
          description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
        },
      },
      required: [],
    },
  }),
];

export function parseToolRequest(name: string, args: unknown) {
  const tool = TOOL_CATALOG.find(entry => entry.name === name);
  if (!tool) throw new Error(`Unknown tool: '${name}'`);
  return tool.parse(args);
}
