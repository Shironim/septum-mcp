import { resolve } from "node:path";
import type { SeptumRepository } from "../database/repository.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SymbolCandidate } from "../../types/index.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { assertPathContained } from "../resolver/path-resolver.ts";
import { readSourceFile } from "../resources/source-files.ts";
import {
  pageContext,
  response,
  budgetedResponse,
  type ContextItem,
  type SourceItem,
} from "./context-page.ts";
import type { ContextQuery } from "./context.ts";

export const UNIVERSAL_CONTEXT_POLICY = "referenced-universal-declarations/v1";

function indexLineOffsets(source: string): { lineStarts: number[]; lineEnds: number[] } {
  const lineStarts = [0];
  const lineEnds: number[] = [];
  for (const match of source.matchAll(/\r\n|\n|\r/g)) {
    const end = match.index!;
    lineEnds.push(end);
    lineStarts.push(end + match[0].length);
  }
  lineEnds.push(source.length);
  return { lineStarts, lineEnds };
}

export async function retrieveUniversalContext(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  query: ContextQuery,
  target: SymbolCandidate,
  workspaceRoot: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const root = resolve(workspaceRoot);
  const budget = query.budget_bytes ?? 65536;
  const maxDepth = query.max_depth ?? 2;

  const targetFile = repo.getFileByPath(target.file_path);
  if (!targetFile) {
    return response({ status: "file_not_indexed", message: `File '${target.file_path}' is not indexed.` });
  }

  let targetSource: string;
  try {
    assertPathContained(target.file_path, root, "Universal context");
    targetSource = readSourceFile(resolve(root, target.file_path));
  } catch {
    return response({ status: "source_unavailable", message: `Could not read source file '${target.file_path}'.` });
  }

  const currentHash = computeContentHash(targetSource);
  if (currentHash !== targetFile.content_hash) {
    return response({
      status: "stale_reference",
      message: `File '${target.file_path}' has changed on disk since last indexed. Run 'septum sync'.`,
    });
  }

  const { lineStarts, lineEnds } = indexLineOffsets(targetSource);
  const startIdx = lineStarts[Math.max(0, target.line_start - 1)] ?? 0;
  const endIdx = lineEnds[Math.min(lineEnds.length - 1, target.line_end - 1)] ?? targetSource.length;
  const targetText = targetSource.slice(startIdx, endIdx);

  const items: ContextItem[] = [];
  const emittedKeys = new Set<string>();

  const targetKey = `${target.file_path}:${target.line_start}-${target.line_end}`;
  emittedKeys.add(targetKey);

  // 1. Target implementation
  const targetItem: SourceItem = {
    kind: "source",
    selection_role: "implementation",
    depth: 0,
    name: target.name,
    reason: "target_implementation",
    source: {
      file_path: target.file_path,
      indexed_content_hash: targetFile.content_hash,
      start_line: target.line_start,
      end_line: target.line_end,
      text: targetText,
    },
  };
  items.push(targetItem);

  // 2. Import relationships from target file
  const fileRels = repo.getImportRelationships(root, target.file_path);
  for (const edge of fileRels) {
    if (edge.source.line >= target.line_start && edge.source.line <= target.line_end) {
      items.push({
        kind: "relationship",
        reason: "target_file_import",
        relationship: edge,
      });
    }
  }

  // 3. Inspect direct outbound calls & symbol dependencies if maxDepth > 0
  if (maxDepth > 0) {
    const details = repo.getSymbolDetails(target.name, {
      filePath: target.file_path,
      workspaceRoot: root,
    });

    const calls = details?.outbound_calls ?? [];
    for (const callName of calls) {
      if (items.length >= 32) break;
      const candidates = repo.findSymbolsByName(callName, {
        domain: query.domain,
      });
      const resolved = candidates.find(c => c.file_path === target.file_path) ?? candidates[0];
      if (resolved) {
        const key = `${resolved.file_path}:${resolved.line_start}-${resolved.line_end}`;
        if (emittedKeys.has(key)) continue;
        emittedKeys.add(key);

        try {
          const resFile = repo.getFileByPath(resolved.file_path);
          if (!resFile) continue;
          const resSource = readSourceFile(resolve(root, resolved.file_path));
          if (computeContentHash(resSource) !== resFile.content_hash) continue;

          const offsets = indexLineOffsets(resSource);
          const sIdx = offsets.lineStarts[Math.max(0, resolved.line_start - 1)] ?? 0;
          const eIdx = offsets.lineEnds[Math.min(offsets.lineEnds.length - 1, resolved.line_end - 1)] ?? resSource.length;
          const text = resSource.slice(sIdx, eIdx);

          items.push({
            kind: "source",
            selection_role: "implementation",
            depth: 1,
            name: resolved.name,
            reason: resolved.file_path === target.file_path ? "local_dependency" : "direct_import_declaration",
            source: {
              file_path: resolved.file_path,
              indexed_content_hash: resFile.content_hash,
              start_line: resolved.line_start,
              end_line: resolved.line_end,
              text,
            },
          });
        } catch {
          // Graceful degradation if dependency source is unreadable
        }
      }
    }
  }

  const queryId = computeContentHash(JSON.stringify({
    root,
    target: target.name,
    file_path: target.file_path,
    policy: UNIVERSAL_CONTEXT_POLICY,
    budget,
  }));

  return pageContext({
    items,
    start: 0,
    sourceOffset: 0,
    budget,
    incomplete: false,
    base: {
      policy: UNIVERSAL_CONTEXT_POLICY,
      query_id: queryId,
      snapshot_id: currentHash,
      target: target.name,
      file_path: target.file_path,
    },
    accounting: {
      omitted_by_capacity: 0,
      unexpanded_dependency_files: 0,
    },
  });
}
