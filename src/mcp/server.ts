import { buildUnindexedCatalog } from "./tools/get-domain-catalog.ts";
import { WorkspaceManager, resolveServerWorkspace, isWorkspaceInitialized, type WorkspaceLease } from "./workspace-manager.ts";
import { RESOURCE_LIMITS } from "../core/resources/limits.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ConfigLoader } from "../core/config/loader.ts";
import { SeptumTelemetry } from "../core/telemetry/telemetry.ts";
import { handleMapTool } from "./tools/map.ts";
import { handleSymbolTool } from "./tools/symbol.ts";
import { handleSliceTool } from "./tools/slice.ts";
import { handleBoundaryTool } from "./tools/boundary.ts";
import { DomainRootConflictError } from "../core/config/domain-ownership.ts";

import {
  parseToolRequest,
} from "./schemas.ts";
import { SEPTUM_VERSION, checkRuntimeVersion } from "../utils/version-check.ts";

export function extractPathHint(args: unknown): string | undefined {
  if (!args) return undefined;

  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed.length > 0) return trimmed;
    return undefined;
  }

  if (Array.isArray(args)) {
    if (typeof args[0] === "string" && args[0].trim()) {
      return args[0].trim();
    }
    return undefined;
  }

  if (typeof args === "object" && args !== null) {
    const record = args as Record<string, any>;

    const explicitWorkspace =
      record.workspace_path ??
      record.workspacePath ??
      record.workspace ??
      record.project_root ??
      record.projectRoot ??
      record.target_path ??
      record.targetPath;
    if (typeof explicitWorkspace === "string" && explicitWorkspace.trim()) {
      return explicitWorkspace.trim();
    }

    const filePath =
      record.file_path ??
      record.filePath ??
      record.from_file ??
      record.fromFile ??
      record.source_file ??
      record.sourceFile ??
      record.entry_file ??
      record.entryFile;
    if (typeof filePath === "string" && filePath.trim()) {
      return filePath.trim();
    }

    const filePaths =
      record.file_paths ??
      record.filePaths ??
      record.files ??
      record.paths;
    if (Array.isArray(filePaths) && typeof filePaths[0] === "string" && filePaths[0].trim()) {
      return filePaths[0].trim();
    }
    if (typeof filePaths === "string" && filePaths.trim()) {
      return filePaths.trim();
    }

    if (
      !record.domain &&
      !record.name &&
      !record.domain_name &&
      !record.domainName &&
      typeof record.root === "string" &&
      record.root.trim()
    ) {
      return record.root.trim();
    }
  }

  return undefined;
}

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

export const SEPTUM_SERVER_INSTRUCTIONS = `Septum is an AST-powered architectural boundary, selective context, and call graph engine.
Guidelines for AI Coding Agents:
1. SELECTIVE CONTEXT FIRST: Avoid reading whole files with read_file when analyzing implementations or finding symbols. Call septum_symbol(action: 'context') to retrieve exact implementations and bound type dependencies within a bounded 16 KB budget.
2. DISCOVER ARCHITECTURE: Call septum_map(action: 'catalog', detail_level: 'compact') to inspect module boundaries, file locations, and allowed dependencies before introducing new files or cross-domain imports.
3. PREVENT REGRESSIONS (BLAST RADIUS): Before altering method signatures or deleting public symbols, call septum_symbol(action: 'impact', query: '...') to check inbound callers across the dependency graph.
4. TRACE EXECUTION FLOWS: To understand how API requests, CLI commands, or background jobs flow through layers, call septum_slice(query: '<route|handler>') instead of manually searching grep hits.
5. PRE-FLIGHT BOUNDARY CHECK: Before adding a cross-module import, call septum_boundary(scope: 'file', proposed_imports: [...]). Call septum_boundary(scope: 'staged') before git commit to verify zero architectural violations.`;

export async function runMCPServer(): Promise<void> {
  const manager = new WorkspaceManager();
  void checkRuntimeVersion().catch(() => {});

  const server = new Server(
    {
      name: "septum-mcp-server",
      version: SEPTUM_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: SEPTUM_SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "septum_map",
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
                description: "Navigation extent: compact selects up to 40 files, full up to 100. Neither includes signatures or source; use septum_symbol for declaration inspection.",
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
        },
        {
          name: "septum_symbol",
          description:
            "Locate declarations, read implementation source with bound dependencies, or check who calls a symbol before editing. When to use: (1) action='locate' to find where a symbol is declared, (2) action='context' (or 'inspect') to read a function implementation and bound type definitions without reading whole files (budgeted to 16 KB), (3) action='impact' before refactoring or deleting to inspect inbound callers and blast radius. When NOT to use: do NOT use for macro architecture overviews (use septum_map) or full route flow tracing (use septum_slice). Example: {action:'context',query:'handleOrder',file_path:'src/orders.ts'}.",
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
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: [],
          },
        },
        {
          name: "septum_slice",
          description:
            "Trace end-to-end call flow from an entrypoint (HTTP route, controller, queue job, event) down through services and repositories. When to use: investigating how a request or user action flows through the system, or finding which controller/service handles a feature. When NOT to use: do NOT use to locate symbol declarations (use septum_symbol action='locate') or audit import rules (use septum_boundary). Example: {query:'POST /orders/{id}/pay',max_depth:5} or {query:'OrderController@pay'}.",
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
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "septum_boundary",
          description:
            "Architectural firewall: validate proposed or staged imports against domain boundaries and circular dependency constraints. When to use: (1) scope='file' with proposed_imports BEFORE writing new import statements, (2) scope='staged' BEFORE git commit to prevent cross-domain leaks, (3) scope='all' or 'domain' for codebase audits. When NOT to use: do NOT use to read source code or locate symbols. Status 'approved' confirms zero violations; 'rejected' requires refactoring. Example: {scope:'file',file_path:'src/order/service.ts',proposed_imports:['../billing/repo']}.",
          inputSchema: {
            type: "object",
            properties: {
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
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: [],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const startTime = performance.now();
    let lease: WorkspaceLease | undefined;
    try {
    extra?.signal?.throwIfAborted();
    let parsed;
    try { parsed = parseToolRequest(name, args); }
    catch (error) { throw new Error(`[Septum Validation Error] Invalid arguments for ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    const record = parsed.args;
    const raw = (args ?? {}) as Record<string, any>;
    const workspacePath = record.workspace_path ?? raw.workspace_path ?? raw.workspacePath ?? raw.workspace ?? raw.project_root ?? raw.projectRoot;
    const knownRoots = manager.activeRoots;
    if (manager.initialRoot && !knownRoots.includes(manager.initialRoot)) {
      knownRoots.unshift(manager.initialRoot);
    }
    const fallbackRoot = manager.initialRoot || manager.lastRoot;
    const root = resolveServerWorkspace({
      workspacePath,
      filePath: workspacePath ? undefined : extractPathHint(args),
      fallbackRoot,
      knownRoots,
    });

    if (!isWorkspaceInitialized(root)) {
      if (name === "septum_map" && (!("action" in record) || !record.action || record.action === "catalog")) {
        const runtimeVersion = await checkRuntimeVersion();
        const diagnostic = buildUnindexedCatalog(root, runtimeVersion);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(diagnostic, null, 2),
            },
          ],
          metadata: diagnostic,
          runtime_version: runtimeVersion,
        };
      }
      const isRegistration = name === "septum_map" && "action" in record && record.action === "register";
      if (!isRegistration) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[Septum MCP Error] Workspace '${root}' belum diinisialisasi. Jalankan 'septum init' di terminal workspace atau gunakan tool 'septum_map' dengan action='register' untuk mendaftarkan domain.`,
            },
          ],
        };
      }
    }

    extra?.signal?.throwIfAborted();
    const isDomainRegistration = parsed.name === "septum_map" && parsed.args.action === "register";
    lease = manager.acquire(root, { deferDiscovery: isDomainRegistration });
    const ctx = lease.context;
    await ctx.ready;
    extra?.signal?.throwIfAborted();
    const registrationBeforeDiscovery = isDomainRegistration && Object.keys(ctx.config.domains).length === 0 && ctx.repo.getAllDomains().length === 0;
    try { if (!registrationBeforeDiscovery) await ctx.watcher.flush(false, extra?.signal); }
    catch (error) { if (!isDomainRegistration || !(error instanceof DomainRootConflictError)) throw error; }
    if (ctx.repo.getMeta("sync_error") && !(isDomainRegistration && ctx.repo.getMeta("sync_error_code") === "DOMAIN_ROOT_CONFLICT")) {
      throw new Error(`Workspace index synchronization failed: ${ctx.repo.getMeta("sync_error")}`);
    }
    ctx.config = ConfigLoader.load(undefined, ctx.root);
    // External policy writes do not emit source watcher events. Keep this cheap
    // ownership gate independent of full reconciliation and target JIT refresh.
    if (!isDomainRegistration) ctx.pipeline.assertDomainOwnership(ctx.config, ctx.root);
    ctx.evaluator.getResolver().setRepository(ctx.repo);

    const executeTool = async () => {
      switch (parsed.name) {
        case "septum_map": return handleMapTool(ctx.repo, ctx.config, parsed.args, ctx.root, extra?.signal);
        case "septum_symbol": return handleSymbolTool(ctx.repo, ctx.config, parsed.args, ctx.pipeline, ctx.root, extra?.signal);
        case "septum_slice": return handleSliceTool(ctx.repo, ctx.config, parsed.args, ctx.root, extra?.signal);
        case "septum_boundary": return handleBoundaryTool(ctx.evaluator, ctx.config, parsed.args, ctx.repo, ctx.root);
      }
    };

    try {
      const response = await manager.runTool(executeTool, extra?.signal);
      const durationMs = Math.round(performance.now() - startTime);

      let bytesOut = 0;
      let linesOut = 0;
      let combinedText = "";
      if (Array.isArray(response?.content)) {
        for (const item of response.content) {
          if (typeof item.text === "string") {
            bytesOut += Buffer.byteLength(item.text, "utf8");
            linesOut += countLines(item.text);
            if (combinedText.length < 1500) {
              combinedText += item.text;
            }
          }
        }
      }

      const inputArgs = (args as Record<string, any>) ?? {};
      const actionName = typeof inputArgs.action === "string" ? inputArgs.action : (typeof inputArgs.scope === "string" ? inputArgs.scope : undefined);
      const estimatedTokens = Math.round(bytesOut / 4);
      const bloatAlert = bytesOut >= SeptumTelemetry.BLOAT_BYTE_THRESHOLD;
      const outputDigest = SeptumTelemetry.createOutputDigest(combinedText);
      let outcome: string | undefined;
      try {
        const payload = JSON.parse(combinedText);
        const candidate = payload.status ?? (payload.found === false ? "not_found" : undefined);
        if (["success", "partial", "unknown", "approved", "rejected", "ambiguous", "not_found", "NOT_INDEXED", "stale_reference", "invalid_context_options", "budget_too_small"].includes(candidate)) outcome = candidate;
      } catch { /* Non-JSON results retain transport status only. */ }

      SeptumTelemetry.recordToolCall({
        event: "tool_call_completed",
        tool: name,
        action: actionName,
        duration_ms: durationMs,
        input: inputArgs,
        metrics: {
          bytes_out: bytesOut,
          lines_out: linesOut,
          estimated_tokens: estimatedTokens,
        },
        bloat_alert: bloatAlert,
        output_digest: outputDigest,
        outcome,
        session: null,
        status: (response as { isError?: boolean } | undefined)?.isError ? "error" : "success",
      }, ctx.root);

      return response;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorInstance = err instanceof Error ? err : new Error(String(err));
      const inputArgs = (args as Record<string, any>) ?? {};
      const actionName = typeof inputArgs.action === "string" ? inputArgs.action : (typeof inputArgs.scope === "string" ? inputArgs.scope : undefined);

      SeptumTelemetry.recordToolCall({
        event: "tool_call_failed",
        tool: name,
        action: actionName,
        duration_ms: durationMs,
        input: inputArgs,
        session: null,
        status: "error",
        error: {
          message: errorInstance.message,
          stack: errorInstance.stack,
        },
      }, ctx.root);

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `[Septum MCP Error] ${errorInstance.message}`,
          },
        ],
      };
    }
    } catch (error) {
      return {isError: true, content: [{type: "text" as const, text: `[Septum MCP Error] ${error instanceof Error ? error.message : String(error)}`}]};
    } finally { lease?.release(); }
  });

  const transport = new StdioServerTransport();

  let stopping = false;
  let memoryTimer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    if (memoryTimer) clearInterval(memoryTimer);
    const deadline = setTimeout(() => {
      console.error("[Septum MCP] Shutdown deadline exceeded; indexing may require reconciliation.");
      process.exit(1);
    }, RESOURCE_LIMITS.shutdownMs);
    void (async () => {
      try {
        await server.close();
        await manager.close();
        clearTimeout(deadline);
        console.error("[Septum MCP] All workspace resources closed cleanly.");
        process.exit(0);
      } catch (error) {
        console.error(`[Septum MCP] Cleanup failed: ${String(error)}`);
        clearTimeout(deadline);
        process.exit(1);
      }
    })();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.stdin.once("end", cleanup);
  process.stdin.once("close", cleanup);
  server.onclose = cleanup;
  await server.connect(transport);
  try {
    const initialRoot = resolveServerWorkspace({initial:true});
    manager.initialRoot = initialRoot;
    manager.lastRoot = initialRoot;
    if (isWorkspaceInitialized(initialRoot)) {
      const initial = manager.acquire(initialRoot);
      try { await initial.context.ready; } finally { initial.release(); }
    }
    if (process.env.SEPTUM_MEMORY_DIAGNOSTICS === "1") {
      memoryTimer = setInterval(() => {
        const sample = { ...process.memoryUsage(), workspaces: manager.size, watches: manager.watchCount, pending_paths: manager.pendingPaths, sync_duration_ms: manager.syncDurationMs };
        if (manager.lastRoot && isWorkspaceInitialized(manager.lastRoot)) {
          SeptumTelemetry.recordMemorySample(sample, manager.lastRoot);
        } else {
          console.error(`[Septum Memory] ${JSON.stringify({timestamp: new Date().toISOString(), event: "memory_sample", metrics: sample})}`);
        }
      }, 60_000);
      memoryTimer.unref();
    }
  } catch (error) {
    await manager.close();
    throw error;
  }

  if (process.stdin.isTTY) {
    console.error(
      `\x1b[36m[Septum MCP]\x1b[0m Server daemon running on stdio (PID: ${process.pid}, v${SEPTUM_VERSION}).`
    );
    console.error(
      `\x1b[36m[Septum MCP]\x1b[0m Listening for JSON-RPC client messages. Press Ctrl+C to terminate.`
    );
  } else {
    console.error(`[Septum MCP] Server started successfully on stdio transport (v${SEPTUM_VERSION}).`);
  }
}
