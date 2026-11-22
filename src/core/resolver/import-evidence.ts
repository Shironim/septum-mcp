import { resolve, sep } from "node:path";
import type { ImportRelationship } from "../../types/index.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { getLanguageCapability } from "../parser/language-capabilities.ts";
import { readSourceFile } from "../resources/source-files.ts";
import { ImportResolver } from "./import-resolver.ts";
import { assertPathContained } from "./path-resolver.ts";

export interface IndexedDependency {
  source_file: string;
  source_domain: string;
  line_number: number;
  target: string;
  statement: string;
  is_external: boolean;
}

export interface ImportEvidence {
  dependencies: IndexedDependency[];
  relationships: ImportRelationship[];
  staleFiles: string[];
}

export function collectImportEvidence({
  root, files, domains, dependencies, hasAdditionalIndexedFile = () => false, verifyFile,
}: {
  root: string;
  files: { path: string; content_hash: string }[];
  domains: { name: string; root_path: string }[];
  dependencies: IndexedDependency[];
  hasAdditionalIndexedFile?: (file: string) => boolean;
  verifyFile?: (file: string) => boolean;
}): ImportEvidence {
  const resolver = new ImportResolver(root, domains.map(domain => domain.root_path), { batchCache: true });
  const resolvedDomains = domains
    .map(domain => {
      const domainPath = resolve(root, domain.root_path);
      return { name: domain.name, path: domainPath, prefix: domainPath.endsWith(sep) ? domainPath : domainPath + sep };
    })
    .sort((a, b) => b.path.length - a.path.length);
  const freshness = new Map<string, ImportRelationship["freshness"]>();
  const hashes = new Map(files.map(file => [file.path, file.content_hash]));
  const verifyFreshness = (file: string): ImportRelationship["freshness"] => {
    const cached = freshness.get(file);
    if (cached) return cached;
    let status: ImportRelationship["freshness"];
    try {
      assertPathContained(file, root, "Import source");
      status = computeContentHash(readSourceFile(resolve(root, file))) === hashes.get(file) ? "current" : "stale";
    } catch {
      status = "unavailable";
    }
    freshness.set(file, status);
    return status;
  };
  const relationships = dependencies.map((dep): ImportRelationship => {
    const current = verifyFreshness(dep.source_file);
    const resolution = resolver.resolve(dep.target, dep.source_file, dep.statement);
    if (current !== "current") {
      resolution.status = "unresolved";
      resolution.reason = `source_${current}`;
      resolution.targets = [];
    }
    const targetDomains = resolution.targets.flatMap(target => target.files.map(file => {
      const targetPath = resolve(root, file);
      return resolvedDomains.find(domain => targetPath === domain.path || targetPath.startsWith(domain.prefix))?.name;
    }).filter((name): name is string => !!name));
    return {
      kind: "imports", derivation: "source",
      source: { file: dep.source_file, line: dep.line_number, statement: dep.statement, indexed_content_hash: hashes.get(dep.source_file) ?? "" },
      resolution, target_domains: [...new Set(targetDomains)], freshness: current,
      index_coverage: resolution.targets.every(target => target.files.every(file => hashes.has(file) ||
        hasAdditionalIndexedFile(file) || !getLanguageCapability(file))) ? "complete" : "partial",
      ...(dep.source_file.endsWith(".go") ? { import_binding: (() => {
        const alias = dep.statement.replace(/^\s*import\s+/, "").match(/^\s*([A-Za-z_]\w*|\.)\s+["`]/)?.[1];
        return { kind: alias === "_" ? "blank" : alias === "." ? "dot" : alias ? "named" : "default", alias };
      })() } : {}),
      ...(dep.source_file.endsWith(".py") ? { import_binding: (() => {
        if (/^\s*from\s+.*\s+import\s+\*/.test(dep.statement)) return { kind: "star" };
        const asMatch = dep.statement.match(/\bas\s+([A-Za-z_]\w*)\s*$/);
        return { kind: asMatch ? "named" : "default", alias: asMatch?.[1] };
      })() } : {}),
    };
  });

  const staleFiles = verifyFile ? files.filter(file => verifyFile(file.path) && verifyFreshness(file.path) !== "current").map(file => file.path) : [];
  return { dependencies, relationships, staleFiles };
}
