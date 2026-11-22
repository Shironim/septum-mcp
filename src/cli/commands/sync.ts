import { ConfigLoader, resolveDatabasePath } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline, type IngestionProgressEvent } from "../../core/ingestion/pipeline.ts";
import { resolveWorkspaceRoot } from "../../core/resolver/path-resolver.ts";
import { createSyncProgressReporter } from "./sync-progress.ts";

export interface SyncCommandOptions {
  json?: boolean;
  quiet?: boolean;
  workspaceRoot?: string;
  dbPath?: string;
  rebuild?: boolean;
  onProgress?: (info: IngestionProgressEvent) => void;
}

export async function handleSyncCommand(options: SyncCommandOptions = {}): Promise<void> {
  const root = resolveWorkspaceRoot(options.workspaceRoot || process.cwd());
  const config = ConfigLoader.load(options.dbPath, root);
  const resolvedDbPath = resolveDatabasePath(root, options.dbPath ?? config.settings.db_path);
  const db = new SeptumDatabase(resolvedDbPath);
  try {
    const repo = new SeptumRepository(db.raw);
    const pipeline = new IngestionPipeline(repo, root);

    const reporter =
      !options.json && !options.quiet && !options.onProgress
        ? createSyncProgressReporter()
        : undefined;

    let metrics;
    try {
      metrics = await pipeline.run(config, {
        rebuild: options.rebuild,
        onProgress: options.onProgress ?? reporter?.onProgress,
      });
    } finally {
      reporter?.cleanup();
    }

    if (options.json) {
      console.log(JSON.stringify(metrics, null, 2));
    } else if (!options.quiet) {
      const sliceCount = repo.countVerticalSlices();
      console.log(
        `[Septum Sync] Ingested in ${metrics.duration_ms.toFixed(0)}ms: ` +
          `${metrics.files_updated} updated/added, ` +
          `${metrics.files_skipped} unchanged, ` +
          `${metrics.symbols_indexed} symbols, ` +
          `${metrics.dependencies_indexed} deps, ` +
          `${sliceCount} slices.`
      );
      const unsupportedFiles = JSON.parse(repo.getMeta("unsupported_files") || "[]") as unknown[];
      const skippedFiles = JSON.parse(repo.getMeta("skipped_files") || "[]") as unknown[];
      const uncoveredFiles = JSON.parse(repo.getMeta("uncovered_files") || "[]") as unknown[];
      if (unsupportedFiles.length > 0 || skippedFiles.length > 0 || uncoveredFiles.length > 0) {
        const parts: string[] = [];
        if (uncoveredFiles.length > 0) parts.push(`${uncoveredFiles.length} uncovered`);
        if (skippedFiles.length > 0) parts.push(`${skippedFiles.length} skipped`);
        if (unsupportedFiles.length > 0) parts.push(`${unsupportedFiles.length} unsupported`);
        console.log(`[Septum Sync] Coverage: partial (${parts.join(", ")}).`);
      }
    }
  } finally {
    db.close();
  }
}
