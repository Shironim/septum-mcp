import type { ImportRelationship } from "../../types/index.ts";

/** Only resolved, current, fully indexed unrelated targets can leave the target warnings. */
export function partitionResolutionWarnings(relationships: ImportRelationship[], targetFiles: string[]) {
  const targets = new Set(targetFiles);
  const warnings = relationships.filter(edge => !["resolved", "external"].includes(edge.resolution.status) || edge.resolution.coverage === "conditional");
  const relevant = [];
  const workspace = [];
  for (const edge of warnings) {
    const directlyRelated = targets.has(edge.source.file) || edge.resolution.targets.some(target => target.files.some(file => targets.has(file)));
    const unrelatedProven = !directlyRelated && targets.size > 0 && edge.freshness === "current" && edge.index_coverage === "complete" &&
      edge.resolution.status === "resolved" && edge.resolution.targets.length > 0 &&
      edge.resolution.targets.every(target => target.files.length > 0);
    if (unrelatedProven) workspace.push(edge);
    else relevant.push({ ...edge,
      warning_scope: directlyRelated ? "target" as const : "possible_target" as const,
      relevance_reason: directlyRelated ? "source_or_resolved_target_is_selected" : "target_relevance_cannot_be_excluded",
    });
  }
  return { relevant, workspace };
}
