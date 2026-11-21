import type { ExecutionChainNode } from "../../types/index.ts";

export const SLICE_RELATIONSHIP_LIMITS =
  "Static, partial context. Relation labels describe evidence attached to nodes, not a proven sequential execution path. Imports do not prove calls; static calls do not prove runtime execution. Missing relationship metadata is unknown.";

export function formatSliceNode(node: ExecutionChainNode): string {
  const relation = node.relationship;
  return `[${(node.stage || "stage").toUpperCase()}] ${node.symbol} [${relation?.kind ?? "unknown"}; ${relation?.derivation ?? "unknown"}]${node.semantic_analysis ? " [lexical heuristic]" : ""}`;
}

export function parseSliceChain(serialized: string): ExecutionChainNode[] {
  const chain: unknown = JSON.parse(serialized);
  if (!Array.isArray(chain) || chain.some(node => !node || typeof node !== "object" ||
    typeof node.stage !== "string" || typeof node.symbol !== "string" ||
    (node.file !== undefined && typeof node.file !== "string") ||
    (node.description !== undefined && typeof node.description !== "string") ||
    ["guards", "mutations", "emits", "dispatches"].some(key => node[key] !== undefined &&
      (!Array.isArray(node[key]) || node[key].some((value: unknown) => typeof value !== "string"))))) {
    throw new Error("Invalid execution chain shape");
  }
  return chain;
}
