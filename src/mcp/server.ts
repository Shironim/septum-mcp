import { runWorkspaceBoundary } from "./workspace-boundary.ts";
import { randomBytes } from "node:crypto";
import { buildUnindexedCatalog } from "./tools/map.ts";
import { WorkspaceManager, resolveServerWorkspace, isWorkspaceInitialized, type WorkspaceLease } from "./workspace-manager.ts";
import { RESOURCE_LIMITS } from "../core/resources/limits.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getSeptumPrompt,
  listSeptumPrompts,
  listSeptumResources,
  listSeptumResourceTemplates,
  readSeptumResource,
} from "./resources-and-prompts.ts";
import { SeptumTelemetry, type ToolCallStage, type ToolResponse } from "../core/telemetry/telemetry.ts";
import { SeptumError } from "../core/errors.ts";
import { TOOL_CATALOG, parseToolRequest } from "./tool-catalog.ts";
import { SEPTUM_VERSION, checkRuntimeVersion } from "../utils/version-check.ts";

function explicitWorkspaceAlias(record: Record<string, unknown>): unknown {
  return record.workspace_path ?? record.workspacePath ?? record.workspace ?? record.project_root ?? record.projectRoot;
}

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

    const explicitWorkspace = explicitWorkspaceAlias(record) ?? record.target_path ?? record.targetPath;
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

export const SEPTUM_SERVER_INSTRUCTIONS = `Septum indexes supported declarations, imports, domain policies and static entrypoints.
Guidelines for AI Coding Agents:
1. CONTEXT: Call septum_symbol(action: 'context') for declaration source and supporting references. Deep TypeScript context uses budget_bytes and continuation; source inspection uses line limits. Read freshness, diagnostics and omissions, then inspect further source when needed.
2. NAVIGATION: Call septum_map(action: 'catalog') for domain/file locations, import relationships, static entrypoints and index health.
3. CONSUMERS: Before changing public contracts, inspect septum_symbol(action: 'impact') and relevant consumers. Import dependents and caller hints are incomplete static evidence; verify affected application behavior.
4. ENTRYPOINTS: Call septum_slice(query: '<route|handler>') for catalog matches and related nodes. Matching confidence does not establish runtime reachability or execution order.
5. BOUNDARIES: Call septum_boundary(scope: 'file', file_path: '...', proposed_imports: [...]) for candidate imports, or scope: 'all'/'domain'/'staged' for those audit scopes. Proposal approval does not audit existing imports. Unknown is not approval; approved describes only the evaluated static scope.
6. RESOURCES & PROMPTS: Initial-workspace snapshots are available at septum://domains, septum://health, septum://boundaries, septum://apps, and septum://domain/{name}; workflow playbooks at prompts open-apps, audit-coupling, check-staged, plan-refactor, and trace-feature.`;

export function createMcpServer(manager: WorkspaceManager): Server {

  const server = new Server(
    {
      name: "septum-mcp-server",
      version: SEPTUM_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: SEPTUM_SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => listSeptumResources());
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => listSeptumResourceTemplates());
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const traceId = randomBytes(16).toString("hex");
    const startTime = performance.now();
    const uri = request.params.uri;
    return SeptumTelemetry.withTrace(traceId, async () => {
      try {
        const result = await readSeptumResource(manager, uri, extra.signal);
        SeptumTelemetry.recordSystemEvent({
          level: "INFO",
          component: "resource",
          event: "resource_read_completed",
          fields: { uri: uri.slice(0, 128), duration_ms: Math.round(performance.now() - startTime) },
          workspaceRoot: manager.initialRoot ?? null,
          emitStderr: false,
        });
        return result;
      } catch (error) {
        SeptumTelemetry.recordSystemEvent({
          level: "ERROR",
          component: "resource",
          event: "resource_read_failed",
          fields: {
            uri: uri.slice(0, 128),
            duration_ms: Math.round(performance.now() - startTime),
            message: (error instanceof Error ? error.message : String(error)).slice(0, 256),
          },
          workspaceRoot: manager.initialRoot ?? null,
          emitStderr: false,
        });
        throw error;
      }
    }, manager.initialRoot);
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => listSeptumPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getSeptumPrompt(request.params.name, request.params.arguments)
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_CATALOG.map(({ name, description, inputSchema, _meta }) => ({ name, description, inputSchema, _meta })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const startTime = performance.now();
    const deadline = AbortSignal.timeout(RESOURCE_LIMITS.requestTimeoutMs);
    const signal = AbortSignal.any([extra.signal, deadline]);
    const traceId = randomBytes(16).toString("hex");
    let stage: ToolCallStage = "validation";
    let root: string | undefined;
    let action: string | undefined;
    const toolSpec = TOOL_CATALOG.find(entry => entry.name === name);
    const tool = toolSpec ? name : "unknown";
    const hasUiResource = Boolean((toolSpec?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri);
    const wantsStructured = (args && typeof args === "object" && (args as Record<string, unknown>).format === "json") || hasUiResource;
    const finish = <T extends ToolResponse>(response: T, error?: Error): T => {
      const shapedResponse = (() => {
        if (!response || typeof response !== "object") return response;
        const record = response as Record<string, unknown>;
        if (
          !wantsStructured &&
          record.structuredContent &&
          Array.isArray(record.content) &&
          record.content.length > 0
        ) {
          const { structuredContent: _omitted, ...withoutStructured } = record;
          return withoutStructured as unknown as T;
        }
        let structured = record.structuredContent;
        if (
          wantsStructured &&
          !structured &&
          Array.isArray(record.content) &&
          typeof (record.content[0] as { text?: unknown } | undefined)?.text === "string"
        ) {
          try {
            const parsed = JSON.parse((record.content[0] as { text: string }).text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              structured = parsed;
            }
          } catch {
            // Non-JSON text content; leave structuredContent unset
          }
        }
        if (wantsStructured && structured && typeof structured === "object") {
          const structuredRecord = structured as Record<string, unknown>;
          const withRoot =
            root && !("workspace_root" in structuredRecord) &&
              structuredRecord.code !== "BUDGET_RESPONSE_TOO_LARGE"
              ? { workspace_root: root, ...structuredRecord }
              : structured;
          if (withRoot !== record.structuredContent) {
            return {
              ...record,
              structuredContent: withRoot,
            } as unknown as T;
          }
        }
        return response;
      })();
      const code = error instanceof SeptumError ? error.code : undefined;
      SeptumTelemetry.recordToolResponse({
        trace_id: traceId,
        stage: extra.signal.aborted ? "cancelled" : deadline.aborted ? "timeout" : stage,
        tool,
        action,
        duration_ms: Math.round(performance.now() - startTime),
        input: root ? args ?? {} : {},
        error: error ? { code, message: root ? error.message : "Tool execution failed.", stack: root ? error.stack : undefined } : undefined,
      }, shapedResponse, root ?? manager.initialRoot ?? null, root !== undefined);
      return shapedResponse;
    };

    const progressToken = request.params._meta?.progressToken;
    const reportProgress = (progress: number, message: string) => {
      if (progressToken === undefined || signal.aborted) return;
      void extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message },
      }).catch(() => {});
    };

    return SeptumTelemetry.withTrace(traceId, async () => {
      let lease: WorkspaceLease | undefined;
      try {
      signal.throwIfAborted();
      let parsed;
      try { parsed = parseToolRequest(name, args); }
      catch (error) { throw new Error(`[Septum Validation Error] Invalid arguments for ${name}: ${error instanceof Error ? error.message : String(error)}`); }
      const record = parsed.args;
      action = parsed.name === "septum_map" || parsed.name === "septum_symbol"
        ? parsed.args.action
        : parsed.name === "septum_boundary" ? parsed.args.scope : undefined;
      stage = "workspace";
      const rawWorkspace = args && typeof args === "object" ? explicitWorkspaceAlias(args as Record<string, unknown>) : undefined;
      const workspacePath = record.workspace_path ?? (typeof rawWorkspace === "string" ? rawWorkspace : undefined);
      const knownRoots = manager.activeRoots;
      if (manager.initialRoot && !knownRoots.includes(manager.initialRoot)) {
        knownRoots.unshift(manager.initialRoot);
      }
      const fallbackRoot = manager.initialRoot || manager.lastRoot;
      root = resolveServerWorkspace({
        workspacePath,
        filePath: workspacePath ? undefined : extractPathHint(args),
        fallbackRoot,
        knownRoots,
      });

      if (!isWorkspaceInitialized(root)) {
        if (parsed.name === "septum_app" || (parsed.name === "septum_map" && parsed.args.action === "catalog")) {
          const runtimeVersion = await checkRuntimeVersion();
          const diagnostic = buildUnindexedCatalog(root, runtimeVersion);
          return finish({
            content: [
              {
                type: "text",
                text: JSON.stringify(diagnostic, null, 2),
              },
            ],
            structuredContent: diagnostic,
            metadata: diagnostic,
            runtime_version: runtimeVersion,
          });
        }
        const isRegistration = name === "septum_map" && "action" in record && record.action === "register";
        if (!isRegistration) {
          return finish({
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum MCP Error] Workspace '${root}' belum diinisialisasi. Jalankan 'septum init' di terminal workspace atau gunakan tool septum_map({action:'register', domain:'<name>', root:'<path>'}) untuk mendaftarkan domain.`,
              },
            ],
          });
        }
      }

      signal.throwIfAborted();
      const isDomainRegistration = parsed.name === "septum_map" && parsed.args.action === "register";
      reportProgress(1, "Preparing workspace");
      lease = manager.acquire(root, { deferDiscovery: isDomainRegistration });
      const onSync = () => reportProgress(2, "Checking index freshness");
      const onAudit = () => {
        stage = "execution";
        reportProgress(3, "Running tool");
      };
      const response = parsed.name === "septum_boundary" && parsed.args.scope !== "staged" && !parsed.args.staged
        ? await runWorkspaceBoundary(manager, lease.context, parsed.args, {
          signal, onSync, onAudit, onRetry: () => reportProgress(4, "Reconciling stale index before retrying audit"),
        })
        : await manager.runInWorkspace(lease.context, prepared => {
          onAudit();
          return parsed.execute(prepared, signal);
        }, {
          signal,
          isDomainRegistration,
          mode: isDomainRegistration || (parsed.name === "septum_slice" && lease.context.repo.getMeta("slices_dirty") === "1")
            ? "write"
            : "read",
          onSync,
        });
      return finish(response);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return finish({
        isError: true,
        content: [{ type: "text" as const, text: `[Septum MCP Error] ${failure.message}` }],
        metadata: { trace_id: traceId },
      }, failure);
    } finally {
      lease?.release();
    }
    }, manager.initialRoot);
  });

  return server;
}

export async function runMCPServer(): Promise<void> {
  const initialRoot = resolveServerWorkspace({ initial: true });
  const manager = new WorkspaceManager();
  manager.initialRoot = initialRoot;
  manager.lastRoot = initialRoot;
  const server = createMcpServer(manager);
  const transport = new StdioServerTransport();
  void checkRuntimeVersion().catch(() => {});

  let stopping = false;
  let memoryTimer: ReturnType<typeof setInterval> | undefined;
  const closeResources = async () => {
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    process.stdin.off("end", cleanup);
    process.stdin.off("close", cleanup);
    try {
      await server.close();
    } finally {
      await manager.close();
    }
  };
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
        await closeResources();
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
  try {
    await server.connect(transport);
    if (isWorkspaceInitialized(initialRoot)) {
      const initial = manager.acquire(initialRoot);
      try {
        await initial.context.ready;
      } catch (err) {
        SeptumTelemetry.recordSystemEvent({
          level: "WARN",
          component: "mcp_server",
          event: "initial_workspace_sync_failed",
          fields: { message: (err instanceof Error ? err.message : String(err)).slice(0, 256) },
          workspaceRoot: initialRoot,
          emitStderr: false,
        });
      } finally {
        initial.release();
      }
    }
    if (stopping) return;
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
    if (stopping) return;
    stopping = true;
    await closeResources();
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
