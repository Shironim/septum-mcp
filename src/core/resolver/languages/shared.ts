import * as path from "node:path";
import type { ImportResolution } from "../../../types/index.ts";
import { probeSourcePath, readSourceDirectory } from "../../resources/source-files.ts";

export interface ResolutionIO {
  root: string;
  read(file: string): string | undefined;
  check(file: string): void;
  finish(status: ImportResolution["status"], reason: string, targets?: ImportResolution["targets"]): ImportResolution;
}

export function ancestors(io: ResolutionIO, source: string): string[] {
  let directory = path.dirname(path.resolve(io.root, source));
  io.check(directory);
  const result: string[] = [];
  for (;;) {
    result.push(directory);
    if (directory === io.root) return result;
    directory = path.dirname(directory);
  }
}

export function existingFiles(io: ResolutionIO, candidates: string[]): string[] {
  return [...new Set(candidates.filter(file => {
    io.check(file);
    return probeSourcePath(file) === "file";
  }).map(file => path.relative(io.root, file).replace(/\\/g, "/")))].sort();
}

export function fileResult(io: ResolutionIO, files: string[], reason: string): ImportResolution {
  const unique = [...new Set(files)].sort();
  return io.finish(unique.length === 1 ? "resolved" : unique.length ? "ambiguous" : "unresolved", reason,
    unique.map(file => ({ kind: "file", files: [file] })));
}

export function packageResult(io: ResolutionIO, files: string[], reason: string): ImportResolution {
  return io.finish(files.length ? "resolved" : "unresolved", reason,
    files.length ? [{ kind: "package", files: [...new Set(files)].sort() }] : []);
}

// All discovery reads use the same tracked filesystem observations as source reads.
export function walkFiles(io: ResolutionIO, directory: string, accept: (file: string) => boolean): string[] {
  const ignored = new Set([".git", ".septum", "node_modules", "vendor", "target", "build", "dist", "bin", "obj", ".venv", "__pycache__"]);
  const result: string[] = [];
  let entriesSeen = 0;
  const visit = (dir: string, depth: number): void => {
    io.check(dir);
    if (probeSourcePath(dir) === "missing") return;
    if (depth > 64) throw new Error("resolution_scan_depth_limit");
    for (const entry of readSourceDirectory(dir)) {
      if (++entriesSeen > 20000) throw new Error("resolution_scan_entry_limit");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(file, depth + 1);
      else if ((entry.isFile() || entry.isSymbolicLink()) && accept(file)) {
        io.check(file);
        if (probeSourcePath(file) === "file") result.push(file);
      }
    }
  };
  visit(directory, 0);
  return result.sort();
}

export function toml(text: string): Record<string, any> {
  return Bun.TOML.parse(text) as Record<string, any>;
}

export function literalString(value: unknown, reason: string): string {
  if (typeof value !== "string" || /\$\(|\$\{|[<>]/.test(value)) throw new Error(reason);
  return value;
}
