import { realpathSync, statSync } from "node:fs";
import { summarizeToolCalls } from "../../core/telemetry/summary.ts";

export function handleStatsCommand(workspace: string, json: boolean): void {
  const root = realpathSync(workspace);
  if (!statSync(root).isDirectory()) throw new Error("Stats requires a workspace directory.");
  const summary = summarizeToolCalls(root);
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Septum tool calls in ${root}`);
  console.log(`${summary.calls} calls, ${summary.errors} errors (latest ${summary.sample_limit} tool events from septum.log and septum.log.1)`);
  if (!summary.calls) return;
  console.log(`Range: ${summary.first_timestamp ?? "unknown"} to ${summary.last_timestamp ?? "unknown"}`);
  console.log(`Duration p50/p95: ${summary.duration_ms.p50}/${summary.duration_ms.p95} ms`);
  if (summary.response_bytes.samples) {
    console.log(`Response size p50/p95: ${summary.response_bytes.p50}/${summary.response_bytes.p95} bytes (${summary.response_bytes.samples} samples)`);
  }
  for (const [name, tool] of Object.entries(summary.tools)) {
    console.log(`  ${name}: ${tool.calls} calls, ${tool.errors} errors`);
    for (const [action, counts] of Object.entries(tool.actions)) {
      console.log(`    ${action}: ${counts.calls} calls, ${counts.errors} errors`);
    }
  }
  if (summary.recent_errors.length) {
    console.log("Recent errors:");
    for (const error of summary.recent_errors) {
      console.log(`  ${error.timestamp ?? "unknown"} ${error.tool} ${error.stage ?? "-"} ${error.code ?? "-"} ${error.trace_id ?? "-"}`);
    }
  }
}
