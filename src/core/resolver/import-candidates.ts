import { dirname, join, normalize } from "node:path";
import type { FileRecord, ImportRelationship } from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { ImportResolver } from "./import-resolver.ts";

export class ImportCandidateResolver {
  private hasWorkspaceEvidence = false;
  private evidenceByFile = new Map<string, Map<string, ImportRelationship>>();

  constructor(
    private readonly repo: SeptumRepository,
    private readonly projectRoot: string,
    private readonly indexedFiles: ReadonlyMap<string, FileRecord>,
    private readonly findFile: (path: string) => FileRecord | undefined,
  ) {}

  reset(): void {
    this.evidenceByFile.clear();
    this.hasWorkspaceEvidence = Boolean(this.repo.getMeta?.("workspace_root"));
    if (this.hasWorkspaceEvidence) this.indexEvidence(this.repo.getImportRelationships(this.projectRoot));
  }

  private indexEvidence(relationships: ImportRelationship[]): void {
    for (const edge of relationships) {
      const byTarget = this.evidenceByFile.get(edge.source.file) ?? new Map<string, ImportRelationship>();
      this.evidenceByFile.set(edge.source.file, byTarget);
      const target = edge.resolution.source.target;
      if (!byTarget.has(target)) byTarget.set(target, edge);
    }
  }

  /**
   * Resolve an import target path (relative or alias) to a FileRecord in the catalog.
   */
  public resolveImportTargets(sourceFilePath: string, importTarget: string): FileRecord[] {
    if (!this.hasWorkspaceEvidence && !this.evidenceByFile.has(sourceFilePath)) {
      this.evidenceByFile.set(sourceFilePath, new Map());
      this.indexEvidence(this.repo.getImportRelationships(this.projectRoot, sourceFilePath));
    }
    const evidence = this.evidenceByFile.get(sourceFilePath)?.get(importTarget);
    if (evidence && (evidence.freshness !== "current" || evidence.index_coverage !== "complete")) return [];
    const result = evidence?.resolution ?? new ImportResolver(this.projectRoot, this.repo.getAllDomains?.().map(domain => domain.root_path) ?? []).resolve(importTarget, sourceFilePath);
    if (result.status !== "resolved" || result.coverage === "conditional") {
      // Fallback: check symbols in repository (e.g. PHP namespace classes, Go packages, Python modules)
      const matching = this.repo.findSymbolsByName(importTarget);
      if (matching.length === 1) {
        const file = this.findFile(matching[0].file_path);
        if (file) return [file];
      }
      const shortName = importTarget.split(/[\/\\]/).pop();
      if (shortName && shortName !== importTarget) {
        const shortMatches = this.repo.findSymbolsByName(shortName);
        if (shortMatches.length === 1) {
          const file = this.findFile(shortMatches[0].file_path);
          if (file) return [file];
        }
      }
      return [];
    }
    return result.targets.flatMap(target => target.files).flatMap(file => {
      const indexed = this.findFile(file);
      return indexed ? [indexed] : [];
    });
  }

  public resolveImportToFile(sourceFilePath: string, importTarget: string): FileRecord | undefined {
    if (this.repo.getMeta?.("workspace_root")) {
      const targets = this.resolveImportTargets(sourceFilePath, importTarget);
      return targets.length === 1 ? targets[0] : undefined;
    }
    // 1. Relative import (./ or ../)
    if (importTarget.startsWith(".")) {
      const sourceDir = dirname(sourceFilePath);
      const combined = normalize(join(sourceDir, importTarget)).replace(/\\/g, "/");

      const candidates = [
        combined,
        `${combined}.ts`,
        `${combined}.tsx`,
        `${combined}.js`,
        `${combined}.jsx`,
        `${combined}/index.ts`,
        `${combined}/index.js`,
      ];

      for (const cand of candidates) {
        const found = this.findFile(cand);
        if (found) return found;
      }
    }

    // 2. Alias import (@/... or src/...)
    const cleanAlias = importTarget.replace(/^@\//, "src/");
    const aliasCandidates = [
      cleanAlias,
      `${cleanAlias}.ts`,
      `${cleanAlias}.tsx`,
      `${cleanAlias}.js`,
      `${cleanAlias}.jsx`,
      `${cleanAlias}/index.ts`,
      `${cleanAlias}/index.js`,
    ];

    for (const cand of aliasCandidates) {
      const found = this.findFile(cand);
      if (found) return found;
    }

    // 3. Basename search fallback
    const baseTarget = importTarget.split("/").pop()?.replace(/\.[^.]+$/, "");
    if (baseTarget && baseTarget.length > 3) {
      for (const [norm, file] of this.indexedFiles.entries()) {
        if (norm.includes(`/${baseTarget.toLowerCase()}.`) || norm.endsWith(`/${baseTarget.toLowerCase()}`)) {
          return file;
        }
      }
    }

    return undefined;
  }
}
