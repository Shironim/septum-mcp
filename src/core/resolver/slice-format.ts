import type { ExecutionChainNode } from "../../types/index.ts";

export const SLICE_RELATIONSHIP_LIMITS =
  "Static, partial context. Relation labels describe evidence attached to nodes, not a proven sequential execution path. Imports do not prove calls; static calls do not prove runtime execution. Missing relationship metadata is unknown.";

export function formatSliceNode(node: ExecutionChainNode): string {
  const relation = node.relationship;
  return `[${(node.stage || "stage").toUpperCase()}] ${node.symbol} [${relation?.kind ?? "unknown"}; ${relation?.derivation ?? "unknown"}]${node.semantic_analysis ? " [lexical heuristic]" : ""}`;
}
