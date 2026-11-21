import { posix } from "node:path";
import type {
  FileConnectionsSummary,
  GetSymbolImpactResponse,
  ImportRelationship,
  SymbolReference,
} from "../../types/index.ts";
import { collectImportEvidence, type ImportEvidence, type IndexedDependency } from "./import-evidence.ts";
import { analyzeSymbolImpact } from "./symbol-impact.ts";

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DependencyQueryStore {
  getWorkspaceRootMeta(): string | undefined;
  getIndexedFilesForEvidence(sourceFile?: string): Array<{ path: string; content_hash: string; domain_id: number }>;
  getDomainsForEvidence(): Array<{ name: string; root_path: string }>;
  hasIndexedFile(path: string): boolean;
  getAllDependenciesWithDomains(sourceFile?: string): IndexedDependency[];
  getAllFileSummaries(): Array<{ id: number; domain_id: number; path: string }>;
  getAllInternalDependencyTargets(): Array<{ source_file_id: number; target_symbol_or_path: string }>;
  findImpactMethodCandidates(trimmed: string, container: string, method: string, domain?: string): Array<{
    name: string;
    kind: string;
    signature: string;
    line_start: number;
    line_end: number;
    file_path: string;
    domain_name?: string | null;
  }>;
  findImpactContainerCandidates(trimmed: string, container: string, domain?: string): Array<{
    name: string;
    kind: string;
    line_start: number;
    line_end: number;
    file_path: string;
    domain_name?: string | null;
  }>;
  queryDependenciesForImpact(patterns: {
    container: string;
    trimmed: string;
    stems: string[];
  }): Array<{
    file: string;
    line_number: number;
    target_symbol_or_path: string;
    import_statement: string;
    domain_name?: string | null;
  }>;
  findSameDirectoryPackageFiles(dirs: string[]): Array<{ path: string; domain_name: string | null }>;
  findSymbolsForFiles(filePaths: string[]): Array<{
    name: string;
    kind: string;
    signature: string;
    line_start: number;
    line_end: number;
    path: string;
  }>;
  findFileSymbolNames(cleanPath: string): string[];
  queryDependenciesForFileInbound(cleanPath: string, baseName: string, symbolNames: string[]): Array<{
    file: string;
    target: string;
    stmt: string;
  }>;
}

export function buildImportEvidence(
  store: DependencyQueryStore,
  workspaceRoot?: string,
  sourceFile?: string,
  verifyFile?: (file: string) => boolean
): ImportEvidence {
  const root = workspaceRoot ?? store.getWorkspaceRootMeta();
  if (!root) return { dependencies: [], relationships: [], staleFiles: [] };
  const files = store.getIndexedFilesForEvidence(sourceFile);
  const domains = store.getDomainsForEvidence().sort((a, b) => b.root_path.length - a.root_path.length);
  const dependencies = store.getAllDependenciesWithDomains(sourceFile);
  return collectImportEvidence({
    root,
    files,
    domains,
    dependencies,
    verifyFile,
    hasAdditionalIndexedFile: sourceFile === undefined ? undefined : (file) => store.hasIndexedFile(file),
  });
}

export function buildImportRelationships(
  store: DependencyQueryStore,
  workspaceRoot?: string,
  sourceFile?: string
): ImportRelationship[] {
  return buildImportEvidence(store, workspaceRoot, sourceFile).relationships;
}

export function buildDomainFileConnections(
  store: DependencyQueryStore,
  domainId?: number,
  workspaceRoot?: string
): Map<string, FileConnectionsSummary> {
  const root = workspaceRoot ?? store.getWorkspaceRootMeta();
  if (root) {
    const files = store.getAllFileSummaries();
    const edges = buildImportRelationships(store, root);
    return new Map(
      files
        .filter((f) => domainId === undefined || f.domain_id === domainId)
        .map((file) => {
          const imports = edges
            .filter((edge) => edge.source.file === file.path && edge.resolution.status === "resolved")
            .flatMap((edge) => edge.resolution.targets.flatMap((target) => target.files));
          const inbound = edges
            .filter(
              (edge) =>
                edge.resolution.status === "resolved" &&
                edge.resolution.targets.some((target) => target.files.includes(file.path))
            )
            .map((edge) => edge.source.file);
          return [
            file.path,
            {
              imports_from: [...new Set(imports)].sort(),
              imported_by: [...new Set(inbound)].sort(),
              imported_by_count: new Set(inbound).size,
            },
          ];
        })
    );
  }

  const allFiles = store.getAllFileSummaries();
  const fileById = new Map<number, { id: number; domain_id: number; path: string }>();
  const fileByNormPath = new Map<string, string>();
  const fileByNoExtPath = new Map<string, string>();

  for (const f of allFiles) {
    const norm = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
    fileById.set(f.id, { ...f, path: norm });
    fileByNormPath.set(norm.toLowerCase(), f.path);
    const noExt = norm.replace(/\.[^/.]+$/, "").toLowerCase();
    fileByNoExtPath.set(noExt, f.path);
    if (noExt.endsWith("/index")) {
      fileByNoExtPath.set(noExt.slice(0, -"/index".length), f.path);
    }
  }

  const resolveInternalTarget = (sourcePath: string, rawTarget: string): string | null => {
    const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
    if (!cleaned) return null;

    if (cleaned.startsWith(".")) {
      const srcDir = posix.dirname(sourcePath.replace(/\\/g, "/"));
      const joined = posix.normalize(posix.join(srcDir, cleaned)).replace(/^\.\//, "");
      const lowerJoined = joined.toLowerCase();
      const exact = fileByNormPath.get(lowerJoined) ?? fileByNoExtPath.get(lowerJoined.replace(/\.[^/.]+$/, ""));
      if (exact) return exact;
    }

    const aliasClean = cleaned.replace(/^@\//, "src/").replace(/^\.\//, "");
    const lowerAlias = aliasClean.toLowerCase();
    const byAlias = fileByNormPath.get(lowerAlias) ?? fileByNoExtPath.get(lowerAlias.replace(/\.[^/.]+$/, ""));
    if (byAlias) return byAlias;

    for (const [noExt, origPath] of fileByNoExtPath.entries()) {
      if (noExt.endsWith(`/${lowerAlias}`)) {
        return origPath;
      }
    }
    return null;
  };

  const importsFromMap = new Map<string, Set<string>>();
  const importedByMap = new Map<string, Set<string>>();
  for (const f of allFiles) {
    importsFromMap.set(f.path, new Set());
    importedByMap.set(f.path, new Set());
  }

  for (const dep of store.getAllInternalDependencyTargets()) {
    const srcFile = fileById.get(dep.source_file_id);
    if (!srcFile) continue;
    const resolvedTarget = resolveInternalTarget(srcFile.path, dep.target_symbol_or_path);
    if (resolvedTarget && resolvedTarget !== srcFile.path) {
      importsFromMap.get(srcFile.path)?.add(resolvedTarget);
      if (!importedByMap.has(resolvedTarget)) {
        importedByMap.set(resolvedTarget, new Set());
      }
      importedByMap.get(resolvedTarget)?.add(srcFile.path);
    }
  }

  const result = new Map<string, FileConnectionsSummary>();
  for (const f of allFiles) {
    if (domainId !== undefined && f.domain_id !== domainId) continue;
    const importsFrom = Array.from(importsFromMap.get(f.path) ?? []).sort();
    const importedBy = Array.from(importedByMap.get(f.path) ?? []).sort();
    result.set(f.path, {
      imports_from: importsFrom,
      imported_by_count: importedBy.length,
      imported_by: importedBy,
    });
  }

  return result;
}

export function buildFileConnections(
  store: DependencyQueryStore,
  filePath: string,
  workspaceRoot?: string
): FileConnectionsSummary {
  const clean = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const allConns = buildDomainFileConnections(store, undefined, workspaceRoot);
  return (
    allConns.get(clean) ??
    allConns.get(filePath) ?? {
      imports_from: [],
      imported_by_count: 0,
      imported_by: [],
    }
  );
}

export function buildSymbolImpact(
  store: DependencyQueryStore,
  symbolQuery: string,
  options: { domain?: string; workspaceRoot?: string; filePath?: string; reference?: SymbolReference } = {}
): GetSymbolImpactResponse {
  const trimmed = symbolQuery.trim();
  if (!trimmed) {
    return {
      target_symbol: symbolQuery,
      found_in_index: false,
      warning: "Empty symbol query provided.",
      impact_summary: {
        total_dependents: 0,
        risk_level: "unknown",
        affected_files_count: 0,
      },
      inbound_callers: [],
    };
  }

  let targetContainer = trimmed;
  let targetMethod = "";
  if (trimmed.includes("::")) {
    const parts = trimmed.split("::");
    targetContainer = parts[0];
    targetMethod = parts[1];
  } else if (trimmed.includes("@")) {
    const parts = trimmed.split("@");
    targetContainer = parts[0];
    targetMethod = parts[1];
  }

  let targetSymRows: Array<{
    name: string;
    kind: string;
    line_start: number;
    line_end: number;
    file_path: string;
    domain_name?: string | null;
  }>;

  if (targetMethod) {
    targetSymRows = store
      .findImpactMethodCandidates(trimmed, targetContainer, targetMethod, options.domain)
      .filter((row) => {
        if (row.name !== targetMethod) return true;
        const receiver = row.signature.match(/^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)(?:\[[^\]]+\])?\s*\)/);
        return receiver?.[1] === targetContainer;
      });

    if (targetSymRows.length === 0) {
      return {
        target_symbol: trimmed,
        found_in_index: false,
        warning: `Symbol '${trimmed}' was not found in Septum index${options.domain ? ` for domain '${options.domain}'` : ""}. Method does not exist.`,
        impact_summary: {
          total_dependents: 0,
          risk_level: "unknown",
          affected_files_count: 0,
        },
        inbound_callers: [],
      };
    }
  } else {
    targetSymRows = store.findImpactContainerCandidates(trimmed, targetContainer, options.domain);
    if (targetSymRows.length === 0) {
      return {
        target_symbol: trimmed,
        found_in_index: false,
        warning: `Symbol '${trimmed}' was not found in Septum index${options.domain ? ` for domain '${options.domain}'` : ""}.`,
        impact_summary: {
          total_dependents: 0,
          risk_level: "unknown",
          affected_files_count: 0,
        },
        inbound_callers: [],
      };
    }
  }

  const targetFilePath = (options.filePath ?? options.reference?.file_path)?.replace(/\\/g, "/");
  if (targetFilePath) {
    targetSymRows = targetSymRows.filter((r) => r.file_path.replace(/\\/g, "/") === targetFilePath);
    if (targetSymRows.length === 0) {
      return {
        target_symbol: trimmed,
        found_in_index: false,
        warning: `Symbol '${trimmed}' was not found in Septum index for file '${targetFilePath}'${options.domain ? ` in domain '${options.domain}'` : ""}.`,
        impact_summary: {
          total_dependents: 0,
          risk_level: "unknown",
          affected_files_count: 0,
        },
        inbound_callers: [],
      };
    }
  }

  const definingFiles = new Set<string>(targetSymRows.map((r) => r.file_path.replace(/\\/g, "/")));
  const domainByFile = new Map<string, string>();
  for (const row of targetSymRows) {
    if (row.domain_name) domainByFile.set(row.file_path.replace(/\\/g, "/"), row.domain_name);
  }

  const definingFileStems = Array.from(
    new Set(
      Array.from(definingFiles)
        .map((p) => p.split("/").pop()?.replace(/\.[^.]+$/, "") || "")
        .filter((s) => s.length >= 2)
    )
  );

  const rawDepRows = store.queryDependenciesForImpact({
    container: targetContainer,
    trimmed,
    stems: definingFileStems,
  });

  const isTargetedFile = Boolean(targetFilePath);
  const matchesDefiningFile = (df: string, stmt: string, target: string): boolean => {
    const normStmt = stmt.replace(/\\/g, "/");
    const normTarget = target.replace(/\\/g, "/");
    const clean = df.replace(/\.[^.]+$/, "");
    const parts = clean.split("/");
    const suffixes: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      suffixes.push(parts.slice(i).join("/"));
    }
    return suffixes.some((s) => {
      const escaped = escapeRegExp(s);
      const r = new RegExp(`(?:^|[\\\\/\"\x27.@:])(?:${escaped})(?:$|[\\\\/\"\x27;:.()\\s]|\\.[^\\\\/]+)`, "i");
      return r.test(normStmt) || r.test(normTarget);
    });
  };

  const containerWordRegex = new RegExp(`\\b${escapeRegExp(targetContainer)}\\b`);
  const depRows = rawDepRows.filter((row) => {
    const normCallerFile = String(row.file).replace(/\\/g, "/");
    if (row.domain_name) domainByFile.set(normCallerFile, String(row.domain_name));
    if (definingFiles.has(normCallerFile)) return false;

    const stmt = String(row.import_statement || "");
    const target = String(row.target_symbol_or_path || "");

    if (containerWordRegex.test(stmt) || containerWordRegex.test(target)) {
      if (isTargetedFile) {
        const matchesDefining = Array.from(definingFiles).some((df) => matchesDefiningFile(df, stmt, target));
        if (!matchesDefining) return false;
      }
      return true;
    }

    if (!stmt.includes("{")) {
      for (const stem of definingFileStems) {
        const stemRegex = new RegExp(`(?:^|[\\\\/])${escapeRegExp(stem)}(?:\\.[^\\\\/]+)?$`);
        if (stemRegex.test(target)) return true;
      }
    }

    return false;
  });

  const implicitPackageFiles = new Set<string>();
  const implicitLangDirs = new Set<string>();
  for (const df of definingFiles) {
    if (/\.(go|php|java|cs)$/i.test(df)) {
      const dir = posix.dirname(df);
      implicitLangDirs.add(dir === "." ? "" : dir);
    }
  }
  if (implicitLangDirs.size > 0) {
    for (const r of store.findSameDirectoryPackageFiles(Array.from(implicitLangDirs))) {
      const norm = r.path.replace(/\\/g, "/");
      if (r.domain_name) domainByFile.set(norm, r.domain_name);
      if (!definingFiles.has(norm) && /\.(go|php|java|cs)$/i.test(norm)) {
        implicitPackageFiles.add(norm);
      }
    }
  }

  const uniqueCallerFiles = Array.from(new Set(depRows.map((r) => String(r.file))));
  const allSymbolLookupFiles = Array.from(
    new Set([...uniqueCallerFiles, ...definingFiles, ...implicitPackageFiles])
  );
  const callerSymbolsByFile = new Map<
    string,
    Array<{ name: string; kind: string; signature: string; line_start: number; line_end: number }>
  >();

  if (allSymbolLookupFiles.length > 0) {
    for (const sym of store.findSymbolsForFiles(allSymbolLookupFiles)) {
      const list = callerSymbolsByFile.get(sym.path) || [];
      list.push(sym);
      callerSymbolsByFile.set(sym.path, list);
    }
  }

  return analyzeSymbolImpact({
    query: trimmed,
    container: targetContainer,
    method: targetMethod,
    targets: targetSymRows,
    dependencies: depRows,
    samePackageFiles: implicitPackageFiles,
    symbolsByFile: callerSymbolsByFile,
    domainsByFile: domainByFile,
    workspaceRoot: options.workspaceRoot,
  });
}

export function buildFileInboundImpact(
  store: DependencyQueryStore,
  filePath: string
): {
  direct_dependents_count: number;
  top_consumers: string[];
  symbols_count: number;
  risk_level: "low" | "medium" | "high";
} {
  const cleanPath = filePath.replace(/\\/g, "/");
  const baseName = cleanPath.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const symbols = store.findFileSymbolNames(cleanPath);

  const matchedFiles = new Set<string>();
  const relationships = buildImportRelationships(store);
  if (relationships.length > 0) {
    for (const edge of relationships) {
      if (edge.freshness !== "current" || edge.resolution.status !== "resolved") continue;
      if (edge.source.file === cleanPath) continue;
      if (edge.resolution.targets.some((t) => t.files.includes(cleanPath))) {
        matchedFiles.add(edge.source.file);
      }
    }
  } else {
    const depRows = store.queryDependenciesForFileInbound(cleanPath, baseName, symbols);
    const baseBoundary =
      baseName.length >= 3
        ? new RegExp(`(?:^|[\\/\\\\.])${escapeRegExp(baseName)}(?:\\.[^.\\/\\\\]+)?$`, "i")
        : null;
    const symNames = symbols
      .slice(0, 8)
      .map((s) => s.split("::").pop() || s)
      .filter((n) => n.length >= 4)
      .map((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`));

    for (const row of depRows) {
      const targetMatches =
        row.target.includes(cleanPath) ||
        (baseBoundary !== null && baseBoundary.test(row.target)) ||
        symNames.some((re) => re.test(row.target) || re.test(row.stmt));
      if (targetMatches) {
        matchedFiles.add(row.file);
      }
    }
  }

  const consumerList = Array.from(matchedFiles);
  let riskLevel: "low" | "medium" | "high" = "low";
  if (consumerList.length >= 5) riskLevel = "high";
  else if (consumerList.length >= 2) riskLevel = "medium";

  return {
    direct_dependents_count: consumerList.length,
    top_consumers: consumerList.slice(0, 5),
    symbols_count: symbols.length,
    risk_level: riskLevel,
  };
}
