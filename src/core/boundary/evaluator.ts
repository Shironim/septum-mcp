import type { ImportEvidence, IndexedDependency } from "../resolver/import-evidence.ts";
import { posix, relative, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { BoundaryViolation, ImportResolution } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import { ConfigLoader } from "../config/loader.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { ModuleResolver } from "../resolver/module-resolver.ts";
import { matchesSimpleGlob } from "../parser/extractors/base.ts";
import { assertUniqueDomainRoots } from "../config/domain-ownership.ts";

function dependencyKey(file: string, line: number, target: string, statement: string): string {
  return JSON.stringify([file, line, target, statement]);
}

function indexedDependencyKey(dependency: IndexedDependency): string {
  return dependencyKey(dependency.source_file, dependency.line_number, dependency.target, dependency.statement);
}

export class BoundaryEvaluator {
  private repo?: SeptumRepository;
  private resolver: ModuleResolver;

  constructor(repo?: SeptumRepository, resolver?: ModuleResolver) {
    this.repo = repo;
    this.resolver = resolver ?? new ModuleResolver(process.cwd(), repo);
  }

  public getResolver(): ModuleResolver {
    return this.resolver;
  }

  public withResolver(resolver: ModuleResolver): BoundaryEvaluator {
    return new BoundaryEvaluator(this.repo, resolver);
  }

  public evaluate(
    filePath: string,
    proposedImports: string[] = [],
    config?: ValidatedSeptumConfig
  ): BoundaryViolation[] {
    let activeConfig = config;
    if (!activeConfig) {
      const fromRepo = this.repo ? ConfigLoader.loadFromRepository(this.repo) : undefined;
      activeConfig =
        fromRepo && Object.keys(fromRepo.domains).length > 0
          ? fromRepo
          : ConfigLoader.load(undefined, this.resolver.getProjectRoot());
    }
    assertUniqueDomainRoots(activeConfig.domains, this.resolver.getProjectRoot());
    const violations: BoundaryViolation[] = [];

    if (proposedImports.length > 0) {
      violations.push(...this.checkProposedChanges(filePath, proposedImports, activeConfig));
      const sourceDomain = this.resolveSourceDomain(filePath, activeConfig);
      if (sourceDomain && typeof this.repo?.getAllDependenciesWithDomains === "function") {
        // Resolutions from import-evidence (requires workspace_root meta) — optional, used for
        // richer cycle detection. Falls back to raw indexed deps when unavailable (e.g. in tests).
        const indexed = this.repo?.getMeta?.("workspace_root");
        const auditEvidence = (indexed && this.repo ? this.repo.getImportEvidence(this.resolver.getProjectRoot()) : undefined);
        const evidence = indexed ? auditEvidence?.relationships : undefined;
        const resolutions = evidence && new Map(evidence.filter(edge => edge.freshness === "current").map(edge => [
          dependencyKey(edge.source.file, edge.source.line, edge.resolution.source.target, edge.source.statement),
          edge.resolution,
        ]));

        const allDeps = this.repo.getAllDependenciesWithDomains();
        const existingDeps = allDeps.filter(
          (dep) => dep.source_file !== filePath
        );
        const proposedDeps = proposedImports.map((statement) => ({
          source_file: filePath,
          source_domain: sourceDomain,
          line_number: 1,
          target: statement,
          statement,
          is_external: false,
        }));

        // Baseline: detect cycles that already exist in the indexed graph, independent of
        // workspace_root / import-evidence so the tagging works even in in-memory test repos.
        // We detect against ALL deps (no filter) so we capture all existing cycles regardless
        // of which file anchors the DFS traversal.
        const baselineCycles = this.detectCircularDependencies(
          activeConfig,
          allDeps,
          undefined, // no relevantFiles filter — capture all pre-existing cycles
          resolutions
        );
        // Normalize cycle messages to a rotation-agnostic canonical form:
        // extract the node list, sort it, then join. This handles DFS start-node differences.
        const extractCycleNodeSet = (msg: string): string => {
          const match = /detected: (.+)\.$/.exec(msg);
          if (!match) return msg;
          // "a -> b -> a" → split, dedupe, sort
          const nodes = match[1]!.split(" -> ").filter((n, i, arr) => !(i === arr.length - 1 && n === arr[0]));
          return nodes.sort().join(",");
        };
        const baselineCanonicals = new Set(baselineCycles.map((c) => extractCycleNodeSet(c.message)));

        const detectedCycles = this.detectCircularDependencies(
          activeConfig,
          [...existingDeps, ...proposedDeps],
          new Set([filePath]),
          resolutions
        );

        for (const cycle of detectedCycles) {
          if (baselineCanonicals.has(extractCycleNodeSet(cycle.message))) {
            cycle.pre_existing = true;
          }
          violations.push(cycle);
        }
      }
    }

    return violations;
  }

  public auditCodebase(config: ValidatedSeptumConfig, snapshot?: ImportEvidence): BoundaryViolation[] {
    return this.auditCodebaseWithWarnings(config, snapshot).violations;
  }

  public auditCodebaseWithWarnings(
    config: ValidatedSeptumConfig,
    snapshot?: ImportEvidence
  ): { violations: BoundaryViolation[]; warnings: BoundaryViolation[] } {
    assertUniqueDomainRoots(config.domains, this.resolver.getProjectRoot());
    const violations: BoundaryViolation[] = [];
    const warnings: BoundaryViolation[] = [];
    const indexed = this.repo?.getMeta?.("workspace_root");
    const auditEvidence = snapshot ?? (indexed && this.repo ? this.repo.getImportEvidence(this.resolver.getProjectRoot()) : undefined);
    const allDependencies = auditEvidence?.dependencies ?? this.repo?.getAllDependenciesWithDomains() ?? [];
    const evidence = indexed ? auditEvidence?.relationships : undefined;
    const resolutions = evidence && new Map(evidence.filter(edge => edge.freshness === "current").map(edge => [
      dependencyKey(edge.source.file, edge.source.line, edge.resolution.source.target, edge.source.statement),
      edge.resolution,
    ]));
    for (const dep of allDependencies) {
      const resolution = resolutions?.get(indexedDependencyKey(dep));
      if (resolutions && (resolution?.status !== "resolved" || resolution.coverage === "conditional")) continue;
      const evaluation = this.evaluateDependencyRuleWithWarning({
        sourceFile: dep.source_file,
        sourceDomain: dep.source_domain,
        line: dep.line_number,
        target: dep.target,
        statement: dep.statement,
        config,
        mode: "audit",
        resolution,
      });
      if (evaluation.violation) violations.push(evaluation.violation);
      if (evaluation.warning) warnings.push(evaluation.warning);
    }

    const currentDependencies = resolutions ? allDependencies.filter(dep => resolutions.has(indexedDependencyKey(dep))) : allDependencies;
    violations.push(...this.detectCircularDependencies(config, currentDependencies, undefined, resolutions));

    return { violations, warnings };
  }

  public detectCircularDependencies(
    config: ValidatedSeptumConfig,
    preloadedDeps?: IndexedDependency[],
    relevantFiles?: ReadonlySet<string>,
    resolutions?: ReadonlyMap<string, ImportResolution>,
  ): BoundaryViolation[] {
    assertUniqueDomainRoots(config.domains, this.resolver.getProjectRoot());
    const violations: BoundaryViolation[] = [];
    let allDependencies = preloadedDeps ?? this.repo?.getAllDependenciesWithDomains() ?? [];
    if (!preloadedDeps && this.repo?.getMeta?.("workspace_root")) {
      const current = this.repo.getImportRelationships(this.resolver.getProjectRoot());
      const currentEdgeKeys = new Set<string>();
      for (const edge of current) {
        if (edge.freshness === "current") {
          currentEdgeKeys.add(`${edge.source.file}\0${edge.source.line}`);
        }
      }
      allDependencies = allDependencies.filter((dep) =>
        currentEdgeKeys.has(`${dep.source_file}\0${dep.line_number}`)
      );
    }

    // Prepare file lookup maps for internal file-to-file resolution
    const fileByNormPath = new Map<string, string>();
    const fileByNoExtPath = new Map<string, string>();

    const registerKnownFile = (rawPath: string) => {
      const norm = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
      fileByNormPath.set(norm.toLowerCase(), rawPath);
      const noExt = norm.replace(/\.[^/.]+$/, "").toLowerCase();
      fileByNoExtPath.set(noExt, rawPath);
      if (noExt.endsWith("/index")) {
        fileByNoExtPath.set(noExt.slice(0, -"/index".length), rawPath);
      }
    };

    if (typeof this.repo?.getAllFiles === "function") {
      for (const f of this.repo.getAllFiles()) {
        registerKnownFile(f.path);
      }
    }
    for (const d of allDependencies) {
      registerKnownFile(d.source_file);
    }

    const resolveTargetFile = (sourceFile: string, rawTarget: string, statement?: string): string | null => {
      if (this.repo?.getMeta?.("workspace_root") || existsSync(resolve(this.resolver.getProjectRoot(), sourceFile))) {
        const result = this.resolver.resolveImport(rawTarget,sourceFile,statement);
        const files = result.targets.flatMap(target => target.files);
        return result.status === "resolved" && result.coverage !== "conditional" && files.length === 1 ? files[0]! : null;
      }
      const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
      if (!cleaned) return null;

      if (cleaned.startsWith(".")) {
        const srcDir = posix.dirname(sourceFile.replace(/\\/g, "/"));
        const joined = posix.normalize(posix.join(srcDir, cleaned)).replace(/^\.\//, "");
        const lowerJoined = joined.toLowerCase();
        const exact =
          fileByNormPath.get(lowerJoined) ??
          fileByNoExtPath.get(lowerJoined.replace(/\.[^/.]+$/, ""));
        if (exact) return exact;
      }

      const aliasClean = cleaned.replace(/^@\//, "src/").replace(/^\.\//, "");
      const lowerAlias = aliasClean.toLowerCase();
      const byAlias =
        fileByNormPath.get(lowerAlias) ??
        fileByNoExtPath.get(lowerAlias.replace(/\.[^/.]+$/, ""));
      if (byAlias) return byAlias;

      return null;
    };

    type EdgeMeta = {
      files: Set<string>;
      file: string;
      line: number;
      source_domain: string;
      target_domain: string;
      target: string;
    };

    const fileGraph = new Map<string, Map<string, EdgeMeta>>();
    const domainGraph = new Map<string, Map<string, EdgeMeta>>();

    const isTypeOnlyImport = (statement?: string): boolean => {
      if (!statement) return false;
      return /^\s*(?:import|export)\s+type\b/.test(statement.trim());
    };

    for (const dep of allDependencies) {
      const indexed = this.repo?.getMeta?.("workspace_root");
      const resolution = resolutions?.get(indexedDependencyKey(dep)) ??
        (indexed ? this.resolver.resolveImport(dep.target, dep.source_file, dep.statement) : undefined);
      if (resolution) {
        if (resolution.status !== "resolved" || resolution.coverage === "conditional") continue;
      } else if (dep.is_external) continue;

      const targetDomain = resolution
        ? this.resolver.resolveDomainFromEvidence(resolution, config)
        : this.resolveTargetDomain(dep.target, config, dep.source_file, dep.statement);

      // 1. Domain-to-domain edge (exclude virtual/top-level aggregator "root" domain and type-only imports)
      if (
        targetDomain &&
        targetDomain !== dep.source_domain &&
        dep.source_domain !== "root" &&
        targetDomain !== "root" &&
        !isTypeOnlyImport(dep.statement)
      ) {
        let outMap = domainGraph.get(dep.source_domain);
        if (!outMap) {
          outMap = new Map();
          domainGraph.set(dep.source_domain, outMap);
        }
        if (!outMap.has(targetDomain)) {
          outMap.set(targetDomain, {
            files: new Set([dep.source_file]),
            file: dep.source_file,
            line: dep.line_number,
            source_domain: dep.source_domain,
            target_domain: targetDomain,
            target: dep.target,
          });
        }
        outMap.get(targetDomain)!.files.add(dep.source_file);
      }

      // 2. File-to-file edge (type-only imports are erased at compile time and do not create runtime cycles)
      if (isTypeOnlyImport(dep.statement)) {
        continue;
      }

      const targetFiles = resolution?.targets.flatMap(target => target.files);
      const targetFile = targetFiles
        ? targetFiles.length === 1 ? targetFiles[0] : null
        : resolveTargetFile(dep.source_file, dep.target, dep.statement);
      if (targetFile && targetFile !== dep.source_file) {
        let outMap = fileGraph.get(dep.source_file);
        if (!outMap) {
          outMap = new Map();
          fileGraph.set(dep.source_file, outMap);
        }
        if (!outMap.has(targetFile)) {
          outMap.set(targetFile, {
            files: new Set([dep.source_file]),
            file: dep.source_file,
            line: dep.line_number,
            source_domain: dep.source_domain,
            target_domain: targetDomain ?? dep.source_domain,
            target: dep.target,
          });
        }
      }
    }

    const findCycles = (
      graph: Map<string, Map<string, EdgeMeta>>,
      kindLabel: "file" | "domain"
    ) => {
      const visited = new Set<string>();
      const stackIndex = new Map<string, number>();
      const stack: string[] = [];
      const reportedCycles = new Set<string>();

      const canonicalizeCycle = (nodes: string[]): string => {
        if (nodes.length === 0) return "";
        let minIdx = 0;
        for (let i = 1; i < nodes.length; i++) {
          if (nodes[i] < nodes[minIdx]) minIdx = i;
        }
        const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
        return rotated.join("->");
      };

      const dfs = (node: string) => {
        visited.add(node);
        stackIndex.set(node, stack.length);
        stack.push(node);

        const neighbors = graph.get(node);
        if (neighbors) {
          for (const [nextNode, edgeMeta] of neighbors.entries()) {
            if (!visited.has(nextNode)) {
              dfs(nextNode);
            } else {
              const cycleStartIndex = stackIndex.get(nextNode);
              if (cycleStartIndex !== undefined) {
                const cycleNodes = stack.slice(cycleStartIndex);
                const sig = canonicalizeCycle(cycleNodes);
                const cycleEdges = cycleNodes.map((source, index) => graph.get(source)?.get(cycleNodes[(index + 1) % cycleNodes.length]));
                if (relevantFiles && !cycleEdges.some(edge => edge && [...edge.files].some(file => relevantFiles.has(file)))) continue;
                if (!reportedCycles.has(sig)) {
                  reportedCycles.add(sig);
                  const firstNode = cycleNodes[0];
                  const secondNode = cycleNodes[1] ?? nextNode;
                  const firstEdge = graph.get(firstNode)?.get(secondNode) ?? edgeMeta;
                  const cycleDisplay = [...cycleNodes, cycleNodes[0]].join(" -> ");
                  violations.push({
                    file: firstEdge.file,
                    line: firstEdge.line,
                    source_domain: firstEdge.source_domain,
                    target_domain: firstEdge.target_domain,
                    imported_target: firstEdge.target,
                    rule: "circular_dependency",
                    message: `Circular ${kindLabel} dependency detected: ${cycleDisplay}.`,
                  });
                }
              }
            }
          }
        }

        stack.pop();
        stackIndex.delete(node);
      };

      for (const startNode of graph.keys()) {
        if (!visited.has(startNode)) {
          dfs(startNode);
        }
      }
    };

    findCycles(fileGraph, "file");
    findCycles(domainGraph, "domain");

    return violations;
  }

  public checkProposedChanges(
    sourceFilePath: string,
    proposedImports: string[],
    config: ValidatedSeptumConfig,
    importStatements?: string[]
  ): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];
    const sourceDomain = this.resolveSourceDomain(sourceFilePath, config);

    if (!sourceDomain) {
      violations.push({
        file: sourceFilePath,
        line: 1,
        source_domain: "unmapped",
        target_domain: "unknown",
        imported_target: "",
        rule: "unmapped_domain",
        message: `File '${sourceFilePath}' does not belong to any declared bounded context. Boundary integrity cannot be enforced.`,
      });
      return violations;
    }

    for (const [index, statement] of proposedImports.entries()) {
      const violation = this.evaluateDependencyRule({
        sourceFile: sourceFilePath,
        sourceDomain,
        line: 1,
        target: statement,
        statement: importStatements?.[index],
        config,
        mode: "proposal",
      });
      if (violation) violations.push(violation);
    }

    return violations;
  }

  private evaluateDependencyRule(params: {
    sourceFile: string;
    sourceDomain: string;
    line: number;
    target: string;
    statement?: string;
    config: ValidatedSeptumConfig;
    mode: "audit" | "proposal";
    resolution?: ImportResolution;
  }): BoundaryViolation | null {
    return this.evaluateDependencyRuleWithWarning(params).violation;
  }

  private evaluateDependencyRuleWithWarning(params: {
    sourceFile: string;
    sourceDomain: string;
    line: number;
    target: string;
    statement?: string;
    config: ValidatedSeptumConfig;
    mode: "audit" | "proposal";
    resolution?: ImportResolution;
  }): { violation: BoundaryViolation | null; warning: BoundaryViolation | null } {
    const { sourceFile, sourceDomain, line, target, statement, config, mode, resolution: evidence } = params;
    const sourceDomainConfig = config.domains[sourceDomain];
    if (!sourceDomainConfig) return { violation: null, warning: null };

    const targetDomain = evidence
      ? this.resolver.resolveDomainFromEvidence(evidence, config)
      : this.resolveTargetDomain(target, config, sourceFile, statement);
    if (!targetDomain) {
      if (
        config.settings.enforcement === "strict" &&
        (this.repo?.getMeta?.("workspace_root") || existsSync(resolve(this.resolver.getProjectRoot(), sourceFile)))
      ) {
        const resolution = evidence ?? this.resolver.resolveImport(target, sourceFile, statement);
        if (
          resolution.status === "resolved" &&
          resolution.coverage !== "conditional" &&
          resolution.targets.some((t) => t.kind === "file" && t.files.length > 0)
        ) {
          return {
            violation: {
              file: sourceFile,
              line,
              source_domain: sourceDomain,
              target_domain: "unmapped",
              imported_target: target,
              rule: "unmapped_domain",
              message: `Unmapped internal target: '${target}' resolves inside the workspace outside any declared bounded context.`,
            },
            warning: null,
          };
        }
      }
      return { violation: null, warning: null };
    }

    if (targetDomain === sourceDomain) return { violation: null, warning: null };

    const forbidden = sourceDomainConfig.forbidden_dependencies ?? [];
    const allowed = sourceDomainConfig.allowed_dependencies ?? [];

    if (forbidden.includes(targetDomain)) {
      return {
        violation: {
          file: sourceFile,
          line,
          source_domain: sourceDomain,
          target_domain: targetDomain,
          imported_target: target,
          rule: "forbidden_dependency",
          message:
            mode === "proposal"
              ? `Illegal import blocked: Domain '${sourceDomain}' is strictly forbidden from importing domain '${targetDomain}'.`
              : `Forbidden cross-domain dependency detected: '${sourceDomain}' is strictly prohibited from importing domain '${targetDomain}'.`,
        },
        warning: null,
      };
    }

    if (!allowed.includes(targetDomain)) {
      if (config.settings.enforcement === "strict") {
        return {
          violation: {
            file: sourceFile,
            line,
            source_domain: sourceDomain,
            target_domain: targetDomain,
            imported_target: target,
            rule: "disallowed_dependency",
            message:
              mode === "proposal"
                ? `Unlisted domain dependency: '${targetDomain}' must be explicitly added to allowed_dependencies before domain '${sourceDomain}' can import it.`
                : `Disallowed dependency: '${targetDomain}' is not declared in allowed_dependencies for domain '${sourceDomain}'.`,
          },
          warning: null,
        };
      }
      return {
        violation: null,
        warning: {
          file: sourceFile,
          line,
          source_domain: sourceDomain,
          target_domain: targetDomain,
          imported_target: target,
          rule: "disallowed_dependency",
          message:
            mode === "proposal"
              ? `Unlisted dependency warning (warn mode): '${targetDomain}' is not declared in allowed_dependencies for domain '${sourceDomain}'.`
              : `Unlisted dependency warning (warn mode): '${targetDomain}' is not declared in allowed_dependencies for domain '${sourceDomain}'.`,
        },
      };
    }

    return { violation: null, warning: null };
  }

  public resolveSourceDomain(filePath: string, config: ValidatedSeptumConfig): string | null {
    return this.resolver.resolveSourceDomain(filePath, config);
  }

  public resolveTargetDomain(
    targetStatement: string,
    config: ValidatedSeptumConfig,
    sourceFilePath?: string,
    statement?: string
  ): string | null {
    return this.resolver.resolveTargetDomain(targetStatement, sourceFilePath, config, statement);
  }
}
