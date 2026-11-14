import { resolve } from "node:path";
import type { SeptumRepository } from "../database/repository.ts";
import type { SymbolReference } from "../../types/index.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { collectSourceSkipsSync, probeSourcePath, readSourceFile } from "../resources/source-files.ts";
import { assertPathContained } from "../resolver/path-resolver.ts";
import { getOperationCapabilities, PARSER_FINGERPRINT } from "../parser/language-capabilities.ts";

/** Content-bound declaration identity, shared across operations; not a continuation token. */
export function symbolTargetId(workspace: string, ref: SymbolReference): string {
  return computeContentHash(JSON.stringify([resolve(workspace), ref.file_path, ref.language, ref.name, ref.kind,
    ref.signature, ref.start_line, ref.end_line, ref.indexed_content_hash, ref.container ?? null, ref.receiver ?? null]));
}

export function symbolWorkspace(repo: SeptumRepository, explicit?: string): string {
  return resolve(explicit || (typeof repo.getMeta === "function" ? repo.getMeta("workspace_root") : null) || process.cwd());
}

type TextResult = { content: Array<{ type: string; text: string }>; metadata?: unknown };
type EvidenceQuery = { operation: "locate" | "inspect" | "impact"; requested?: SymbolReference; diagnostics?: string[] };

/** Checks the selected source and observed reads, without certifying a legacy caller/dependency closure. */
export function withSymbolEvidence<T extends TextResult>(repo: SeptumRepository, root: string, query: EvidenceQuery, build: () => T): T {
  const meta = (key: string) => typeof repo.getMeta === "function" ? repo.getMeta(key) : null;
  const collected = collectSourceSkipsSync(root, () => {
    const result = build();
    const payload = JSON.parse(result.content[0]!.text);
    const target: SymbolReference | undefined = payload.symbol_ref;
    const reasons = [...(query.diagnostics ?? [])];
    let freshness: "current" | "stale" | "unavailable" = "unavailable";
    let observedHash: string | null = null;
    if (target) {
      try {
        assertPathContained(target.file_path, root, "Symbol evidence source");
        if (probeSourcePath(resolve(root, target.file_path)) !== "file") reasons.push("target_source_unavailable");
        else {
          observedHash = computeContentHash(readSourceFile(resolve(root, target.file_path)));
          const indexed = repo.getFileByPath(target.file_path);
          if (indexed?.content_hash !== target.indexed_content_hash) reasons.push("target_index_changed");
          else {
            freshness = observedHash === target.indexed_content_hash ? "current" : "stale";
            if (freshness === "stale") reasons.push("target_source_differs_from_index");
          }
        }
      } catch { reasons.push("target_source_unavailable_or_out_of_scope"); }
    } else reasons.push(payload.status === "ambiguous" ? "target_ambiguous" : payload.status === "stale_reference" ? "stale_reference" : "target_not_selected");
    const syncState = meta("sync_state");
    if (syncState !== "complete") reasons.push("index_completeness_unverified");
    const parserRevision = meta("parser_revision");
    if (parserRevision !== PARSER_FINGERPRINT) reasons.push("indexed_parser_revision_unverified");
    return { result, payload, target, freshness, observedHash, reasons, syncState, parserRevision };
  });
  const { result, payload, target, freshness, observedHash, reasons, syncState, parserRevision } = collected.value;
  const staleInputs = collected.inputs.filter(input => {
    const indexed = repo.getFileByPath(input.path);
    return indexed && input.hash !== "file_too_large" && indexed.content_hash !== input.hash;
  }).length;
  const unavailableInputs = new Set([
    ...collected.observations.paths.filter(input => input.kind !== "file" && repo.getFileByPath(input.path)).map(input => input.path),
    ...collected.skipped.filter(input => repo.getFileByPath(input.path)).map(input => input.path),
  ]).size;
  if (staleInputs) reasons.push("observed_indexed_inputs_stale");
  if (unavailableInputs) reasons.push("observed_indexed_inputs_unavailable");
  if (collected.skipped.length) reasons.push("source_read_exclusions");
  const leanRetrieval = {
    operation: query.operation,
    target_id: target ? symbolTargetId(root, target) : null,
    ...(query.requested ? { requested_target_id: symbolTargetId(root, query.requested) } : {}),
    freshness,
    freshness_scope: "selected_declaration_source_only",
    completeness: "partial",
    analysis_freshness: "unavailable",
    source_version: target ? {
      file_path: target.file_path,
      indexed_hash: target.indexed_content_hash,
      observed_hash: observedHash,
    } : null,
    ...(staleInputs > 0 || unavailableInputs > 0 ? {
      observed_inputs: {
        stale_indexed_files: staleInputs,
        unavailable_indexed_files: unavailableInputs,
      },
    } : {}),
    reasons: [...new Set(reasons)].sort(),
  };
  if (query.operation === "locate" && payload.found && freshness !== "current") {
    const note = `[SOURCE ${freshness.toUpperCase()}] Indexed coordinates are not validated against current source; synchronize before editing.`;
    payload.summary = `${payload.summary} | ${note}`;
    payload.message = `${payload.message} | ${note}`;
  }
  const enriched = { ...payload, ...(target ? { capabilities: getOperationCapabilities(target.file_path) } : {}), retrieval: leanRetrieval };
  return {
    ...result,
    content: [{ ...result.content[0]!, text: JSON.stringify(enriched, null, 2) }, ...result.content.slice(1)],
    ...("metadata" in result ? { metadata: enriched } : { metadata: enriched }),
  } as T;
}
