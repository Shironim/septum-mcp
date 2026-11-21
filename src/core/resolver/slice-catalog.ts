import { relative, resolve } from "node:path";
import type { SeptumRepository } from "../database/repository.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { TopologyDetector } from "../discovery/topology-detector.ts";
import { SemanticSliceExtractorRegistry, type AdapterExtractionResult } from "../parser/extractors/registry.ts";
import { SEMANTIC_FINGERPRINT } from "../parser/semantic-revision.ts";
import { scanSourceFiles, type SourceInventory } from "../resources/source-inventory.ts";
import { collectSourceSkips, readSourceFile, SOURCE_READ_REVISION, sourceObservationsCurrent } from "../resources/source-files.ts";
import { assertPathContained } from "./path-resolver.ts";
import { CallGraphTracer } from "./call-graph-tracer.ts";

interface CatalogOptions {
  ignorePatterns: string[];
  signal?: AbortSignal;
  semanticRevision?: string;
  inventoryRevision?: string;
}

export function sliceInputsCurrent(repo: SeptumRepository, root: string, signal?: AbortSignal): boolean {
  try {
    if (repo.getMeta("semantic_extractor_revision") !== SEMANTIC_FINGERPRINT ||
      (!!repo.getMeta("semantic_inputs") && repo.getMeta("semantic_input_revision") !== SOURCE_READ_REVISION) ||
      !sourceObservationsCurrent(root, JSON.parse(repo.getMeta("semantic_observations") || '{"paths":[],"directories":[]}'))) return false;
    const inputs = JSON.parse(repo.getMeta("semantic_inputs") || "[]") as Array<{ path: string; hash: string }>;
    return inputs.every(input => {
      signal?.throwIfAborted();
      assertPathContained(input.path, root, "Semantic source");
      return computeContentHash(readSourceFile(resolve(root, input.path))) === input.hash;
    });
  } catch { signal?.throwIfAborted(); return false; }
}

export async function refreshSliceCatalog(
  repo: SeptumRepository,
  root: string,
  options: CatalogOptions & { verifyMembership: boolean },
): Promise<void> {
  const files = options.verifyMembership
    ? scanSourceFiles(root, { ignorePatterns: options.ignorePatterns, signal: options.signal }).files
        .map(file => relative(root, file).replace(/\\/g, "/"))
    : undefined;
  const membershipChanged = files !== undefined && JSON.stringify(files) !== repo.getMeta("semantic_catalog_files");
  if (membershipChanged || !sliceInputsCurrent(repo, root, options.signal) || repo.getMeta("slices_dirty") === "1") {
    await rebuildSliceCatalog(repo, root, options);
  }
}

/** Publish slices and their input evidence together; failed builds retain a dirty catalog. */
export async function rebuildSliceCatalog(repo: SeptumRepository, root: string, options: CatalogOptions): Promise<void> {
  try {
    const reports: AdapterExtractionResult[] = [];
    let inventory: SourceInventory;
    const extracted = await collectSourceSkips(root, async () => {
      inventory = scanSourceFiles(root, { ignorePatterns: options.ignorePatterns, signal: options.signal });
      const topology = TopologyDetector.detect(root);
      const slices = await SemanticSliceExtractorRegistry.extractAllSlices(root, topology.framework, undefined, options.signal, {
        ignorePatterns: options.ignorePatterns, inventory, onResult: result => reports.push(result),
      });
      // Complement uncovered files only. Reinterpreting an adapter's router file
      // could invent unprefixed routes from mounted framework routers.
      const coveredFiles = new Set<string>();
      for (const slice of slices) {
        if (slice.controller_file) coveredFiles.add(slice.controller_file);
        const chain = JSON.parse(slice.execution_chain_json) as Array<{ stage?: string; file?: string }>;
        for (const node of chain) if (node.stage === "ingress" && node.file) coveredFiles.add(node.file);
      }
      const fallback = new CallGraphTracer(repo, root).traceAllSlices(8, { excludeEntrypointFiles: coveredFiles });
      return [...slices, ...fallback];
    });
    options.signal?.throwIfAborted();
    if (extracted.skipped.length) {
      repo.setMeta("semantic_skipped_files", JSON.stringify(extracted.skipped));
      const skipped = JSON.parse(repo.getMeta("skipped_files") || "[]") as Array<{ path: string; reason: string }>;
      repo.setMeta("skipped_files", JSON.stringify([...new Map([...skipped, ...extracted.skipped].map(file => [file.path, file])).values()]));
      throw new Error("Semantic extraction incomplete: source read limit exceeded.");
    }
    repo.runInTransaction(() => {
      repo.clearVerticalSlices();
      for (const slice of extracted.value) repo.insertVerticalSlice(slice);
      repo.setMeta("slices_dirty", "");
      repo.setMeta("semantic_extractor_revision", SEMANTIC_FINGERPRINT);
      repo.setMeta("semantic_inputs", JSON.stringify(extracted.inputs));
      repo.setMeta("semantic_observations", JSON.stringify(extracted.observations));
      repo.setMeta("semantic_input_revision", SOURCE_READ_REVISION);
      repo.setMeta("semantic_skipped_files", "[]");
      repo.setMeta("semantic_adapter_results", JSON.stringify(reports));
      if (options.semanticRevision !== undefined) repo.setMeta("semantic_revision", options.semanticRevision);
      if (options.inventoryRevision !== undefined) repo.setMeta("semantic_inventory", options.inventoryRevision);
      repo.setMeta("semantic_catalog_files", JSON.stringify(inventory.files.map(file => relative(root, file).replace(/\\/g, "/"))));
    });
  } catch (error) { repo.setMeta("slices_dirty", "1"); throw error; }
}
