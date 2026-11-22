import * as fs from "node:fs";
import * as path from "node:path";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";

export function warnIfUnexpectedParserError(context: string, err: unknown): void {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "ENOENT" || errno === "ENOTDIR") return;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[Septum Extractor] ${context}: ${msg}`);
}

export function readPackageJson(projectRoot: string): Record<string, any> | null {
  const manifestPath = path.join(projectRoot, "package.json");
  if (probeSourcePath(manifestPath) !== "file") return null;
  try {
    return JSON.parse(readOptionalSourceFile(manifestPath, "utf-8"));
  } catch (err: unknown) {
    warnIfUnexpectedParserError(`Failed to parse ${manifestPath}`, err);
    return null;
  }
}

export function hasPackageJsonDependency(projectRoot: string, depNames: string[]): boolean {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return false;
  return depNames.some(
    (name) => Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name])
  );
}

export function hasComposerDependency(projectRoot: string, depNames: string[]): boolean {
  const composerJson = path.join(projectRoot, "composer.json");
  if (probeSourcePath(composerJson) !== "file") return false;
  try {
    const composer = JSON.parse(readOptionalSourceFile(composerJson, "utf-8"));
    const reqs = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
    return depNames.some((name) => Boolean(reqs[name]));
  } catch (err: unknown) {
    warnIfUnexpectedParserError(`Failed to parse ${composerJson}`, err);
    return false;
  }
}

export function anyFileContains(
  rootDir: string,
  relativePaths: string[],
  needles: string[],
  caseInsensitive = false
): boolean {
  for (const rel of relativePaths) {
    const fullPath = path.join(rootDir, rel);
    if (probeSourcePath(fullPath) !== "file") continue;
    try {
      const raw = readOptionalSourceFile(fullPath, "utf-8");
      const content = caseInsensitive ? raw.toLowerCase() : raw;
      if (needles.some((needle) => content.includes(needle))) {
        return true;
      }
    } catch (err: unknown) {
      warnIfUnexpectedParserError(`Failed to read ${fullPath}`, err);
    }
  }
  return false;
}
