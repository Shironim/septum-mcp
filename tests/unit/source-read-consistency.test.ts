import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSourceSkips, readOptionalSourceFile, readSourceFile } from "../../src/core/resources/source-files.ts";
import { computeContentHash } from "../../src/core/ingestion/hasher.ts";
import { RESOURCE_LIMITS } from "../../src/core/resources/limits.ts";

describe("analysis input read consistency", () => {
  let root: string, file: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "septum-analysis-input-")); file = join(root, "input.ts"); writeFileSync(file, "old"); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("captures direct reads as well as optional reads in stable path order", async () => {
    const other = join(root, "another.ts"); writeFileSync(other, "other");
    const result = await collectSourceSkips(root, async () => { readSourceFile(file); readOptionalSourceFile(other); return 7; });
    expect(result.value).toBe(7);
    expect(result.inputs.map(input => [input.path, input.hash])).toEqual([
      ["another.ts", computeContentHash("other")], ["input.ts", computeContentHash("old")],
    ]);
  });

  it("rejects changed inputs before publishing the result", async () => {
    await expect(collectSourceSkips(root, async () => {
      const old = readOptionalSourceFile(file);
      await Promise.resolve();
      writeFileSync(file, "new");
      return old;
    })).rejects.toThrow("Source changed during synchronization:");
  });

  it("does not let a later read hide earlier facts from another version", async () => {
    await expect(collectSourceSkips(root, async () => {
      const old = readOptionalSourceFile(file);
      writeFileSync(file, "new");
      const current = readOptionalSourceFile(file);
      return { old, current };
    })).rejects.toThrow("Source changed during synchronization:");
  });

  it("rejects deleted inputs and keeps concurrent collectors isolated", async () => {
    const [stable, changed] = await Promise.allSettled([
      collectSourceSkips(root, async () => 42),
      collectSourceSkips(root, async () => { readSourceFile(file); rmSync(file); return 0; }),
    ]);
    expect(stable.status).toBe("fulfilled");
    expect(changed.status).toBe("rejected");
  });

  it("retains a direct oversized read exclusion even when an analyzer catches the error", async () => {
    writeFileSync(file, "x".repeat(RESOURCE_LIMITS.sourceBytes + 1));
    const result = await collectSourceSkips(root, async () => {
      try { readSourceFile(file); } catch { /* Simulate a tolerant analyzer. */ }
      return [];
    });
    expect(result.skipped).toEqual([{ path: "input.ts", reason: "file_too_large" }]);
    expect(result.inputs[0]!.hash).toBe("file_too_large");
  });
});
