import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SeptumTelemetry } from "../src/core/telemetry/telemetry.ts";

describe("SeptumTelemetry Engine", () => {
  const testDir = join(import.meta.dir, "temp-telemetry-test");
  const logFile = join(testDir, ".septum", "septum.log");

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, ".septum"), { recursive: true });
  });

  afterEach(() => {
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
    expect(last.error.message).toBe("Route not registered");
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

  it("records output_digest, estimated_tokens, and bloat alerts for output inspection", () => {
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
    expect(last.output_digest.sample_preview).toBeDefined();
    expect(last.output_digest.sample_preview).toContain("OrderDTO");
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
});
