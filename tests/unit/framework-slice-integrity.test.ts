import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { SemanticSliceExtractorRegistry } from "../../src/core/parser/extractors/registry.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/trace-vertical-slice.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SEMANTIC_FINGERPRINT } from "../../src/core/parser/semantic-revision.ts";
import { SliceToolSchema } from "../../src/mcp/schemas.ts";

import { sliceIntegrityCases as cases } from "../fixtures/slice-integrity-cases.ts";

describe("adapter output through shared catalog and public slice handler", () => {
  for (const fixture of cases) it(`${fixture.framework}: preserves competing targets and supports recovery`, async () => {
    const root = mkdtempSync("/tmp/septum-framework-integrity-");
    const db = new SeptumDatabase(":memory:");
    try {
      for (const [file, source] of Object.entries(fixture.files)) {
        mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source);
      }
      const adapter = SemanticSliceExtractorRegistry.getExtractors(root, fixture.framework).find(item => item.id === fixture.adapter);
      expect(adapter).toBeDefined();
      const slices = await adapter!.extractSlices(root);
      expect(slices.length).toBeGreaterThan(0);
      const original = slices[0];
      const repo = new SeptumRepository(db.raw);
      repo.upsertVerticalSlice(original);
      repo.upsertVerticalSlice({ ...original, controller_file: "competing/handler" });
      expect(repo.getAllVerticalSlices()).toHaveLength(2);
      repo.upsertVerticalSlice({ ...original, controller_line: original.controller_line + 1 });
      expect(repo.getAllVerticalSlices()).toHaveLength(2);
      repo.setMeta("semantic_extractor_revision", SEMANTIC_FINGERPRINT);
      const query = `${original.http_method} ${original.route_uri}`;
      const config = ConfigLoader.getDefaultConfig();
      const ambiguous = JSON.parse((await handleTraceVerticalSlice(repo, config, { query }, root)).content[0].text);
      expect(ambiguous.status).toBe("ambiguous");
      expect(ambiguous.found).toBe(false);
      expect(ambiguous.chain).toEqual([]);
      expect(ambiguous.alternatives.map((item: { file: string }) => item.file)).toContain(original.controller_file);
      const args = SliceToolSchema.parse({ query, controller_file: original.controller_file });
      const selected = JSON.parse((await handleTraceVerticalSlice(repo, config, args, root)).content[0].text);
      expect(selected.status).toBe("success");
      expect(selected.entrypoint.file).toBe(original.controller_file);
      expect(selected.chain.length).toBeGreaterThan(0);
      expect(new VerticalSliceTracer(repo, root).trace(query, 5, "missing").found).toBe(false);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
