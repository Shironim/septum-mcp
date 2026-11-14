import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SeptumToolCallMetrics {
  bytes_out?: number;
  lines_out?: number;
  estimated_tokens?: number;
  nodes_returned?: number;
}

export interface SeptumOutputDigest {
  summary?: string;
  sample_preview?: string;
}

export interface SeptumToolCallEvent {
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

export class SeptumTelemetry {
  public static readonly MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
  public static readonly SLOW_EXECUTION_THRESHOLD_MS = 250;
  public static readonly BLOAT_BYTE_THRESHOLD = 16 * 1024; // 16KB (~4,000 tokens)

  /**
   * Generates a concise sample preview of output content to inspect payload relevancy and bloat.
   */
  public static createOutputDigest(text: string, maxPreviewChars = 300): SeptumOutputDigest {
    const trimmed = text.trim();
    if (!trimmed) {
      return { summary: "empty_output" };
    }

    let samplePreview = trimmed;
    if (trimmed.length > maxPreviewChars) {
      const head = trimmed.slice(0, 200).replace(/\s+/g, " ");
      const tail = trimmed.slice(-80).replace(/\s+/g, " ");
      samplePreview = `${head} ... [${trimmed.length - 280} chars omitted] ... ${tail}`;
    } else {
      samplePreview = trimmed.replace(/\s+/g, " ");
    }

    return {
      sample_preview: samplePreview,
    };
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
    workspaceRoot: string = process.cwd()
  ): void {
    const debug = process.env.SEPTUM_DEBUG_TELEMETRY === "1";
    const input = Object.fromEntries(Object.entries(event.input).filter(([key, value]) =>
      ["include_source", "include_dependencies", "limit", "max_depth", "budget_bytes", "source_line_limit", "semantic_depth", "ingest_now", "staged"].includes(key) && (typeof value === "number" || typeof value === "boolean") ||
      ["action", "scope", "detail_level", "context_mode"].includes(key) && typeof value === "string" && ["locate", "context", "inspect", "impact", "catalog", "register", "file", "staged", "all", "domain", "compact", "full", "deep", "source"].includes(value)));
    const payload: SeptumToolCallEvent = {
      timestamp: event.timestamp || new Date().toISOString(),
      ...event,
      input: debug ? event.input : input,
      output_digest: debug ? event.output_digest : undefined,
      error: event.error && !debug ? { message: "Tool execution failed; inspect the tool response for details.", code: event.error.code } : event.error,
    };

    const jsonLine = JSON.stringify(payload);

    // Sink 1: Live stderr stream for operator monitoring (slow queries, bloat alerts & failures)
    if (payload.status === "error") {
      console.error(`[Septum Telemetry ERROR] ${jsonLine}`);
    } else if (payload.bloat_alert) {
      console.error(`[Septum Telemetry BLOAT_WARN] Tool '${payload.tool}' output exceeds threshold (${payload.metrics?.bytes_out} bytes, ~${payload.metrics?.estimated_tokens} tokens)`);
    } else if (payload.duration_ms >= this.SLOW_EXECUTION_THRESHOLD_MS) {
      console.error(`[Septum Telemetry SLOW_WARN] ${jsonLine}`);
    }

    this.appendLog(jsonLine, workspaceRoot);
  }

  public static recordMemorySample(metrics: Record<string, number>, workspaceRoot: string = process.cwd()): void {
    const jsonLine = JSON.stringify({timestamp: new Date().toISOString(), event: "memory_sample", metrics});
    console.error(`[Septum Memory] ${jsonLine}`);
    this.appendLog(jsonLine, workspaceRoot);
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

      // Check for rotation if file exceeds 2MB
      if (existsSync(logPath)) {
        try {
          const stats = statSync(logPath);
          if (stats.size >= this.MAX_LOG_SIZE_BYTES) {
            const rotatedPath = `${logPath}.1`;
            renameSync(logPath, rotatedPath);
          }
        } catch {
          // If stat/rotation fails, proceed to append without crashing
        }
      }

      appendFileSync(logPath, `${jsonLine}\n`, "utf8");
    } catch {
      // Telemetry file writes must never crash the main application process
    }
  }
}
