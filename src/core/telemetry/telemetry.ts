import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SeptumToolCallMetrics {
  bytes_out?: number;
  lines_out?: number;
  estimated_tokens?: number;
  nodes_returned?: number;
  response_bytes?: number;
}

export interface SeptumOutputDigest {
  summary?: string;
  sample_preview?: string;
}

export type ToolCallStage = "validation" | "workspace" | "execution" | "cancelled" | "timeout";

export interface ToolResponse {
  content?: ReadonlyArray<{ text?: unknown }>;
  metadata?: unknown;
  isError?: boolean;
}

export interface SeptumToolCallEvent {
  trace_id?: string;
  stage?: ToolCallStage;
  timestamp?: string;
  event: "tool_call_completed" | "tool_call_failed";
  tool: string;
  action?: string;
  duration_ms: number;
  input: Record<string, any>;
  metrics?: SeptumToolCallMetrics;
  bloat_alert?: boolean;
  output_digest?: SeptumOutputDigest;
  session?: {
    feature_key?: string | null;
    domain?: string | null;
  } | null;
  status: "success" | "error";
  outcome?: string;
  error?: {
    code?: string;
    message: string;
    stack?: string;
  };
}

const SAFE_ACTIONS = new Set(["locate", "context", "inspect", "impact", "catalog", "register", "file", "staged", "all", "domain", "compact", "full", "deep", "source"]);
const OUTCOMES = new Set(["success", "partial", "unknown", "approved", "rejected", "ambiguous", "not_found", "NOT_INDEXED", "stale_reference", "invalid_context_options", "budget_too_small"]);

function errorCodeFromMetadata(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("code" in value)) return;
  const code = value.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

function outcomeFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const status = record.status ?? (record.found === false ? "not_found" : undefined);
  return typeof status === "string" && OUTCOMES.has(status) ? status : undefined;
}

export interface SeptumTraceContext {
  traceId: string;
  workspaceRoot?: string;
}

export type SeptumSystemLevel = "INFO" | "WARN" | "ERROR";

export class SeptumTelemetry {
  private static readonly traceStorage = new AsyncLocalStorage<SeptumTraceContext>();
  public static readonly MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
  public static readonly MAX_EVENT_BYTES = 4096;
  public static readonly SLOW_EXECUTION_THRESHOLD_MS = 250;
  public static readonly BLOAT_BYTE_THRESHOLD = 16 * 1024; // Serialized output byte threshold.

  public static withTrace<T>(traceId: string, fn: () => T, workspaceRoot?: string): T {
    return this.traceStorage.run({ traceId, workspaceRoot }, fn);
  }

  public static getActiveTraceContext(): SeptumTraceContext | undefined {
    return this.traceStorage.getStore();
  }

  /**
   * Generates a concise sample preview of output content to inspect payload relevancy and bloat.
   */
  public static createOutputDigest(text: string, maxPreviewChars = 300): SeptumOutputDigest {
    const trimmed = text.trim();
    if (!trimmed) {
      return { summary: "empty_output" };
    }

    const preview = trimmed.replace(/\s+/g, " ");
    const limit = Number.isFinite(maxPreviewChars) ? Math.max(0, Math.min(300, Math.floor(maxPreviewChars))) : 300;
    if (preview.length <= limit) return { sample_preview: preview };
    const marker = " ... [chars omitted] ... ";
    const available = Math.max(0, limit - marker.length);
    const head = Math.ceil(available / 2);
    const tail = available - head;
    return { sample_preview: (preview.slice(0, head) + marker + (tail ? preview.slice(-tail) : "")).slice(0, limit) };
  }

  public static recordToolResponse(
    event: Omit<SeptumToolCallEvent, "event" | "status">,
    response: ToolResponse,
    workspaceRoot: string | null,
    allowDetails = true,
  ): void {
    try {
      let bytes = 0;
      let lines = 0;
      let preview = "";
      let outcome = outcomeFrom(response.metadata);
      const previewEnabled = allowDetails && (process.env.SEPTUM_LOG_PREVIEW === "1" || process.env.SEPTUM_DEBUG_TELEMETRY === "1");
      for (const item of response.content ?? []) {
        if (typeof item.text !== "string") continue;
        const chunk = item.text;
        bytes += Buffer.byteLength(chunk);
        if (chunk.length > 0) {
          lines++;
          for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) lines++;
        }
        if (previewEnabled && preview.length < 1500) preview += chunk.slice(0, 1500 - preview.length);
        if (!outcome && chunk.length <= 65536 && chunk.trimStart().startsWith("{")) {
          try { outcome = outcomeFrom(JSON.parse(chunk)); } catch { /* Text-only results have no structured outcome. */ }
        }
      }

      const responseBytes = Buffer.byteLength(JSON.stringify(response));
      this.recordToolCall({
        ...event,
        event: response.isError ? "tool_call_failed" : "tool_call_completed",
        status: response.isError ? "error" : "success",
        outcome,
        metrics: { bytes_out: bytes, lines_out: lines, estimated_tokens: Math.round(bytes / 4), response_bytes: responseBytes },
        bloat_alert: responseBytes >= this.BLOAT_BYTE_THRESHOLD,
        output_digest: previewEnabled ? this.createOutputDigest(preview) : undefined,
        error: response.isError ? {
          message: event.error?.message ?? "Tool returned an error.",
          stack: event.error?.stack,
          code: event.error?.code ?? errorCodeFromMetadata(response.metadata) ?? (event.stage === "validation" ? "INVALID_ARGUMENT" :
            event.stage === "workspace" ? "WORKSPACE_ERROR" :
            event.stage === "cancelled" ? "REQUEST_CANCELLED" :
            event.stage === "timeout" ? "REQUEST_TIMEOUT" : "TOOL_ERROR"),
        } : undefined,
      }, workspaceRoot, allowDetails);
    } catch {
      // Measurement failures cannot change the public response.
    }
  }

  /**
   * Resolves the log file path inside the active workspace's .septum directory.
   */
  public static getLogPath(workspaceRoot: string = process.cwd()): string {
    return join(workspaceRoot, ".septum", "septum.log");
  }

  /**
   * Records a tool call event to both stderr (dual-sink) and .septum/septum.log.
   */
  public static recordToolCall(
    event: SeptumToolCallEvent,
    workspaceRoot: string | null = process.cwd(),
    allowDetails = true,
  ): void {
    try {
      const debug = allowDetails && process.env.SEPTUM_DEBUG_TELEMETRY === "1";
      const rawInput = allowDetails && (debug || process.env.SEPTUM_LOG_INPUT === "1");
      const preview = allowDetails && (debug || process.env.SEPTUM_LOG_PREVIEW === "1");
      const errorDetails = allowDetails && (debug || process.env.SEPTUM_LOG_ERROR_DETAILS === "1");
      const safeInput = Object.fromEntries(Object.entries(event.input).filter(([key, value]) =>
        ["include_source", "include_dependencies", "limit", "max_depth", "budget_bytes", "source_line_limit", "semantic_depth", "ingest_now", "staged"].includes(key) && (typeof value === "number" || typeof value === "boolean") ||
        ["action", "scope", "detail_level", "context_mode"].includes(key) && typeof value === "string" && SAFE_ACTIONS.has(value)));
      const payload: SeptumToolCallEvent = {
        ...event,
        timestamp: event.timestamp ?? new Date().toISOString(),
        tool: event.tool.slice(0, 64),
        action: event.action && SAFE_ACTIONS.has(event.action) ? event.action : undefined,
        input: rawInput ? event.input : safeInput,
        output_digest: preview ? event.output_digest : undefined,
        error: event.error && {
          code: event.error.code?.slice(0, 64),
          message: errorDetails ? event.error.message.slice(0, 512) : "Tool execution failed; inspect the tool response for details.",
          stack: errorDetails ? event.error.stack?.slice(0, 1024) : undefined,
        },
      };

      let jsonLine = JSON.stringify(payload);
      if (Buffer.byteLength(jsonLine) + 1 > this.MAX_EVENT_BYTES) {
        payload.input = safeInput;
        payload.output_digest = undefined;
        if (payload.error) {
          delete payload.error.stack;
          payload.error.message = "Tool execution failed; inspect the tool response for details.";
        }
        jsonLine = JSON.stringify(payload);
      }
      if (Buffer.byteLength(jsonLine) + 1 > this.MAX_EVENT_BYTES) return;

      const severity = payload.status === "error" ? "ERROR" :
        payload.bloat_alert ? "BLOAT_WARN" :
        payload.duration_ms >= this.SLOW_EXECUTION_THRESHOLD_MS ? "SLOW_WARN" : undefined;
      if (severity) this.writeStderr(`[Septum Telemetry ${severity}] ${jsonLine}`);
      if (workspaceRoot) this.appendLog(jsonLine, workspaceRoot);
    } catch {
      // Serialization failures cannot change tool execution.
    }
  }

  public static recordMemorySample(metrics: Record<string, number>, workspaceRoot: string = process.cwd()): void {
    const jsonLine = JSON.stringify({ timestamp: new Date().toISOString(), event: "memory_sample", metrics });
    this.writeStderr(`[Septum Memory] ${jsonLine}`);
    this.appendLog(jsonLine, workspaceRoot);
  }

  public static recordSystemEvent(options: {
    level: SeptumSystemLevel;
    component: string;
    event: string;
    fields?: Record<string, unknown>;
    workspaceRoot?: string | null;
    emitStderr?: boolean;
  }): void {
    try {
      const ctx = this.traceStorage.getStore();
      const root = options.workspaceRoot !== undefined ? options.workspaceRoot : ctx?.workspaceRoot;
      const payload: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        severity_text: options.level,
        ...(ctx?.traceId ? { trace_id: ctx.traceId } : {}),
        component: options.component.slice(0, 64),
        event: options.event.slice(0, 64),
        ...(options.fields ?? {}),
      };
      let jsonLine = JSON.stringify(payload);
      if (Buffer.byteLength(jsonLine) + 1 > this.MAX_EVENT_BYTES) {
        jsonLine = JSON.stringify({
          timestamp: payload.timestamp,
          severity_text: options.level,
          ...(ctx?.traceId ? { trace_id: ctx.traceId } : {}),
          component: payload.component,
          event: payload.event,
          truncated: true,
        });
      }
      if (options.emitStderr !== false && (options.level === "WARN" || options.level === "ERROR")) {
        this.writeStderr(`[Septum ${options.component} ${options.level}] ${jsonLine}`);
      }
      if (root) this.appendLog(jsonLine, root);
    } catch {
      // Telemetry failures must never disrupt caller execution.
    }
  }

  private static writeStderr(message: string): void {
    try { console.error(message); } catch { /* Keep file logging independent. */ }
  }

  private static appendLog(jsonLine: string, workspaceRoot: string): void {
    // Sink 2: Append-only persistent file recorder in .septum/septum.log
    try {
      const logPath = this.getLogPath(workspaceRoot);
      const logDir = dirname(logPath);

      // SV-03: Do not auto-scaffold .septum directory for telemetry if workspace has not been initialized
      if (!existsSync(logDir)) {
        return;
      }

      if (existsSync(logPath) && statSync(logPath).size + Buffer.byteLength(jsonLine) + 1 > this.MAX_LOG_SIZE_BYTES) {
        renameSync(logPath, `${logPath}.1`);
      }

      appendFileSync(logPath, `${jsonLine}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Telemetry file writes must never crash the main application process
    }
  }
}
