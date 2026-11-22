/// <reference lib="dom" />
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

type AnyRecord = Record<string, any>;
type TabKind = "map" | "slice" | "boundary";

interface WorkspaceViewState {
  map: AnyRecord | null;
  domainDetail: AnyRecord | null;
  slice: AnyRecord | null;
  boundary: AnyRecord | null;
  selectedDomains: Set<string>;
  selectedSliceNodes: Set<string>;
  selectedViolations: Set<string>;
}

const DEFAULT_WORKSPACE_KEY = "__default__";
const ToggleAuxPaneResultSchema = z.object({ isError: z.boolean().optional() }).passthrough();

const TAB_PRESETS: Record<TabKind, ReadonlyArray<{ label: string; prompt: string }>> = {
  map: [
    { label: "Explain architecture", prompt: "Explain the architecture and responsibilities of these domains." },
    { label: "Audit domain coupling", prompt: "Audit cross-domain dependencies and highlight tight coupling or risky edges." },
  ],
  slice: [
    { label: "Trace execution flow", prompt: "Trace and explain the step-by-step execution flow of this slice." },
    { label: "Check bugs / validation", prompt: "Inspect this execution chain for potential bugs, missing validation, or boundary issues." },
  ],
  boundary: [
    { label: "Fix violations", prompt: "Propose and apply clean fixes for these boundary violations without breaking domain rules." },
    { label: "Explain forbidden rules", prompt: "Explain why these imports violate domain policies and what the intended alternative is." },
  ],
};

const DEFAULT_ASK_PROMPT: Record<TabKind, string> = {
  map: "Analyze this Septum architecture context:",
  slice: "Analyze this Septum execution slice:",
  boundary: "Analyze this Septum boundary audit and suggest remediations:",
};

const app = new App({ name: "Septum Architecture", version: "0.4.0" });

let currentTab: TabKind = "map";
let activeWorkspace: string | undefined;
let pendingWorkspaceRoot: string | undefined;
const knownWorkspaces: string[] = [];
const workspaceStates = new Map<string, WorkspaceViewState>();
let promptDraft = "";
let lastError: string | null = null;
let statusMessage = "";
let loading = false;

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getWorkspaceKey(root?: string): string {
  const trimmed = root?.trim();
  return trimmed || DEFAULT_WORKSPACE_KEY;
}

function createEmptyWorkspaceState(): WorkspaceViewState {
  return {
    map: null,
    domainDetail: null,
    slice: null,
    boundary: null,
    selectedDomains: new Set<string>(),
    selectedSliceNodes: new Set<string>(),
    selectedViolations: new Set<string>(),
  };
}

function getWorkspaceState(root?: string): WorkspaceViewState {
  const key = getWorkspaceKey(root);
  let state = workspaceStates.get(key);
  if (!state) {
    state = createEmptyWorkspaceState();
    workspaceStates.set(key, state);
  }
  return state;
}

function registerWorkspace(root?: string): void {
  const trimmed = root?.trim();
  if (!trimmed) return;
  if (!knownWorkspaces.includes(trimmed)) {
    knownWorkspaces.push(trimmed);
  }
  if (knownWorkspaces.length === 1 && workspaceStates.has(DEFAULT_WORKSPACE_KEY)) {
    const fallback = workspaceStates.get(DEFAULT_WORKSPACE_KEY)!;
    const target = getWorkspaceState(trimmed);
    target.map ??= fallback.map;
    target.domainDetail ??= fallback.domainDetail;
    target.slice ??= fallback.slice;
    target.boundary ??= fallback.boundary;
    workspaceStates.delete(DEFAULT_WORKSPACE_KEY);
  }
  activeWorkspace = trimmed;
}

function shortWorkspaceLabel(root: string): string {
  const parts = root.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

function applyTheme(ctx: AnyRecord | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

function setStatus(msg: string) {
  statusMessage = msg;
  const el = document.getElementById("status-bar");
  if (el) el.textContent = loading ? "Loading..." : msg;
}

function detectPayloadKind(data: AnyRecord): TabKind | null {
  if (!data || typeof data !== "object") return null;
  if (data.schema === "navigation/v1" || Array.isArray(data.domains) || Array.isArray(data.files)) return "map";
  if ("entrypoint" in data || Array.isArray(data.chain)) return "slice";
  if ("scope" in data && ("total_violations" in data || "violations" in data || "status" in data)) return "boundary";
  return null;
}

function ingestToolResult(result: AnyRecord, explicitWorkspace?: string) {
  lastError = null;
  let data: AnyRecord | null = (result?.structuredContent as AnyRecord) ?? null;
  if (!data && Array.isArray(result?.content)) {
    const textBlock = result.content.find((c: AnyRecord) => c?.type === "text" && typeof c.text === "string");
    if (textBlock) {
      try {
        data = JSON.parse(textBlock.text);
      } catch {
        // Text-only response without JSON payload
      }
    }
  }
  if (!data) {
    if (result?.isError) {
      const msg = result?.content?.[0]?.text ?? "Tool execution failed.";
      lastError = String(msg);
    }
    setStatus("");
    render();
    return;
  }

  const resolvedRoot =
    typeof data.workspace_root === "string" && data.workspace_root.trim()
      ? data.workspace_root.trim()
      : explicitWorkspace ?? pendingWorkspaceRoot ?? activeWorkspace;
  if (resolvedRoot) {
    registerWorkspace(resolvedRoot);
  }
  pendingWorkspaceRoot = undefined;

  const kind = detectPayloadKind(data);
  const wsState = getWorkspaceState(resolvedRoot ?? activeWorkspace);
  if (kind === "map") {
    if (Array.isArray(data.files) && data.files.length > 0 && !Array.isArray(data.domains)) {
      wsState.domainDetail = data;
    } else {
      wsState.map = data;
      wsState.domainDetail = null;
      wsState.selectedDomains.clear();
    }
    currentTab = "map";
  } else if (kind === "slice") {
    wsState.slice = data;
    wsState.selectedSliceNodes.clear();
    currentTab = "slice";
  } else if (kind === "boundary") {
    wsState.boundary = data;
    wsState.selectedViolations.clear();
    currentTab = "boundary";
  }
  setStatus("");
  render();
}

function toFileUri(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  return norm.startsWith("/") ? `file://${encodeURI(norm)}` : `file:///${encodeURI(norm)}`;
}

async function openFileInPane(relOrAbsPath: string) {
  if (!relOrAbsPath) return;
  const fullPath =
    relOrAbsPath.startsWith("/") || !activeWorkspace
      ? relOrAbsPath
      : `${activeWorkspace.replace(/\/+$/, "")}/${relOrAbsPath.replace(/^\/+/, "")}`;
  try {
    const res = await app.request(
      {
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri: toFileUri(fullPath) },
      },
      ToggleAuxPaneResultSchema
    );
    if (res?.isError) {
      setStatus(`Cannot open side pane for ${relOrAbsPath} on this surface.`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("-32601")) {
      setStatus(`Side pane navigation is unavailable in this host (${relOrAbsPath}).`);
    } else {
      setStatus(`Open file failed: ${msg}`);
    }
  }
}

function sliceNodeKey(node: AnyRecord, idx: number): string {
  return `${idx}:${node.symbol ?? ""}:${node.file ?? ""}:${node.line ?? ""}`;
}

function violationKey(v: AnyRecord, idx: number): string {
  return `${idx}:${v.rule ?? ""}:${v.file ?? ""}:${v.line ?? ""}`;
}

function getSelectionCount(tab: TabKind, wsState: WorkspaceViewState): number {
  if (tab === "map") return wsState.selectedDomains.size;
  if (tab === "slice") return wsState.selectedSliceNodes.size;
  return wsState.selectedViolations.size;
}

function clearSelection(tab: TabKind, wsState: WorkspaceViewState): void {
  if (tab === "map") wsState.selectedDomains.clear();
  else if (tab === "slice") wsState.selectedSliceNodes.clear();
  else wsState.selectedViolations.clear();
}

function buildCompactContext(tab: TabKind, wsState: WorkspaceViewState): string | null {
  const lines: string[] = [];
  if (activeWorkspace) lines.push(`Workspace: ${activeWorkspace}`);

  if (tab === "map" && wsState.map) {
    const d = wsState.map;
    const allDomains: AnyRecord[] = d.domains ?? [];
    const selected = wsState.selectedDomains;
    const focusedDomains = selected.size > 0
      ? allDomains.filter((dom) => selected.has(String(dom.name)))
      : allDomains;

    const health = d.health ?? {};
    lines.push(`# Septum Architecture (index=${health.index ?? d.status ?? "unknown"}, coverage=${health.coverage ?? "unknown"}, unresolved=${health.unresolved_imports ?? 0})`);

    if (wsState.domainDetail) {
      const dd = wsState.domainDetail;
      const files: AnyRecord[] = dd.files ?? [];
      lines.push(`\n## Focused Domain Files (${files.length})`);
      for (const f of files.slice(0, 30)) {
        lines.push(`- ${f.path}${f.archetype ? ` [${f.archetype}]` : ""}`);
      }
      if (files.length > 30) lines.push(`- ... +${files.length - 30} more files`);
    }

    if (focusedDomains.length > 0) {
      lines.push(`\n## Domains (${selected.size > 0 ? `${focusedDomains.length} selected` : focusedDomains.length})`);
      for (const dom of focusedDomains) {
        const allow = dom.allowed_dependencies?.length ? ` allow=[${dom.allowed_dependencies.join(",")}]` : "";
        const forbid = dom.forbidden_dependencies?.length ? ` forbid=[${dom.forbidden_dependencies.join(",")}]` : "";
        lines.push(`- ${dom.name} (${dom.root}, ${dom.file_count ?? 0} files)${allow}${forbid}`);
      }
    }

    const deps: AnyRecord[] = (d.dependencies ?? []).filter((dep: AnyRecord) =>
      selected.size === 0 || selected.has(String(dep.from)) || selected.has(String(dep.to))
    );
    if (deps.length > 0) {
      lines.push(`\n## Dependencies (${deps.length})`);
      for (const dep of deps.slice(0, 20)) {
        lines.push(`- ${dep.from} -> ${dep.to} (x${dep.count ?? 1})`);
      }
    }

    const entrypoints: AnyRecord[] = d.entrypoints ?? [];
    if (entrypoints.length > 0 && selected.size === 0) {
      lines.push(`\n## Entrypoints (${entrypoints.length})`);
      for (const ep of entrypoints.slice(0, 15)) {
        lines.push(`- [${ep.method}] ${ep.target} (${ep.file})`);
      }
    }
    return lines.join("\n");
  }

  if (tab === "slice" && wsState.slice) {
    const s = wsState.slice;
    const ep = s.entrypoint;
    const chain: AnyRecord[] = s.chain ?? [];
    lines.push(`# Septum Slice: ${s.query ?? "entrypoint"} [status=${s.status ?? "unknown"}, confidence=${s.confidence ?? "-"}, style=${s.architecture_style ?? "-"}]`);
    if (ep) {
      lines.push(`Entrypoint: [${ep.method}] ${ep.uri} -> ${ep.controller}::${ep.action} (${ep.file}:${ep.line})`);
    }
    const selected = wsState.selectedSliceNodes;
    const nodes = selected.size > 0
      ? chain.filter((n, idx) => selected.has(sliceNodeKey(n, idx)))
      : chain;
    if (nodes.length > 0) {
      lines.push(`\n## Execution Chain (${selected.size > 0 ? `${nodes.length} selected` : nodes.length})`);
      for (const n of nodes.slice(0, 20)) {
        lines.push(`- [${n.stage}] ${n.symbol}${n.file ? ` @ ${n.file}:${n.line ?? ""}` : ""}${n.description ? ` — ${n.description}` : ""}`);
      }
    } else if (s.message) {
      lines.push(s.message);
    }
    return lines.join("\n");
  }

  if (tab === "boundary" && wsState.boundary) {
    const b = wsState.boundary;
    const violations: AnyRecord[] = b.violations ?? [];
    const selected = wsState.selectedViolations;
    const focused = selected.size > 0
      ? violations.filter((v, idx) => selected.has(violationKey(v, idx)))
      : violations;
    lines.push(`# Septum Boundary Audit [verdict=${b.status}, scope=${b.scope ?? "-"}, violations=${b.total_violations ?? violations.length}, cycles=${b.circular_dependencies_count ?? 0}]`);
    if (focused.length > 0) {
      lines.push(`\n## Violations (${selected.size > 0 ? `${focused.length} selected` : focused.length})`);
      for (const v of focused.slice(0, 20)) {
        lines.push(`- [${v.rule ?? "violation"}] ${v.source_domain} -> ${v.target_domain} @ ${v.file ?? "?"}:${v.line ?? "?"} (${v.message ?? v.target ?? ""})`);
      }
    } else if (b.message) {
      lines.push(b.message);
    }
    return lines.join("\n");
  }

  return null;
}

async function sendAiAction(mode: "context" | "message", explicitPrompt?: string) {
  const wsState = getWorkspaceState(activeWorkspace);
  const context = buildCompactContext(currentTab, wsState);
  if (!context) return;
  const caps = app.getHostCapabilities();

  try {
    if (mode === "context") {
      if (!caps?.updateModelContext) return;
      await app.updateModelContext({ content: [{ type: "text", text: context }] });
      const selCount = getSelectionCount(currentTab, wsState);
      setStatus(selCount > 0 ? `Attached ${selCount} selected item(s) to chat context.` : `Attached ${currentTab} context to chat.`);
      return;
    }

    const instruction = (explicitPrompt ?? promptDraft).trim() || DEFAULT_ASK_PROMPT[currentTab];
    const messageText = `${instruction}\n\n${context}`;
    if (caps?.message) {
      await app.sendMessage({ role: "user", content: [{ type: "text", text: messageText }] });
      if (!explicitPrompt && promptDraft.trim()) {
        promptDraft = "";
        const inp = document.getElementById("ai-prompt-input") as HTMLInputElement | null;
        if (inp) inp.value = "";
      }
      setStatus("Sent instruction + Septum context to conversation.");
    } else if (caps?.updateModelContext) {
      await app.updateModelContext({ content: [{ type: "text", text: messageText }] });
      setStatus("Host does not support direct messages; attached to model context instead.");
    }
  } catch (err: unknown) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
}

async function inspectDomain(domainName: string) {
  const caps = app.getHostCapabilities();
  if (!caps?.serverTools || !domainName) return;
  loading = true;
  lastError = null;
  render();
  try {
    const res = await app.callServerTool({
      name: "septum_map",
      arguments: {
        action: "catalog",
        domain: domainName,
        detail_level: "compact",
        format: "json",
        ...(activeWorkspace ? { workspace_path: activeWorkspace } : {}),
      },
    });
    ingestToolResult(res as AnyRecord, activeWorkspace);
  } catch (err: unknown) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
    render();
  }
}

async function refreshActiveTab(targetWorkspace = activeWorkspace) {
  const caps = app.getHostCapabilities();
  if (!caps?.serverTools) return;
  if (currentTab === "slice") {
    render();
    return;
  }
  loading = true;
  lastError = null;
  render();
  try {
    if (currentTab === "map") {
      const res = await app.callServerTool({
        name: "septum_map",
        arguments: {
          action: "catalog",
          format: "json",
          ...(targetWorkspace ? { workspace_path: targetWorkspace } : {}),
        },
      });
      ingestToolResult(res as AnyRecord, targetWorkspace);
    } else if (currentTab === "boundary") {
      const res = await app.callServerTool({
        name: "septum_boundary",
        arguments: {
          scope: "all",
          format: "json",
          ...(targetWorkspace ? { workspace_path: targetWorkspace } : {}),
        },
      });
      ingestToolResult(res as AnyRecord, targetWorkspace);
    }
  } catch (err: unknown) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
    render();
  }
}

function renderCoverageNotice(d: AnyRecord): string {
  if (d.status === "NOT_INDEXED") {
    return `
      <div class="warn-box">
        <div><strong>Workspace Not Initialized</strong> — ${esc(d.message ?? "Septum has not indexed this workspace yet.")}</div>
        <ul>
          <li>Run <code>septum init</code> in the workspace terminal, or</li>
          <li>Register a domain via <code>septum_map({ action: "register", name: "core", root: "src", ingest_now: true })</code>.</li>
        </ul>
        <div><button type="button" class="mini-btn" id="btn-fix-coverage">Ask AI to Initialize</button></div>
      </div>
    `;
  }

  const health = d.health ?? {};
  const reasons: string[] = Array.isArray(health.reasons) ? health.reasons : [];
  const unsupported = Number(health.unsupported_files ?? 0);
  const skipped = Number(health.skipped_files ?? 0);
  const unresolved = Number(health.unresolved_imports ?? 0);
  const syncNeeded = Boolean(health.sync_needed);
  const isPartial =
    health.coverage === "partial" ||
    (health.index && health.index !== "complete") ||
    syncNeeded ||
    unsupported > 0 ||
    skipped > 0 ||
    unresolved > 0;

  if (!isPartial) return "";

  const actions: string[] = [];
  if (syncNeeded || (health.index && health.index !== "complete")) {
    actions.push("Run <code>septum sync</code> to refresh stale or incomplete index state.");
  }
  if (skipped > 0) {
    actions.push(`${skipped} file(s) skipped — register missing directories with <code>septum_map(action="register")</code> or review <code>ignore_patterns</code>.`);
  }
  if (unsupported > 0) {
    actions.push(`${unsupported} file(s) use unsupported extensions/languages and are excluded from AST slicing.`);
  }
  if (unresolved > 0) {
    actions.push(`${unresolved} unresolved import(s) — verify path aliases / <code>tsconfig.json</code> or missing packages.`);
  }
  if (actions.length === 0) {
    actions.push("Check <code>septum://apps</code> or run <code>septum sync</code> to inspect coverage details.");
  }

  return `
    <div class="warn-box">
      <div><strong>Partial Index Coverage</strong>${reasons.length ? ` <span class="badge">${esc(reasons.join(", "))}</span>` : ""}</div>
      <ul>${actions.map((a) => `<li>${a}</li>`).join("")}</ul>
      <div><button type="button" class="mini-btn" id="btn-fix-coverage">Ask AI to Resolve Gaps</button></div>
    </div>
  `;
}

function renderMap(wsState: WorkspaceViewState, canCallTools: boolean): string {
  const d = wsState.map;
  if (!d) {
    return `<div class="empty">Run <code>septum_map</code> or click Refresh to load the workspace architecture.</div>`;
  }
  const health = d.health ?? {};
  const domains: AnyRecord[] = d.domains ?? [];
  const deps: AnyRecord[] = d.dependencies ?? [];
  const entrypoints: AnyRecord[] = d.entrypoints ?? [];
  const dd = wsState.domainDetail;
  const ddFiles: AnyRecord[] = dd?.files ?? [];

  return `
    <div class="stats">
      <div class="stat"><span class="label">Index</span><span class="val">${esc(health.index ?? d.status ?? "unknown")}</span></div>
      <div class="stat"><span class="label">Coverage</span><span class="val">${esc(health.coverage ?? "unknown")}</span></div>
      <div class="stat"><span class="label">Domains</span><span class="val">${domains.length}</span></div>
      <div class="stat"><span class="label">Unresolved</span><span class="val">${esc(health.unresolved_imports ?? 0)}</span></div>
    </div>
    ${renderCoverageNotice(d)}
    ${
      dd
        ? `<div class="bar">
             <h3>Domain Files (${ddFiles.length})</h3>
             <button class="mini-btn" id="btn-close-domain">Back to Domains</button>
           </div>
           <div class="list">
             ${ddFiles
               .slice(0, 40)
               .map(
                 (f) => `
               <div class="row clickable" data-file="${esc(f.path)}">
                 <code>${esc(f.path)}</code>
                 <span class="badge">${esc(f.archetype ?? "file")}</span>
               </div>`
               )
               .join("")}
           </div>`
        : ""
    }
    ${
      domains.length
        ? `<h3>Domains</h3>
           <div class="grid">
             ${domains
               .map((dom) => {
                 const name = String(dom.name ?? "");
                 const checked = wsState.selectedDomains.has(name);
                 return `
               <div class="card ${checked ? "selected" : ""}">
                 <div class="card-title" style="justify-content:space-between">
                   <label class="chk-wrap">
                     <input type="checkbox" class="chk sel-domain" value="${esc(name)}" ${checked ? "checked" : ""} />
                     <span>${esc(name)}</span>
                     <span class="badge">${esc(dom.file_count ?? 0)} files</span>
                   </label>
                   ${canCallTools ? `<button class="mini-btn" data-inspect-domain="${esc(name)}">Files</button>` : ""}
                 </div>
                 <div class="muted">${esc(dom.root)}</div>
                 ${dom.allowed_dependencies?.length ? `<div class="meta">Allow: ${esc(dom.allowed_dependencies.join(", "))}</div>` : ""}
                 ${dom.forbidden_dependencies?.length ? `<div class="meta danger">Forbid: ${esc(dom.forbidden_dependencies.join(", "))}</div>` : ""}
               </div>`;
               })
               .join("")}
           </div>`
        : ""
    }
    ${
      deps.length
        ? `<h3>Dependencies (${deps.length})</h3>
           <div class="list">
             ${deps
               .slice(0, 25)
               .map(
                 (dep) => `
               <div class="row">
                 <span><code>${esc(dep.from)}</code> &rarr; <code>${esc(dep.to)}</code></span>
                 <span class="badge">${esc(dep.count ?? 1)}</span>
               </div>`
               )
               .join("")}
           </div>`
        : ""
    }
    ${
      entrypoints.length
        ? `<h3>Entrypoints (${entrypoints.length})</h3>
           <div class="list">
             ${entrypoints
               .slice(0, 20)
               .map(
                 (ep) => `
               <div class="row clickable" data-file="${esc(ep.file)}">
                 <span><span class="badge">${esc(ep.method)}</span> <code>${esc(ep.target)}</code></span>
                 <span class="muted">${esc(ep.file)}</span>
               </div>`
               )
               .join("")}
           </div>`
        : ""
    }
  `;
}

function renderSlice(wsState: WorkspaceViewState): string {
  const s = wsState.slice;
  if (!s) {
    return `<div class="empty">Run <code>septum_slice</code> to inspect an HTTP, GraphQL, or CLI execution chain.</div>`;
  }
  const ep = s.entrypoint;
  const chain: AnyRecord[] = s.chain ?? [];
  return `
    <div class="stats">
      <div class="stat"><span class="label">Status</span><span class="val">${esc(s.status ?? (s.found ? "success" : "not_found"))}</span></div>
      <div class="stat"><span class="label">Confidence</span><span class="val">${esc(s.confidence ?? "-")}</span></div>
      <div class="stat"><span class="label">Style</span><span class="val">${esc(s.architecture_style ?? "-")}</span></div>
    </div>
    ${
      ep
        ? `<div class="card clickable" data-file="${esc(ep.file)}">
             <div class="card-title"><span class="badge">${esc(ep.method)}</span> ${esc(ep.uri)}</div>
             <div class="muted">${esc(ep.controller)}::${esc(ep.action)} (${esc(ep.file)}:${esc(ep.line)})</div>
           </div>`
        : `<div class="empty">${esc(s.message ?? "No matching slice found.")}</div>`
    }
    ${
      chain.length
        ? `<h3>Execution Chain (${chain.length})</h3>
           <div class="list">
             ${chain
               .map((node, idx) => {
                 const key = sliceNodeKey(node, idx);
                 const checked = wsState.selectedSliceNodes.has(key);
                 return `
               <div class="row ${checked ? "selected" : ""}">
                 <div class="chk-wrap">
                   <input type="checkbox" class="chk sel-slice" value="${esc(key)}" ${checked ? "checked" : ""} />
                   <div class="${node.file ? "clickable" : ""}" data-file="${esc(node.file ?? "")}">
                     <span class="badge">${esc(node.stage)}</span>
                     <strong>${esc(node.symbol)}</strong>
                     <div class="muted">${esc(node.description ?? "")}</div>
                   </div>
                 </div>
                 <span class="muted ${node.file ? "clickable" : ""}" data-file="${esc(node.file ?? "")}">${node.file ? `${esc(node.file)}:${esc(node.line ?? "")}` : esc(node.relationship?.derivation ?? "")}</span>
               </div>`;
               })
               .join("")}
           </div>`
        : ""
    }
  `;
}

function renderBoundary(wsState: WorkspaceViewState): string {
  const b = wsState.boundary;
  if (!b) {
    return `<div class="empty">Run <code>septum_boundary</code> or click Refresh to audit domain boundaries.</div>`;
  }
  const violations: AnyRecord[] = b.violations ?? [];
  const statusClass = b.status === "approved" ? "ok" : b.status === "rejected" ? "danger" : "warn";
  return `
    <div class="stats">
      <div class="stat"><span class="label">Verdict</span><span class="val ${statusClass}">${esc(b.status)}</span></div>
      <div class="stat"><span class="label">Scope</span><span class="val">${esc(b.scope ?? "-")}</span></div>
      <div class="stat"><span class="label">Violations</span><span class="val">${esc(b.total_violations ?? violations.length)}</span></div>
      <div class="stat"><span class="label">Cycles</span><span class="val">${esc(b.circular_dependencies_count ?? 0)}</span></div>
    </div>
    <p class="muted">${esc(b.message ?? "")}</p>
    ${
      violations.length
        ? `<h3>Violations (${violations.length})</h3>
           <div class="list">
             ${violations
               .slice(0, 25)
               .map((v, idx) => {
                 const key = violationKey(v, idx);
                 const checked = wsState.selectedViolations.has(key);
                 return `
               <div class="row ${checked ? "selected" : ""}">
                 <div class="chk-wrap">
                   <input type="checkbox" class="chk sel-violation" value="${esc(key)}" ${checked ? "checked" : ""} />
                   <div class="${v.file ? "clickable" : ""}" data-file="${esc(v.file ?? "")}">
                     <span class="badge danger">${esc(v.rule ?? "violation")}</span>
                     <code>${esc(v.source_domain)}</code> &rarr; <code>${esc(v.target_domain)}</code>
                     <div class="muted">${esc(v.message ?? v.target ?? "")}</div>
                   </div>
                 </div>
                 <span class="muted ${v.file ? "clickable" : ""}" data-file="${esc(v.file ?? "")}">${esc(v.file ?? "")}:${esc(v.line ?? "")}</span>
               </div>`;
               })
               .join("")}
           </div>`
        : ""
    }
  `;
}

function renderWorkspaceBadge(): string {
  if (knownWorkspaces.length > 1) {
    return `<select id="workspace-select" class="scope-select" title="${esc(activeWorkspace ?? "")}">
      ${knownWorkspaces
        .map(
          (ws) =>
            `<option value="${esc(ws)}" ${ws === activeWorkspace ? "selected" : ""}>${esc(shortWorkspaceLabel(ws))}</option>`
        )
        .join("")}
    </select>`;
  }
  if (activeWorkspace) {
    return `<span class="scope-pill" title="${esc(activeWorkspace)}">${esc(shortWorkspaceLabel(activeWorkspace))}</span>`;
  }
  return "";
}

function renderAiBar(wsState: WorkspaceViewState, canMessage: boolean, canUpdateCtx: boolean): string {
  if (!canMessage && !canUpdateCtx) return "";
  const selCount = getSelectionCount(currentTab, wsState);
  const presets = TAB_PRESETS[currentTab];
  return `
    <section class="ai-bar">
      <div class="preset-row">
        <span class="muted">${selCount > 0 ? `${selCount} selected` : `All ${currentTab}`}</span>
        ${selCount > 0 ? `<button type="button" class="mini-btn" id="btn-clear-sel">Clear</button>` : ""}
        ${presets
          .map((p, i) => `<button type="button" class="chip" data-preset="${i}">${esc(p.label)}</button>`)
          .join("")}
      </div>
      <form id="ai-prompt-form" class="prompt-form">
        <input id="ai-prompt-input" class="prompt-input" type="text" placeholder="Instruct AI about ${esc(selCount > 0 ? `${selCount} selected item(s)` : `this ${currentTab}`)}..." value="${esc(promptDraft)}" />
        ${canUpdateCtx ? `<button type="button" class="btn" id="btn-attach">Attach Context</button>` : ""}
        ${canMessage ? `<button type="submit" class="btn primary-btn" id="btn-ask-ai">Ask AI</button>` : ""}
      </form>
    </section>
  `;
}

function render() {
  const root = document.getElementById("root");
  if (!root) return;
  const caps = app.getHostCapabilities();
  const canCallTools = Boolean(caps?.serverTools);
  const canUpdateCtx = Boolean(caps?.updateModelContext);
  const canMessage = Boolean(caps?.message);

  const wsState = getWorkspaceState(activeWorkspace);
  const hasActivePayload = Boolean(wsState[currentTab]);
  const body =
    currentTab === "map"
      ? renderMap(wsState, canCallTools)
      : currentTab === "slice"
        ? renderSlice(wsState)
        : renderBoundary(wsState);

  root.innerHTML = `
    <div class="shell">
      <header class="bar">
        <div class="brand">
          <div class="tabs">
            <button class="tab ${currentTab === "map" ? "active" : ""}" data-tab="map">Architecture</button>
            <button class="tab ${currentTab === "slice" ? "active" : ""}" data-tab="slice">Slice</button>
            <button class="tab ${currentTab === "boundary" ? "active" : ""}" data-tab="boundary">Boundary</button>
          </div>
          ${renderWorkspaceBadge()}
        </div>
        <div class="actions">
          ${canCallTools && currentTab !== "slice" ? `<button class="btn" id="btn-refresh">Refresh</button>` : ""}
        </div>
      </header>
      ${hasActivePayload ? renderAiBar(wsState, canMessage, canUpdateCtx) : ""}
      <div id="status-bar" class="status-bar">${loading ? "Loading..." : esc(statusMessage)}</div>
      ${lastError ? `<div class="alert">${esc(lastError)}</div>` : ""}
      <main>${body}</main>
    </div>
  `;

  root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
    btn.onclick = () => {
      const next = btn.dataset.tab as TabKind;
      currentTab = next;
      const curState = getWorkspaceState(activeWorkspace);
      if ((next === "boundary" || next === "map") && !curState[next] && canCallTools) {
        void refreshActiveTab(activeWorkspace);
      } else {
        render();
      }
    };
  });

  const wsSelect = document.getElementById("workspace-select") as HTMLSelectElement | null;
  if (wsSelect) {
    wsSelect.onchange = () => {
      activeWorkspace = wsSelect.value;
      const nextState = getWorkspaceState(activeWorkspace);
      if ((currentTab === "map" || currentTab === "boundary") && !nextState[currentTab] && canCallTools) {
        void refreshActiveTab(activeWorkspace);
      } else {
        render();
      }
    };
  }

  root.querySelectorAll<HTMLInputElement>(".sel-domain").forEach((chk) => {
    chk.onchange = () => {
      if (chk.checked) wsState.selectedDomains.add(chk.value);
      else wsState.selectedDomains.delete(chk.value);
      render();
    };
  });
  root.querySelectorAll<HTMLInputElement>(".sel-slice").forEach((chk) => {
    chk.onchange = () => {
      if (chk.checked) wsState.selectedSliceNodes.add(chk.value);
      else wsState.selectedSliceNodes.delete(chk.value);
      render();
    };
  });
  root.querySelectorAll<HTMLInputElement>(".sel-violation").forEach((chk) => {
    chk.onchange = () => {
      if (chk.checked) wsState.selectedViolations.add(chk.value);
      else wsState.selectedViolations.delete(chk.value);
      render();
    };
  });

  root.querySelectorAll<HTMLButtonElement>("[data-inspect-domain]").forEach((btn) => {
    btn.onclick = () => {
      const dom = btn.dataset.inspectDomain;
      if (dom) void inspectDomain(dom);
    };
  });
  document.getElementById("btn-close-domain")?.addEventListener("click", () => {
    wsState.domainDetail = null;
    render();
  });

  root.querySelectorAll<HTMLElement>(".clickable[data-file]").forEach((el) => {
    el.onclick = () => {
      const file = el.dataset.file;
      if (file) void openFileInPane(file);
    };
  });

  const promptInput = document.getElementById("ai-prompt-input") as HTMLInputElement | null;
  if (promptInput) {
    promptInput.oninput = () => {
      promptDraft = promptInput.value;
    };
  }
  document.getElementById("ai-prompt-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    void sendAiAction("message");
  });
  root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.preset);
      const preset = TAB_PRESETS[currentTab][idx];
      if (preset) void sendAiAction("message", preset.prompt);
    };
  });
  document.getElementById("btn-clear-sel")?.addEventListener("click", () => {
    clearSelection(currentTab, wsState);
    render();
  });
  document.getElementById("btn-refresh")?.addEventListener("click", () => void refreshActiveTab(activeWorkspace));
  document.getElementById("btn-attach")?.addEventListener("click", () => void sendAiAction("context"));
  document.getElementById("btn-fix-coverage")?.addEventListener("click", () => {
    const prompt = wsState.map?.status === "NOT_INDEXED"
      ? "Initialize or register Septum domains for this workspace so architecture coverage becomes complete."
      : "Inspect the partial index coverage diagnostics (skipped/unsupported files, unresolved imports, or dirty state) and guide or apply the appropriate fix.";
    void sendAiAction("message", prompt);
  });
}

app.ontoolinput = ({ arguments: args }: AnyRecord) => {
  if (args && typeof args.workspace_path === "string" && args.workspace_path.trim()) {
    pendingWorkspaceRoot = args.workspace_path.trim();
  }
  setStatus("Running Septum analysis...");
};

app.ontoolresult = (result: AnyRecord) => {
  ingestToolResult(result);
};

app.onhostcontextchanged = (ctx: AnyRecord) => {
  applyTheme(ctx);
};

async function boot() {
  render();
  try {
    await app.connect();
    applyTheme(app.getHostContext() as AnyRecord | undefined);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    render();
  }
}

void boot();
