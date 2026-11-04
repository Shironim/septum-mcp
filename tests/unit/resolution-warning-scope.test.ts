import { describe, expect, it } from "bun:test";
import { partitionResolutionWarnings } from "../../src/core/retrieval/resolution-warnings.ts";
import type { ImportRelationship } from "../../src/types/index.ts";

function edge(file: string, status: ImportRelationship["resolution"]["status"], targets: string[] = []): ImportRelationship {
  return { kind: "imports", derivation: "source", index_coverage: "complete", freshness: "current", target_domains: [],
    source: { file, line: 1, statement: 'import "./dep"', indexed_content_hash: "fixture" },
    resolution: { status, targets: targets.length ? [{ kind: "file", files: targets }] : [], reason: "fixture",
      coverage: "conditional", resolver_revision: "fixture", config_revision: "fixture", source: { file, target: "./dep" } } };
}

describe("impact warning relevance", () => {
  it("separates proven unrelated direct imports while retaining unresolved and ambiguous possibilities", () => {
    const target = edge("src/target.ts", "unsupported");
    const incoming = edge("src/caller.ts", "resolved", ["src/target.ts"]);
    const unresolved = edge("other/missing.ts", "unresolved");
    const ambiguous = edge("other/alias.ts", "ambiguous", ["other/a.ts", "other/b.ts"]);
    const unrelated = edge("other/platform.go", "resolved", ["other/platform_linux.go"]);
    const result = partitionResolutionWarnings([target, incoming, unresolved, ambiguous, unrelated], ["src/target.ts"]);
    expect(result.relevant.map(item => item.source.file)).toEqual(["src/target.ts", "src/caller.ts", "other/missing.ts", "other/alias.ts"]);
    expect(result.relevant.map(item => item.warning_scope)).toEqual(["target", "target", "possible_target", "possible_target"]);
    expect(result.workspace).toEqual([unrelated]);
  });

  it("keeps stale, unindexed and missing-target uncertainty conservative", () => {
    const stale = { ...edge("other/stale.ts", "resolved", ["other/a.ts"]), freshness: "stale" as const };
    const partial = { ...edge("other/unindexed.ts", "resolved", ["other/b.ts"]), index_coverage: "partial" as const };
    const missing = edge("other/empty.ts", "resolved");
    expect(partitionResolutionWarnings([stale, partial, missing], ["src/target.ts"]).relevant).toHaveLength(3);
    expect(partitionResolutionWarnings([edge("other/file.ts", "resolved", ["other/a.ts"])], []).workspace).toEqual([]);
  });
});
