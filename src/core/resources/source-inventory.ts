import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getLanguageCapability } from "../parser/language-capabilities.ts";
import { shouldIgnoreSourcePath } from "./ignore.ts";
import { readSourceDirectory } from "./source-files.ts";

export interface SourceInventory { root: string; files: readonly string[] }
export interface ScanOptions {
  directory?: string;
  ignorePatterns?: string[];
  excludeRoots?: string[];
  signal?: AbortSignal;
}
function contained(file: string, root: string): boolean {
  const rel = relative(root, file).replace(/\\/g, "/");
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}

/** Shared source membership. Read failures propagate instead of certifying an empty scan. */
export function scanSourceFiles(root: string, options: ScanOptions = {}): SourceInventory {
  root = resolve(root);
  const directory = resolve(options.directory ?? root);
  if (!contained(directory, root)) throw new Error(`Source directory escapes workspace: ${directory}`);
  const files: string[] = [];
  const walk = (dir: string) => {
    options.signal?.throwIfAborted();
    let entries;
    try { entries = readSourceDirectory(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      options.signal?.throwIfAborted();
      const file = resolve(dir, entry.name);
      const rel = relative(root, file).replace(/\\/g, "/");
      if (shouldIgnoreSourcePath(rel, options.ignorePatterns) || options.excludeRoots?.some(child => rel === child || rel.startsWith(child + "/"))) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isSymbolicLink()) {
        try {
          const target = realpathSync(file);
          if (contained(target, realpathSync(root)) && statSync(target).isFile() && getLanguageCapability(target)) files.push(file);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else if (entry.isFile() && getLanguageCapability(file)) files.push(file);
    }
  };
  try {
    if (!contained(realpathSync(directory), realpathSync(root))) throw new Error(`Source directory escapes workspace: ${directory}`);
    if (!lstatSync(directory).isDirectory()) return { root, files };
    walk(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { root, files };
}

export function listSourceFiles(directory: string, pattern: RegExp, inventory?: SourceInventory): string[] {
  const source = inventory ?? scanSourceFiles(directory);
  return source.files.filter(file => contained(file, resolve(directory)) && pattern.test(file));
}
