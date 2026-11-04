import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, fstatSync, openSync, readSync, statSync, realpathSync, readdirSync, type Dirent } from 'node:fs';
import { relative, resolve } from 'node:path';
import { computeContentHash } from "../ingestion/hasher.ts";
import { RESOURCE_LIMITS } from './limits.ts';

export interface SkippedSourceFile { path: string; reason: 'file_too_large' }
export class SourceFileLimitError extends Error {
  constructor(public readonly filePath: string) { super(`Source file exceeds ${RESOURCE_LIMITS.sourceBytes} bytes: ${filePath}`); }
}
export interface SourceReadFingerprint { path: string; hash: string; size: number; mtime: number }
export const SOURCE_READ_REVISION = "4";
type SourcePathKind = 'missing' | 'file' | 'directory' | 'other';
export interface SourcePathObservation { path: string; kind: SourcePathKind; real_path?: string }
export interface SourceDirectoryObservation { path: string; entries: string[] }
export interface SourceObservations { paths: SourcePathObservation[]; directories: SourceDirectoryObservation[] }
type SourceCollector = {
  skipped: Map<string, SkippedSourceFile>;
  inputs: Map<string, SourceReadFingerprint>;
  conflicts: Set<string>;
  paths: Map<string, SourcePathObservation>;
  directories: Map<string, SourceDirectoryObservation>;
};
const reads = new AsyncLocalStorage<SourceCollector>();

function pathObservation(filePath: string): SourcePathObservation {
  const path = resolve(filePath);
  try {
    const stat = statSync(path);
    return { path, kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other', real_path: realpathSync(path) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { path, kind: 'missing' };
    throw error; // Permission/read errors are not negative resolution evidence.
  }
}

/** Track existence/type and symlink destination, including negative lookups. */
export function probeSourcePath(filePath: string): SourcePathKind {
  const observation = pathObservation(filePath);
  const collector = reads.getStore();
  if (collector) {
    const prior = collector.paths.get(observation.path);
    if (prior && JSON.stringify(prior) !== JSON.stringify(observation)) collector.conflicts.add(observation.path);
    if (!prior) collector.paths.set(observation.path, observation);
  }
  return observation.kind;
}

function directoryEntries(entries: Dirent[]): string[] {
  return entries.map(entry => `${entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'}:${entry.name}`).sort();
}

/** Track the membership actually enumerated, not just a directory's mtime. */
export function readSourceDirectory(directory: string): Dirent[] {
  probeSourcePath(directory);
  const entries = readdirSync(directory, { withFileTypes: true });
  const collector = reads.getStore();
  if (collector) {
    const path = resolve(directory);
    const observation = { path, entries: directoryEntries(entries) };
    const prior = collector.directories.get(path);
    if (prior && JSON.stringify(prior.entries) !== JSON.stringify(observation.entries)) collector.conflicts.add(path);
    if (!prior) collector.directories.set(path, observation);
  }
  return entries;
}

/** Revalidate a persisted manifest without collecting these validation reads. */
export function sourceObservationsCurrent(root: string, observations: SourceObservations): boolean {
  try {
    for (const observation of observations.paths) {
      const path = resolve(root, observation.path);
      const current = pathObservation(path);
      if (current.kind !== observation.kind || current.real_path !== observation.real_path) return false;
    }
    for (const observation of observations.directories) {
      const entries = directoryEntries(readdirSync(resolve(root, observation.path), { withFileTypes: true }));
      if (JSON.stringify(entries) !== JSON.stringify(observation.entries)) return false;
    }
    return true;
  } catch { return false; }
}

function recordInput(filePath: string, hash: string, size: number, mtime: number): void {
  const collector = reads.getStore();
  if (!collector) return;
  const path = resolve(filePath);
  const prior = collector.inputs.get(path);
  if (prior && prior.hash !== hash) collector.conflicts.add(path);
  // Keep the first version: a subsequent read must not hide already-derived facts.
  if (!prior) collector.inputs.set(path, { path, hash, size, mtime });
}

function recordSkippedInput(filePath: string, size: number, mtime: number): void {
  const collector = reads.getStore();
  if (!collector) return;
  collector.skipped.set(resolve(filePath), { path: resolve(filePath), reason: 'file_too_large' });
  recordInput(filePath, 'file_too_large', size, mtime);
}

// Read at most the admission limit, even if the file grows after stat.
export function readSourceFile(filePath: string, _encoding?: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    if (size > RESOURCE_LIMITS.sourceBytes) {
      recordSkippedInput(filePath, size, stat.mtimeMs);
      throw new SourceFileLimitError(filePath);
    }
    let buffer = Buffer.allocUnsafe(Math.min(Math.max(size + 1, 4096), RESOURCE_LIMITS.sourceBytes + 1));
    let count = 0;
    while (true) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) {
        const content = buffer.toString('utf8', 0, count);
        if (reads.getStore()) recordInput(filePath, computeContentHash(content), size, stat.mtimeMs);
        return content;
      }
      count += read;
      if (count > RESOURCE_LIMITS.sourceBytes) {
        const current = fstatSync(fd);
        recordSkippedInput(filePath, current.size, current.mtimeMs);
        throw new SourceFileLimitError(filePath);
      }
      if (count === buffer.length) {
        const expanded = Buffer.allocUnsafe(Math.min(buffer.length * 2, RESOURCE_LIMITS.sourceBytes + 1));
        buffer.copy(expanded, 0, 0, count);
        buffer = expanded;
      }
    }
  } finally { closeSync(fd); }
}

export function readOptionalSourceFile(filePath: string, encoding?: string): string {
  try {
    return readSourceFile(filePath, encoding);
  }
  catch (error) {
    if (!(error instanceof SourceFileLimitError)) throw error;
    const collector = reads.getStore();
    if (!collector) throw error;
    const stat = statSync(filePath);
    recordSkippedInput(filePath, stat.size, stat.mtimeMs);
    return '';
  }
}

function createSourceCollector(): SourceCollector {
  return { skipped: new Map(), inputs: new Map(), conflicts: new Set(), paths: new Map(), directories: new Map() };
}

function finalizeSourceCollection<T>(root: string, collector: SourceCollector, value: T) {
  for (const input of collector.inputs.values()) {
    let changed = collector.conflicts.has(input.path);
    try {
      if (input.hash === 'file_too_large') {
        const stat = statSync(input.path);
        changed ||= stat.size !== input.size || stat.mtimeMs !== input.mtime || stat.size <= RESOURCE_LIMITS.sourceBytes;
      } else {
        changed ||= computeContentHash(readSourceFile(input.path)) !== input.hash;
      }
    } catch { changed = true; }
    if (changed) throw new Error(`Source changed during synchronization: ${relative(root, input.path)} changed during analysis. Retry against stable inputs.`);
  }
  if (collector.conflicts.size || !sourceObservationsCurrent(root, { paths: [...collector.paths.values()], directories: [...collector.directories.values()] })) {
    throw new Error('Source changed during synchronization: resolution path or directory observations changed during analysis. Retry against stable inputs.');
  }
  const rel = (file: {path:string}) => relative(root, file.path).replace(/\\/g, '/');
  return {value, skipped:[...collector.skipped.values()].map(file => ({...file,path:rel(file)})).sort((a,b)=>a.path.localeCompare(b.path)), inputs:[...collector.inputs.values()].map(file => ({...file,path:rel(file)})).sort((a,b)=>a.path.localeCompare(b.path)),
    observations: {
      paths: [...collector.paths.values()].map(item => ({ ...item, path: rel(item) })).sort((a,b)=>a.path.localeCompare(b.path)),
      directories: [...collector.directories.values()].map(item => ({ ...item, path: rel(item) })).sort((a,b)=>a.path.localeCompare(b.path)),
    } };
}

export function collectSourceSkipsSync<T>(root: string, read: () => T) {
  const collector = createSourceCollector();
  return finalizeSourceCollection(root, collector, reads.run(collector, read));
}

export async function collectSourceSkips<T>(root: string, read: () => Promise<T>) {
  const collector = createSourceCollector();
  return finalizeSourceCollection(root, collector, await reads.run(collector, read));
}
