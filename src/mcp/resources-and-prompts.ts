import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceManager } from "./workspace-manager.ts";
import { isWorkspaceInitialized, resolveServerWorkspace } from "./workspace-manager.ts";
import { handleGetDomainCatalog } from "./tools/map.ts";
import { runWorkspaceBoundary } from "./workspace-boundary.ts";
import { RESOURCE_LIMITS } from "../core/resources/limits.ts";

export const SEPTUM_RESOURCES = [
  {
    uri: "septum://domains",
    name: "Septum Domain Catalog",
    description: "Indexed domain catalog and cross-domain import adjacency for the server's initial workspace.",
    mimeType: "application/json",
  },
  {
    uri: "septum://health",
    name: "Septum Index Health",
    description: "Index status, last synchronization, and indexed counts for the server's initial workspace.",
    mimeType: "application/json",
  },
  {
    uri: "septum://boundaries",
    name: "Septum Boundary Audit",
    description: "Static boundary and circular-dependency audit of the server's initial workspace.",
    mimeType: "application/json",
  },
  {
    uri: "septum://apps",
    name: "Septum MCP Apps & Coverage Guide",
    description: "Interactive Septum MCP App entrypoints, active workspace coverage/partial-init diagnostics, and actionable next steps.",
    mimeType: "application/json",
  },
  {
    uri: "ui://septum/app.html",
    name: "Septum Architecture UI",
    description: "Interactive MCP App UI for Septum architecture navigation, vertical slices, and boundary audits.",
    mimeType: "text/html;profile=mcp-app",
    _meta: { ui: { prefersBorder: true } },
  },
] as const;

export { SEPTUM_PROMPTS, listSeptumPrompts, getSeptumPrompt } from "./workflow-playbooks.ts";

export function listSeptumResources() {
  return { resources: [...SEPTUM_RESOURCES] };
}

const DOMAIN_TEMPLATE = {
  uriTemplate: "septum://domain/{name}",
  name: "Septum Domain Detail",
  description: "Compact indexed navigation for one domain in the server's initial workspace.",
  mimeType: "application/json",
};

export function listSeptumResourceTemplates() {
  return { resourceTemplates: [DOMAIN_TEMPLATE] };
}

function matchDomainResource(uri: string): string | undefined {
  const match = /^septum:\/\/domain\/([^/?#]+)$/.exec(uri);
  if (!match) return;
  try {
    const domain = decodeURIComponent(match[1]!);
    if (domain.trim() && domain.length <= 256) return domain;
  } catch { /* Invalid URI encoding. */ }
}

function readIndexHealth(manager: WorkspaceManager, root: string) {
  const ctx = manager.peek(root);
  if (!ctx) {
    return {
      workspace_root: root,
      status: isWorkspaceInitialized(root) ? "inactive" : "not_indexed",
    };
  }

  const syncState = ctx.repo.getMeta("sync_state") ?? "unindexed";
  const syncError = ctx.repo.getMeta("sync_error") || undefined;
  return {
    workspace_root: ctx.root,
    status: syncError ? "error" : syncState,
    sync_state: syncState,
    sync_error: syncError,
    last_sync: ctx.repo.getMeta("last_sync"),
    domains_count: ctx.repo.getAllDomains().length,
    files_count: ctx.repo.countFiles(),
    slices_count: ctx.repo.countVerticalSlices(),
    watcher: {
      mode: ctx.watcher.mode,
      watch_count: ctx.watcher.watchCount,
      pending_paths: ctx.watcher.pendingCount,
      syncing: ctx.watcher.isBusy,
    },
  };
}

function jsonResource(uri: string, text: string) {
  return { contents: [{ uri, mimeType: "application/json", text }] };
}

function buildAppsGuide(manager: WorkspaceManager, root: string) {
  const initialized = isWorkspaceInitialized(root);
  const health = readIndexHealth(manager, root);
  const ctx = manager.peek(root);

  let unsupportedFiles: string[] = [];
  let skippedFiles: Array<{ path: string; reason?: string }> = [];
  let slicesDirty = false;
  if (ctx) {
    try { unsupportedFiles = JSON.parse(ctx.repo.getMeta("unsupported_files") || "[]"); } catch { /* ignore */ }
    try { skippedFiles = JSON.parse(ctx.repo.getMeta("skipped_files") || "[]"); } catch { /* ignore */ }
    slicesDirty = ctx.repo.getMeta("slices_dirty") === "1";
  }

  const actionableActions: Array<{ action: string; reason: string; command?: string; tool?: string }> = [];
  if (!initialized) {
    actionableActions.push({
      action: "Initialize Septum index",
      reason: "Workspace has not been initialized yet.",
      command: "septum init",
      tool: "septum_map({ action: 'register', name: 'core', root: 'src', ingest_now: true })",
    });
  } else {
    if (slicesDirty || health.sync_state !== "complete") {
      actionableActions.push({
        action: "Re-sync workspace index",
        reason: slicesDirty ? "Entrypoint slice catalog is marked dirty." : `Index state is '${health.sync_state}'.`,
        command: "septum sync",
      });
    }
    if (unsupportedFiles.length > 0) {
      actionableActions.push({
        action: "Review unsupported files",
        reason: `${unsupportedFiles.length} file(s) use extensions or languages not covered by Septum AST extractors.`,
      });
    }
    if (skippedFiles.length > 0) {
      actionableActions.push({
        action: "Review skipped files",
        reason: `${skippedFiles.length} file(s) were skipped during ingestion (e.g., outside registered domains or ignored).`,
        tool: "septum_map({ action: 'register', name: '<domain>', root: '<dir>', ingest_now: true })",
      });
    }
  }

  const coverageStatus = !initialized
    ? "not_indexed"
    : (health.sync_state === "complete" && !slicesDirty && unsupportedFiles.length === 0 && skippedFiles.length === 0)
      ? "complete"
      : "partial";

  return {
    workspace_root: root,
    ui_resource: "ui://septum/app.html",
    open_via_tools: ["septum_map", "septum_slice", "septum_boundary"],
    antigravity_entrypoints: [
      { type: "aux_pane", title: "Septum Architecture" },
      { type: "global", title: "Septum" },
    ],
    coverage_status: coverageStatus,
    health,
    partial_details: {
      unsupported_files_count: unsupportedFiles.length,
      unsupported_files_sample: unsupportedFiles.slice(0, 15),
      skipped_files_count: skippedFiles.length,
      skipped_files_sample: skippedFiles.slice(0, 15),
      slices_dirty: slicesDirty,
    },
    actionable_actions: actionableActions,
  };
}

function parseResourceUri(uri: string): { baseUri: string; workspaceParam?: string } {
  const qIdx = uri.indexOf("?");
  if (qIdx === -1) return { baseUri: uri };
  const baseUri = uri.slice(0, qIdx);
  const params = new URLSearchParams(uri.slice(qIdx + 1));
  const ws = params.get("workspace")?.trim();
  return { baseUri, workspaceParam: ws || undefined };
}

function loadSeptumAppHtml(): string {
  const envPath = process.env.SEPTUM_APP_HTML?.trim();
  const candidates = [
    ...(envPath ? [resolve(envPath)] : []),
    resolve(import.meta.dir, "ui/app.html"),
    resolve(process.cwd(), "src/mcp/ui/app.html"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
  }
  throw new Error("Septum Architecture UI bundle not found. Run 'bun run build:ui' or set SEPTUM_APP_HTML.");
}

export async function readSeptumResource(manager: WorkspaceManager, uri: string, signal?: AbortSignal) {
  const { baseUri, workspaceParam } = parseResourceUri(uri);
  const validUri = SEPTUM_RESOURCES.some((r) => r.uri === baseUri);
  const domain = matchDomainResource(baseUri);
  if (!validUri && !domain) {
    throw new McpError(-32002, "Resource not found", { uri });
  }
  signal?.throwIfAborted();
  if (baseUri === "ui://septum/app.html") {
    const html = loadSeptumAppHtml();
    return {
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    };
  }
  const root = workspaceParam
    ? resolveServerWorkspace({ workspacePath: workspaceParam, knownRoots: manager.activeRoots })
    : (manager.lastRoot ?? manager.initialRoot ?? resolveServerWorkspace());
  if (baseUri === "septum://apps") {
    return jsonResource(uri, JSON.stringify(buildAppsGuide(manager, root), null, 2));
  }
  if (baseUri === "septum://health") {
    return jsonResource(uri, JSON.stringify(readIndexHealth(manager, root)));
  }

  if (!isWorkspaceInitialized(root)) {
    return jsonResource(uri, JSON.stringify({
      status: "not_indexed",
      workspace_root: root,
      message: "Workspace is not initialized. Run 'septum init' or call septum_map(action='register').",
    }, null, 2));
  }

  const lease = manager.acquire(root);
  try {
    const deadline = AbortSignal.timeout(RESOURCE_LIMITS.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const res = baseUri === "septum://boundaries"
      ? await runWorkspaceBoundary(manager, lease.context, { scope: "all", proposed_imports: [], proposed_imports_supplied: false, format: "json" }, {
        signal: requestSignal,
      })
      : await manager.runInWorkspace(lease.context, async ctx =>
        handleGetDomainCatalog(ctx.repo, ctx.config, { detail_level: "compact", domain, format: "json" }, ctx.root),
      { signal: requestSignal });
    return jsonResource(uri, res.content[0]!.text);
  } finally {
    lease.release();
  }
}
