import type { IngestionProgressEvent } from "../../core/ingestion/pipeline.ts";

export interface SyncProgressReporterOptions {
  /** Optional line prefix (e.g. `init` tree rail). */
  prefix?: string;
  /** Override TTY detection (useful in unit tests). */
  isTty?: boolean;
  /** Override stdout.write for inline TTY updates. */
  write?: (chunk: string) => void;
  /** Override console.log for completed phase lines. */
  log?: (line: string) => void;
}

export interface SyncProgressReporter {
  onProgress: (event: IngestionProgressEvent) => void;
  cleanup: () => void;
}

/**
 * Creates a shared CLI progress reporter for ingestion phases (`scanning`,
 * `parsing`, `resolving`, `linking`) used by both `septum init` and `septum sync`.
 */
export function createSyncProgressReporter(options: SyncProgressReporterOptions = {}): SyncProgressReporter {
  const prefix = options.prefix ?? "";
  const isTty = options.isTty ?? Boolean(process.stdout.isTTY);
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const log = options.log ?? ((line: string) => console.log(line));
  let activeProgressLine = false;

  const cleanup = () => {
    if (activeProgressLine) {
      write("\r\x1b[K");
      activeProgressLine = false;
    }
  };

  const onProgress = (event: IngestionProgressEvent) => {
    if (event.phase === "scanning") {
      if (event.status === "start" && isTty) {
        write(`\r${prefix}\x1b[36m◆\x1b[0m Scanning files...\x1b[K`);
        activeProgressLine = true;
      } else if (event.status === "done") {
        cleanup();
        log(`${prefix}\x1b[36m◆\x1b[0m Scanning files — ${event.total.toLocaleString()} found`);
      }
    } else if (event.phase === "parsing") {
      if (event.status === "progress" && isTty) {
        write(
          `\r${prefix}\x1b[36m◆\x1b[0m Parsing code — ${event.processed.toLocaleString()}/${event.total.toLocaleString()}\x1b[K`
        );
        activeProgressLine = true;
      } else if (event.status === "done") {
        cleanup();
        log(`${prefix}\x1b[36m◆\x1b[0m Parsing code — done`);
      }
    } else if (event.phase === "resolving" && event.status === "done") {
      cleanup();
      log(`${prefix}\x1b[36m◆\x1b[0m Resolving refs & domains — done`);
    } else if (event.phase === "linking") {
      if (event.status === "start" && isTty) {
        write(`\r${prefix}\x1b[36m◆\x1b[0m Linking entrypoints & slices...\x1b[K`);
        activeProgressLine = true;
      } else if (event.status === "done") {
        cleanup();
        log(`${prefix}\x1b[36m◆\x1b[0m Linking entrypoints & slices — done (${event.slices.toLocaleString()} slices)`);
      }
    }
  };

  return { onProgress, cleanup };
}
