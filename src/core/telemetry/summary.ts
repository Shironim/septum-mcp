import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { SeptumTelemetry, type SeptumToolCallEvent } from "./telemetry.ts";

const SAMPLE_LIMIT = 500;

function readLogTail(path: string): string[] {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Telemetry log is not a regular file: ${path}`);
    const length = Math.min(stat.size, SeptumTelemetry.MAX_LOG_SIZE_BYTES);
    const offset = stat.size - length;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    return offset ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

function parseToolEvent(line: string): SeptumToolCallEvent | undefined {
  try {
    const event = JSON.parse(line);
    if ((event?.event === "tool_call_completed" || event?.event === "tool_call_failed") &&
        (event.status === "success" || event.status === "error") &&
        typeof event.tool === "string" && Number.isFinite(event.duration_ms) && event.duration_ms >= 0) return event;
  } catch { /* The log can contain incomplete writes or older formats. */ }
}

function distribution(values: number[]) {
  const sorted = values.sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}

export function summarizeToolCalls(workspaceRoot: string) {
  const path = SeptumTelemetry.getLogPath(workspaceRoot);
  // Read active first so a concurrent rotation can be deduplicated by trace ID.
  const active = readLogTail(path);
  const seen = new Set<string>();
  const events: SeptumToolCallEvent[] = [];
  for (const lines of [active, readLogTail(`${path}.1`)]) {
    for (let i = lines.length - 1; i >= 0 && events.length < SAMPLE_LIMIT; i--) {
      const event = parseToolEvent(lines[i]!);
      if (!event) continue;
      if (typeof event.trace_id === "string") {
        if (seen.has(event.trace_id)) continue;
        seen.add(event.trace_id);
      }
      events.push(event);
    }
  }

  const byTool = new Map<string, { calls: number; errors: number; actions: Map<string, { calls: number; errors: number }> }>();
  const responseBytes: number[] = [];
  const durations: number[] = [];
  const recentErrors = [];
  let errors = 0;
  for (const event of events) {
    const tool = byTool.get(event.tool) ?? { calls: 0, errors: 0, actions: new Map() };
    byTool.set(event.tool, tool);
    const action = typeof event.action === "string" ? event.action : "unspecified";
    const counts = tool.actions.get(action) ?? { calls: 0, errors: 0 };
    tool.actions.set(action, counts);
    tool.calls++;
    counts.calls++;
    durations.push(event.duration_ms);
    const bytes = event.metrics?.response_bytes;
    if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) responseBytes.push(bytes);
    if (event.status === "error") {
      errors++;
      tool.errors++;
      counts.errors++;
      if (recentErrors.length < 10) recentErrors.push({
        tool: event.tool,
        action: event.action,
        timestamp: event.timestamp,
        trace_id: event.trace_id,
        stage: event.stage,
        code: event.error?.code,
      });
    }
  }

  return {
    workspace: workspaceRoot,
    sample_limit: SAMPLE_LIMIT,
    sources: ["septum.log", "septum.log.1"],
    first_timestamp: events.at(-1)?.timestamp ?? null,
    last_timestamp: events[0]?.timestamp ?? null,
    calls: events.length,
    errors,
    duration_ms: distribution(durations),
    response_bytes: distribution(responseBytes),
    tools: Object.fromEntries([...byTool].map(([name, tool]) => [name, {
      calls: tool.calls,
      errors: tool.errors,
      actions: Object.fromEntries(tool.actions),
    }])),
    recent_errors: recentErrors,
  };
}
