import { assertPathContained } from "../../core/resolver/path-resolver.ts";
import { readSourceFile } from "../../core/resources/source-files.ts";
import { computeContentHash } from "../../core/ingestion/hasher.ts";
import { relative, resolve } from "node:path";
import { auditStagedFiles } from "../../core/boundary/staged-auditor.ts";
import type { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { BoundaryViolation } from "../../types/index.ts";
import { CheckBoundarySchema, type CheckBoundaryArgs } from "../schemas.ts";

export type { CheckBoundaryArgs } from "../schemas.ts";

export async function handleCheckBoundary(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  rawArgs: unknown,
  repo?: SeptumRepository,
  workspaceRoot?: string
) {
  return evaluateBoundary(evaluator, config, CheckBoundarySchema.parse(rawArgs ?? {}), repo, workspaceRoot);
}

export async function evaluateBoundary(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  args: CheckBoundaryArgs,
  repo?: SeptumRepository,
  workspaceRoot?: string
) {
  if (args.domain) {
    const knownDomains = new Set([
      ...Object.keys(config.domains || {}),
      ...(repo?.getAllDomains?.().map((d) => d.name) ?? []),
    ]);
    const domain = [...knownDomains].find(name => name.toLowerCase() === args.domain!.toLowerCase());
    if (!domain) throw new Error(`Unknown boundary domain '${args.domain}'. Choose a registered domain.`);
    args.domain = domain;
  }
  const root = workspaceRoot || args.workspace_path || process.cwd();
  const proposedImports = args.proposed_imports ?? [];
  const evaluatedScope = { mode: "proposal", proposed_imports_supplied: args.proposed_imports_supplied, existing_imports_checked: false, omissions: ["Existing file imports are not certified by proposal approval."] };

  const syncState = repo?.getMeta("sync_state");
  const syncError = repo?.getMeta("sync_error");
  if (!syncState || syncState === "running" || syncState === "error" || syncState !== "complete" || syncError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "unknown",
            sync_state: syncState || "unindexed",
            sync_error: syncError || undefined,
            message: "Boundary audit is incomplete because workspace synchronization has not completed.",
          }),
        },
      ],
    };
  }
  const skipped = JSON.parse(repo?.getMeta("skipped_files") || "[]") as {path: string; reason: string}[];
  const unsupported = JSON.parse(repo?.getMeta("unsupported_files") || "[]") as string[];
  const requested = [...(Array.isArray(args.file_path) ? args.file_path : args.file_path ? [args.file_path] : []), ...(args.file_paths || [])]
    .map(file => relative(root, resolve(root, file)).replace(/\\/g, "/"));
  const relevantUnsupported = unsupported.filter(file =>
    (!args.domain || evaluator.resolveSourceDomain(file, config) === args.domain) &&
    (requested.length === 0 || requested.includes(file))
  );
  const relevantSkipped = skipped.filter(file =>
    (!args.domain || evaluator.resolveSourceDomain(file.path, config) === args.domain) &&
    (requested.length === 0 || requested.includes(file.path))
  );
  if (relevantSkipped.length > 0 && args.scope !== "staged" && !args.staged) {
    return { content: [{type: "text" as const, text: JSON.stringify({status: "unknown", skipped_files: relevantSkipped, message: "Boundary audit is incomplete because source files exceed resource limits."})}] };
  }
  if (relevantUnsupported.length > 0 && args.scope !== "staged" && !args.staged) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "unknown", unsupported_files: relevantUnsupported, message: "Boundary audit is incomplete because source files have no supported parser." }) }] };
  }

  if (args.scope !== "staged" && !args.staged && repo) {
    const relevant = (file: string) => (!args.domain || evaluator.resolveSourceDomain(file,config) === args.domain) && (requested.length === 0 || requested.includes(file));
    const staleFiles = repo.getMeta("workspace_root") ? repo.getAllFiles().filter(file => relevant(file.path)).filter(file => {
      try { assertPathContained(file.path,root,"Boundary source"); return computeContentHash(readSourceFile(resolve(root,file.path))) !== file.content_hash; }
      catch { return true; }
    }).map(file => file.path) : [];
    const relationships = repo.getImportRelationships(root).filter(edge => relevant(edge.source.file));
    const incomplete = relationships.filter(edge => edge.index_coverage === "partial" || edge.freshness !== "current" || !["resolved","external"].includes(edge.resolution.status) || edge.resolution.coverage === "conditional" || edge.target_domains.length > 1);
    const allProposed = requested.flatMap(file => proposedImports.map(target => evaluator.getResolver().resolveImport(target, file)));
    const proposed = allProposed.filter(result => !["resolved", "external"].includes(result.status) || result.coverage === "conditional");
    if (incomplete.length || proposed.length || staleFiles.length) {
      const known = evaluator.auditCodebase(config).filter(violation => relevant(violation.file));
      known.push(...requested.flatMap(file => evaluator.evaluate(file, proposedImports, config)));
      return { content: [{ type: "text" as const, text: JSON.stringify({
        status: known.length ? "rejected" : "unknown", violations: known, total_violations: known.length,
        circular_dependencies: known.filter(v => v.rule === "circular_dependency"), circular_dependencies_count: known.filter(v => v.rule === "circular_dependency").length,
        relationships: incomplete.slice(0, 10), proposed_resolutions: allProposed,
        diagnostic_accounting: { total: incomplete.length, returned: Math.min(10, incomplete.length), omitted: Math.max(0, incomplete.length - 10) },
        incomplete_reasons: {
          target_not_fully_indexed: incomplete.filter(edge => edge.index_coverage === "partial").length,
          stale_source: incomplete.filter(edge => edge.freshness !== "current").length,
          unresolved_or_unsupported: incomplete.filter(edge => !["resolved", "external"].includes(edge.resolution.status)).length,
          conditional_resolution: incomplete.filter(edge => edge.resolution.coverage === "conditional").length,
          multiple_domains: incomplete.filter(edge => edge.target_domains.length > 1).length,
        },
        next: ["Inspect the listed source imports; register/index uncovered target roots or narrow scope to a file/domain. Unknown is not approval."],
        stale_files: staleFiles,
        message: "Relevant import resolution is incomplete; an empty graph cannot prove boundary approval.",
      }) }] };
    }
  }

  const filesToCheck: string[] = [];
  if (args.file_paths && Array.isArray(args.file_paths) && args.file_paths.length > 0) {
    filesToCheck.push(...args.file_paths);
  } else if (args.file_path) {
    if (Array.isArray(args.file_path)) {
      filesToCheck.push(...args.file_path);
    } else if (typeof args.file_path === "string" && args.file_path.trim().length > 0) {
      filesToCheck.push(args.file_path.trim());
    }
  }

  // Repo-wide, domain-scoped, or git-staged boundary audit when neither file_path nor file_paths is provided
  if (filesToCheck.length === 0) {
    const effectiveScope =
      args.scope ?? (args.staged ? "staged" : args.domain ? "domain" : "all");

    if (effectiveScope === "staged") {
      const { files: stagedFiles, violations: stagedViolations, resolution_issues: resolutionIssues } = await auditStagedFiles(evaluator, config, root, repo);

      if (stagedFiles.length === 0 && stagedViolations.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "approved",
                  scope: "staged",
                  total_checked: 0,
                  total_violations: 0,
                  circular_dependencies: [],
                  domain_violation_breakdown: {},
                  violations: [],
                  message: "No git staged files found. Boundary check passed.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const filteredViolations = args.domain
        ? stagedViolations.filter(
            (v) =>
              v.source_domain.toLowerCase() === args.domain!.toLowerCase() ||
              v.target_domain.toLowerCase() === args.domain!.toLowerCase()
          )
        : stagedViolations;

      const circularDependencies = filteredViolations.filter((v) => v.rule === "circular_dependency");
      const domainBreakdown: Record<string, number> = {};
      for (const v of filteredViolations) {
        const pair = `${v.source_domain} -> ${v.target_domain}`;
        domainBreakdown[pair] = (domainBreakdown[pair] || 0) + 1;
      }

      const hasViolations = filteredViolations.length > 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: hasViolations ? "rejected" : resolutionIssues.length ? "unknown" : "approved",
                resolution_issues: resolutionIssues,
                scope: "staged",
                total_checked: stagedFiles.length,
                total_violations: filteredViolations.length,
                circular_dependencies_count: circularDependencies.length,
                circular_dependencies: circularDependencies,
                domain_violation_breakdown: domainBreakdown,
                violations: filteredViolations,
                message: resolutionIssues.length && !hasViolations ? "Staged import resolution is incomplete; approval is unknown." : hasViolations
                  ? `${filteredViolations.length} boundary violation(s) detected across ${stagedFiles.length} staged file(s).`
                  : `All ${stagedFiles.length} staged file(s) approved. No boundary violations detected.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Scope: "all" or "domain"
    let violations = evaluator.auditCodebase(config);
    if (args.domain) {
      const targetDom = args.domain.toLowerCase();
      violations = violations.filter(
        (v) =>
          v.source_domain.toLowerCase() === targetDom ||
          v.target_domain.toLowerCase() === targetDom
      );
    }

    const circularDependencies = violations.filter((v) => v.rule === "circular_dependency");
    const domainBreakdown: Record<string, number> = {};
    for (const v of violations) {
      const pair = `${v.source_domain} -> ${v.target_domain}`;
      domainBreakdown[pair] = (domainBreakdown[pair] || 0) + 1;
    }

    const hasViolations = violations.length > 0;
    const domainCount = Object.keys(config?.domains || {}).length;
    const allIndexedFiles = repo && typeof repo.getAllFiles === "function" ? repo.getAllFiles() : [];
    const domainFileCount = args.domain && allIndexedFiles.length > 0
      ? allIndexedFiles.filter((f) => evaluator.resolveSourceDomain(f.path, config) === args.domain).length
      : null;
    const emptyScopedDomain = Boolean(args.domain && domainFileCount === 0);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: hasViolations ? "rejected" : emptyScopedDomain ? "unknown" : "approved",
              scope: args.domain ? "domain" : "all",
              ...(args.domain ? { domain: args.domain } : {}),
              total_domains_checked: domainCount,
              total_violations: violations.length,
              circular_dependencies_count: circularDependencies.length,
              circular_dependencies: circularDependencies,
              domain_violation_breakdown: domainBreakdown,
              violations,
              message: hasViolations
                ? `${violations.length} boundary violation(s) (${circularDependencies.length} circular) detected${
                    args.domain ? ` in domain '${args.domain}'` : " across codebase"
                  }.`
                : emptyScopedDomain
                ? `Boundary check is incomplete: domain '${args.domain}' has 0 indexed files (it may be unindexed or shadowed by a parent domain).`
                : domainCount === 0
                ? "No boundary violations detected. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_map' with action='register' to initialize bounded contexts.]"
                : `All domain boundaries are clean${
                    args.domain ? ` for domain '${args.domain}'` : ""
                  }. Zero cross-domain leaks or circular dependencies detected.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Multi-file batch evaluation
  if (filesToCheck.length > 1) {
    const results = filesToCheck.map((filePath) => {
      const violations = evaluator.evaluate(filePath, proposedImports, config);
      const impact = repo?.getFileInboundImpact(filePath);
      return {
        file: filePath,
        evaluated_scope: evaluatedScope,
        status: violations.length > 0 ? "rejected" : "approved",
        violations,
        impact_summary: impact
          ? {
              direct_dependents: impact.direct_dependents_count,
              top_consumers: impact.top_consumers,
              symbols_count: impact.symbols_count,
              risk_level: impact.risk_level,
            }
          : undefined,
      };
    });

    const totalViolations = results.reduce((acc, r) => acc + r.violations.length, 0);
    const hasViolations = totalViolations > 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: hasViolations ? "rejected" : "approved",
              total_checked: filesToCheck.length,
              total_violations: totalViolations,
              results,
              message: hasViolations
                ? `${totalViolations} boundary violation(s) detected across ${filesToCheck.length} file(s).`
                : Object.keys(config?.domains || {}).length === 0
                ? `All ${filesToCheck.length} file(s) approved. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_map' with action='register' to initialize bounded contexts.]`
                : `All ${filesToCheck.length} file(s) approved. No boundary violations detected.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Single file evaluation (backward-compatible output)
  const singleFile = filesToCheck[0];
  const violations = evaluator.evaluate(singleFile, proposedImports, config);
  const impact = repo?.getFileInboundImpact(singleFile);
  const enforcementMode = config?.settings?.enforcement ?? "strict";

  if (violations.length > 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "rejected",
              enforcement_mode: enforcementMode,
              file: singleFile,
              evaluated_scope: evaluatedScope,
              violations_count: violations.length,
              violations,
              impact_summary: impact
                ? {
                    direct_dependents: impact.direct_dependents_count,
                    top_consumers: impact.top_consumers,
                    symbols_count: impact.symbols_count,
                    risk_level: impact.risk_level,
                  }
                : undefined,
              message:
                Object.keys(config?.domains || {}).length === 0
                  ? "Boundary integrity check failed: Domain catalog is currently unindexed. Run 'septum_map' with action='register' to initialize bounded contexts."
                  : violations.some((v) => v.rule === "unmapped_domain")
                  ? "Boundary integrity check failed: File does not belong to any declared bounded context."
                  : "Boundary violation detected. Proposed imports violate bounded context architecture.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "approved",
            enforcement_mode: enforcementMode,
            file: singleFile,
            evaluated_scope: evaluatedScope,
            impact_summary: impact
              ? {
                  direct_dependents: impact.direct_dependents_count,
                  top_consumers: impact.top_consumers,
                  symbols_count: impact.symbols_count,
                  risk_level: impact.risk_level,
                }
              : undefined,
            message:
              Object.keys(config?.domains || {}).length === 0
                ? "No boundary violations detected. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_map' with action='register' to initialize bounded contexts.]"
                : enforcementMode === "warn"
                ? "Approved under 'warn' enforcement (unlisted allowed_dependencies are not blocked; only explicit forbidden_dependencies are rejected)."
                : impact && impact.direct_dependents_count > 0
                ? `No boundary violations detected. Caution: ${impact.direct_dependents_count} dependent file(s) consume this file.`
                : "Proposal approved. Existing file imports were not audited.",
          },
          null,
          2
        ),
      },
    ],
  };
}
