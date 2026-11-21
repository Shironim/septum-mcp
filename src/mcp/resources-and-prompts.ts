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

export async function readSeptumResource(manager: WorkspaceManager, uri: string, signal?: AbortSignal) {
  const validUri = SEPTUM_RESOURCES.some((r) => r.uri === uri);
  const domain = matchDomainResource(uri);
  if (!validUri && !domain) {
    throw new McpError(-32002, "Resource not found", { uri });
  }
  signal?.throwIfAborted();
  const root = manager.initialRoot ?? resolveServerWorkspace();
  if (uri === "septum://health") {
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
    const res = uri === "septum://boundaries"
      ? await runWorkspaceBoundary(manager, lease.context, { scope: "all", proposed_imports: [], proposed_imports_supplied: false, format: "json" }, {
        signal: requestSignal,
      })
      : await manager.runInWorkspace(lease.context, async ctx =>
        handleGetDomainCatalog(ctx.repo, ctx.config, { detail_level: "compact", domain, format: "json" }, ctx.root),
      { signal });
    return jsonResource(uri, res.content[0]!.text);
  } finally {
    lease.release();
  }
}
