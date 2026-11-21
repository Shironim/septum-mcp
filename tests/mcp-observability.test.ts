import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SeptumTelemetry } from "../src/core/telemetry/telemetry.ts";

import { summarizeToolCalls } from "../src/core/telemetry/summary.ts";

describe("SeptumTelemetry Engine", () => {
  const testDir = join(import.meta.dir, "temp-telemetry-test");
  const logFile = join(testDir, ".septum", "septum.log");
  let debugSetting: string | undefined;

  beforeEach(() => {
    debugSetting = process.env.SEPTUM_DEBUG_TELEMETRY;
    delete process.env.SEPTUM_DEBUG_TELEMETRY;
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, ".septum"), { recursive: true });
  });

  afterEach(() => {
    if (debugSetting === undefined) delete process.env.SEPTUM_DEBUG_TELEMETRY;
    else process.env.SEPTUM_DEBUG_TELEMETRY = debugSetting;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("records tool call completions into .septum/septum.log as JSON Lines", () => {
    SeptumTelemetry.recordToolCall(
      {
        event: "tool_call_completed",
        tool: "septum_get_domain_catalog",
        duration_ms: 22,
        input: { domain: "orders" },
        metrics: { bytes_out: 480, lines_out: 18, nodes_returned: 6 },
        session: { feature_key: "checkout-v2", domain: "orders" },
        status: "success",
      },
      testDir
    );

    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8").trim();
    const parsed = JSON.parse(content);

    expect(parsed.event).toBe("tool_call_completed");
    expect(parsed.tool).toBe("septum_get_domain_catalog");
    expect(parsed.duration_ms).toBe(22);
    expect(parsed.metrics.bytes_out).toBe(480);
    expect(parsed.session.feature_key).toBe("checkout-v2");
    expect(parsed.status).toBe("success");
  });

  it("records tool call failures with diagnostic metadata", () => {
    SeptumTelemetry.recordToolCall(
      {
        event: "tool_call_failed",
        tool: "septum_trace_vertical_slice",
        duration_ms: 10,
        input: { query: "POST /missing" },
        status: "error",
        error: { code: "NOT_FOUND", message: "Route not registered" },
      },
      testDir
    );

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);

    expect(last.event).toBe("tool_call_failed");
    expect(last.status).toBe("error");
    expect(last.error.code).toBe("NOT_FOUND");
    expect(last.error.message).not.toContain("Route not registered");
    expect(last.input).toEqual({});
  });

  it("rotates log file when size reaches 2MB threshold", () => {
    const bigData = "Y".repeat(2 * 1024 * 1024);
    SeptumTelemetry.recordToolCall(
      { event: "tool_call_completed", tool: "init", duration_ms: 1, input: {}, status: "success" },
      testDir
    );
    writeFileSync(logFile, bigData, "utf8");

    // Trigger next write after 2MB
    SeptumTelemetry.recordToolCall(
      { event: "tool_call_completed", tool: "after_rotation", duration_ms: 2, input: {}, status: "success" },
      testDir
    );

    const rotatedFile = `${logFile}.1`;
    expect(existsSync(rotatedFile)).toBe(true);
    expect(existsSync(logFile)).toBe(true);
  });

  it("keeps size metrics and omits raw source previews by default", () => {
    const rawOutput = "export interface OrderDTO { id: string; amount: number; }\n".repeat(400); // ~24KB
    const digest = SeptumTelemetry.createOutputDigest(rawOutput);

    SeptumTelemetry.recordToolCall(
      {
        event: "tool_call_completed",
        tool: "septum_symbol",
        action: "context",
        duration_ms: 35,
        input: { query: "OrderDTO", file_path: "src/orders/dto.ts" },
        metrics: {
          bytes_out: Buffer.byteLength(rawOutput, "utf8"),
          lines_out: 400,
          estimated_tokens: Math.round(Buffer.byteLength(rawOutput, "utf8") / 4),
        },
        bloat_alert: Buffer.byteLength(rawOutput, "utf8") >= SeptumTelemetry.BLOAT_BYTE_THRESHOLD,
        output_digest: digest,
        status: "success",
      },
      testDir
    );

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);

    expect(last.action).toBe("context");
    expect(last.metrics.bytes_out).toBeGreaterThan(16384);
    expect(last.metrics.estimated_tokens).toBeGreaterThan(4000);
    expect(last.bloat_alert).toBe(true);
    expect(last.output_digest).toBeUndefined();
    expect(readFileSync(logFile, "utf8")).not.toContain("OrderDTO");
  });

  it("retains raw diagnostics only when debug telemetry is explicitly enabled", () => {
    process.env.SEPTUM_DEBUG_TELEMETRY = "1";
    SeptumTelemetry.recordToolCall({ event: "tool_call_completed", tool: "septum_symbol", duration_ms: 1,
      input: { query: "debug-target" }, output_digest: { sample_preview: "debug-source" }, status: "success", outcome: "partial" }, testDir);
    const event = JSON.parse(readFileSync(logFile, "utf8"));
    expect(event.input.query).toBe("debug-target");
    expect(event.output_digest.sample_preview).toBe("debug-source");
    expect(event.outcome).toBe("partial");
  });

  it("createOutputDigest creates concise bounded summaries for empty or long texts", () => {
    const empty = SeptumTelemetry.createOutputDigest("");
    expect(empty.summary).toBe("empty_output");

    const short = SeptumTelemetry.createOutputDigest("Hello World");
    expect(short.sample_preview).toBe("Hello World");

    const long = SeptumTelemetry.createOutputDigest("A".repeat(500));
    expect(long.sample_preview?.length).toBeLessThan(400);
    expect(long.sample_preview).toContain("chars omitted");
  });
  it("measures the final wire result and interprets its explicit outcome", () => {
    const response = { content: [{ type: "text", text: "é\nsource-preview-secret" }], metadata: { status: "NOT_INDEXED" } };
    SeptumTelemetry.recordToolResponse({
      tool: "septum_map", stage: "workspace", duration_ms: 3, input: { query: "input-secret" },
    }, response, testDir, false);
    const line = readFileSync(logFile, "utf8");
    expect(line).not.toContain("secret");
    expect(JSON.parse(line)).toMatchObject({
      outcome: "NOT_INDEXED", status: "success",
      metrics: {
        bytes_out: Buffer.byteLength(response.content[0]!.text),
        lines_out: 2,
        response_bytes: Buffer.byteLength(JSON.stringify(response)),
      },
    });
  });

  it("prefers explicit exception and result codes over request stage labels", () => {
    const base = { tool: "septum_boundary", duration_ms: 1, input: {} };
    SeptumTelemetry.recordToolResponse({ ...base, stage: "workspace", error: { code: "SERVER_BUSY", message: "busy" } },
      { isError: true }, testDir);
    SeptumTelemetry.recordToolResponse({ ...base, stage: "execution" },
      { isError: true, metadata: { code: "BUDGET_RESPONSE_TOO_LARGE" } }, testDir);
    const codes = readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line).error.code);
    expect(codes).toEqual(["SERVER_BUSY", "BUDGET_RESPONSE_TOO_LARGE"]);
  });

  it("bounds oversized debug events and rotates before an append crosses the limit", () => {
    process.env.SEPTUM_DEBUG_TELEMETRY = "1";
    writeFileSync(logFile, "X".repeat(SeptumTelemetry.MAX_LOG_SIZE_BYTES - 8));
    SeptumTelemetry.recordToolCall({
      event: "tool_call_completed", tool: "septum_map", duration_ms: 1,
      status: "success", input: { query: "🌐".repeat(10000), action: "catalog" },
    }, testDir);
    expect(statSync(logFile + ".1").size).toBe(SeptumTelemetry.MAX_LOG_SIZE_BYTES - 8);
    expect(statSync(logFile).size).toBeLessThanOrEqual(SeptumTelemetry.MAX_EVENT_BYTES);
    expect(JSON.parse(readFileSync(logFile, "utf8")).input).toEqual({ action: "catalog" });
  });

  it("summarizes current and rotated tool events, skipping older missing measurements and corrupt lines", () => {
    const older = { event: "tool_call_completed", status: "success", tool: "septum_map", action: "catalog", duration_ms: 1 };
    const recent = { event: "tool_call_failed", status: "error", tool: "septum_map", action: "catalog",
      duration_ms: 4, trace_id: "recent", metrics: { response_bytes: 32 }, error: { code: "TOOL_ERROR", message: "private" } };
    writeFileSync(logFile + ".1", JSON.stringify(older) + "\n" + JSON.stringify(recent) + "\n");
    writeFileSync(logFile, JSON.stringify(recent) + "\n{torn\n");
    const summary = summarizeToolCalls(testDir);
    expect(summary).toMatchObject({
      calls: 2, errors: 1,
      duration_ms: { samples: 2, p50: 1, p95: 4 },
      response_bytes: { samples: 1, p50: 32, p95: 32 },
      tools: { septum_map: { actions: { catalog: { calls: 2, errors: 1 } } } },
      recent_errors: [{ code: "TOOL_ERROR", trace_id: "recent" }],
    });
    expect(JSON.stringify(summary)).not.toContain("private");
  });

  it("propagates trace_id via AsyncLocalStorage to recordSystemEvent without breaking summarizeToolCalls", async () => {
    await SeptumTelemetry.withTrace("trace-abc-123", async () => {
      await Promise.resolve();
      SeptumTelemetry.recordSystemEvent({
        level: "INFO",
        component: "ingestion",
        event: "ingestion_completed",
        fields: { state_previous: "running", state_current: "complete", files_updated: 3 },
        emitStderr: false,
      });
    }, testDir);

    const logContent = readFileSync(SeptumTelemetry.getLogPath(testDir), "utf-8");
    const lines = logContent.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity_text: "INFO",
      trace_id: "trace-abc-123",
      component: "ingestion",
      event: "ingestion_completed",
      state_previous: "running",
      state_current: "complete",
      files_updated: 3,
    });

    const summary = summarizeToolCalls(testDir);
    expect(summary.calls).toBe(0);
  });

});
