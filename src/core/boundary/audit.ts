import type { ImportEvidence } from "../resolver/import-evidence.ts";
import { relative, resolve } from "node:path";
import { auditStagedFiles } from "../boundary/staged-auditor.ts";
import type { BoundaryEvaluator } from "../boundary/evaluator.ts";
import { ConfigLoader } from "../config/loader.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SeptumRepository } from "../database/repository.ts";
import type { BoundaryViolation } from "../../types/index.ts";

export interface BoundaryAuditRequest {
  file_path?: string;
  file_paths?: string[];
  proposed_imports?: string[];
  proposed_imports_supplied?: boolean;
  scope?: "file" | "all" | "staged" | "domain";
  domain?: string;
  staged?: boolean;
}

interface BoundaryAuditPayload {
  status: "approved" | "rejected" | "unknown";
  message: string;
  violations?: BoundaryViolation[];
  unsupported_files?: string[];
  skipped_files?: { path: string; reason: string }[];
  relationships?: ReturnType<SeptumRepository["getImportRelationships"]>;
}

function incompleteEvidence<T extends BoundaryAuditPayload>(payload: T) {
  return { payload, kind: "incomplete_evidence" as const };
}

function evaluated<T extends BoundaryAuditPayload>(payload: T) {
  return { payload, kind: "evaluated" as const };
}

function summarizeViolations(violations: BoundaryViolation[]) {
  const circularDependencies = violations.filter((v) => v.rule === "circular_dependency");
  const domainBreakdown: Record<string, number> = {};
  for (const v of violations) {
    const pair = `${v.source_domain} -> ${v.target_domain}`;
    domainBreakdown[pair] = (domainBreakdown[pair] || 0) + 1;
  }
  return {
    circular_dependencies_count: circularDependencies.length,
    circular_dependencies: circularDependencies,
    domain_violation_breakdown: domainBreakdown,
  };
}

export async function evaluateBoundary(
  evaluator: BoundaryEvaluator,
  loadedConfig: ValidatedSeptumConfig,
  args: BoundaryAuditRequest,
  repo: SeptumRepository | undefined,
  root: string
) {
  // Ingestion retains or discovers domains when file policy does not name any.
  // Use those indexed policies while keeping the explicitly loaded settings.
  const config = repo && Object.keys(loadedConfig.domains).length === 0
    ? { ...loadedConfig, domains: ConfigLoader.loadFromRepository(repo).domains }
    : loadedConfig;
  if (args.domain) {
    const knownDomains = new Set([
      ...Object.keys(config.domains || {}),
      ...(repo?.getAllDomains?.().map((d) => d.name) ?? []),
    ]);
    const domain = [...knownDomains].find(name => name.toLowerCase() === args.domain!.toLowerCase());
    if (!domain) throw new Error(`Unknown boundary domain '${args.domain}'. Choose a registered domain.`);
    args = { ...args, domain };
  }
  const proposedImports = args.proposed_imports ?? [];
  const evaluatedScope = { mode: "proposal", proposed_imports_supplied: args.proposed_imports_supplied, existing_imports_checked: false, omissions: ["Existing file imports are not certified by proposal approval."] };

  const requested = [...(Array.isArray(args.file_path) ? args.file_path : args.file_path ? [args.file_path] : []), ...(args.file_paths || [])]
    .map(file => relative(root, resolve(root, file)).replace(/\\/g, "/"));
  const effectiveScope = requested.length > 0
    ? "file"
    : (args.scope ?? (args.staged ? "staged" : args.domain ? "domain" : "all"));

  const syncState = repo?.getMeta("sync_state");
  const syncError = repo?.getMeta("sync_error");
  if (!syncState || syncState === "running" || syncState === "error" || syncState !== "complete" || syncError) {
    return incompleteEvidence({
      status: "unknown",
      scope: effectiveScope,
      ...(args.domain ? { domain: args.domain } : {}),
      sync_state: syncState || "unindexed",
      sync_error: syncError || undefined,
      message: "Boundary audit is incomplete because workspace synchronization has not completed.",
    });
  }
  const skipped = JSON.parse(repo?.getMeta("skipped_files") || "[]") as {path: string; reason: string}[];
  const unsupported = JSON.parse(repo?.getMeta("unsupported_files") || "[]") as string[];
  const relevantUnsupported = unsupported.filter(file =>
    (!args.domain || evaluator.resolveSourceDomain(file, config) === args.domain) &&
    (requested.length === 0 || requested.includes(file))
  );
  const relevantSkipped = skipped.filter(file =>
    (!args.domain || evaluator.resolveSourceDomain(file.path, config) === args.domain) &&
    (requested.length === 0 || requested.includes(file.path))
  );
  if (relevantSkipped.length > 0 && args.scope !== "staged" && !args.staged) {
    return incompleteEvidence({status: "unknown", scope: effectiveScope, ...(args.domain ? { domain: args.domain } : {}), skipped_files: relevantSkipped, message: "Boundary audit is incomplete because source files exceed resource limits."});
  }
  if (relevantUnsupported.length > 0 && args.scope !== "staged" && !args.staged) {
    return incompleteEvidence({ status: "unknown", scope: effectiveScope, ...(args.domain ? { domain: args.domain } : {}), unsupported_files: relevantUnsupported, message: "Boundary audit is incomplete because source files have no supported parser." });
  }

  let evidence: ImportEvidence | undefined;
  if (args.scope !== "staged" && !args.staged && repo) {
    const relevant = (file: string) => (!args.domain || evaluator.resolveSourceDomain(file,config) === args.domain) && (requested.length === 0 || requested.includes(file));
    evidence = repo.getImportEvidence(root, repo.getMeta("workspace_root") ? relevant : undefined);
    const staleFiles = evidence.staleFiles;
    const relationships = evidence.relationships.filter(edge => relevant(edge.source.file));
    const incomplete = relationships.filter(edge => edge.index_coverage === "partial" || edge.freshness !== "current" || !["resolved","external"].includes(edge.resolution.status) || edge.resolution.coverage === "conditional" || edge.target_domains.length > 1);
    const allProposed = requested.flatMap(file => proposedImports.map(target => evaluator.getResolver().resolveImport(target, file)));
    const proposed = allProposed.filter(result => !["resolved", "external"].includes(result.status) || result.coverage === "conditional");
    if (incomplete.length || proposed.length || staleFiles.length) {
      const known = evaluator.auditCodebase(config, evidence).filter(violation => relevant(violation.file));
      known.push(...requested.flatMap(file => evaluator.evaluate(file, proposedImports, config, evidence)));
      const incompleteReasons = {
        target_not_fully_indexed: incomplete.filter(edge => edge.index_coverage === "partial").length,
        stale_source: incomplete.filter(edge => edge.freshness !== "current").length,
        unresolved_or_unsupported: incomplete.filter(edge => !["resolved", "external"].includes(edge.resolution.status)).length,
        conditional_resolution: incomplete.filter(edge => edge.resolution.coverage === "conditional").length,
        multiple_domains: incomplete.filter(edge => edge.target_domains.length > 1).length,
      };
      const reasonParts = [
        incompleteReasons.target_not_fully_indexed > 0 ? `${incompleteReasons.target_not_fully_indexed} target(s) not fully indexed` : "",
        incompleteReasons.stale_source > 0 ? `${incompleteReasons.stale_source} stale source import(s)` : "",
        incompleteReasons.unresolved_or_unsupported > 0 ? `${incompleteReasons.unresolved_or_unsupported} unresolved/unsupported import(s)` : "",
        incompleteReasons.conditional_resolution > 0 ? `${incompleteReasons.conditional_resolution} conditional import(s)` : "",
        incompleteReasons.multiple_domains > 0 ? `${incompleteReasons.multiple_domains} multi-domain target(s)` : "",
        proposed.length > 0 ? `${proposed.length} unresolved/conditional proposed import(s)` : "",
        staleFiles.length > 0 ? `${staleFiles.length} stale indexed file(s)` : "",
      ].filter(Boolean);
      const reasonSummary = reasonParts.length > 0 ? reasonParts.join(", ") : "incomplete import evidence";
      const message = known.length > 0
        ? `${known.length} boundary violation(s) detected, and relevant import evidence is incomplete (${reasonSummary}).`
        : `Boundary approval is unknown because relevant import evidence is incomplete (${reasonSummary}).`;
      return incompleteEvidence({
        status: known.length ? "rejected" : "unknown",
        scope: effectiveScope,
        ...(args.domain ? { domain: args.domain } : {}),
        violations: known, total_violations: known.length,
        circular_dependencies: known.filter(v => v.rule === "circular_dependency"), circular_dependencies_count: known.filter(v => v.rule === "circular_dependency").length,
        relationships: incomplete.slice(0, 10), proposed_resolutions: allProposed,
        diagnostic_accounting: { total: incomplete.length, returned: Math.min(10, incomplete.length), omitted: Math.max(0, incomplete.length - 10) },
        incomplete_reasons: incompleteReasons,
        next: ["Inspect the listed source imports; register/index uncovered target roots or narrow scope to a file/domain. Unknown is not approval."],
        stale_files: staleFiles,
        message,
      });
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
      const {
        files: stagedFiles,
        violations: stagedViolations,
        resolution_issues: resolutionIssues,
        background_resolution_issues_count: backgroundResolutionIssuesCount,
      } = await auditStagedFiles(evaluator, config, root, repo);
      const enforcementMode = config?.settings?.enforcement ?? "strict";

      if (stagedFiles.length === 0 && stagedViolations.length === 0) {
        return evaluated({
          status: "approved",
          scope: "staged",
          enforcement_mode: enforcementMode,
          total_checked: 0,
          total_violations: 0,
          circular_dependencies_count: 0,
          circular_dependencies: [],
          domain_violation_breakdown: {},
          violations: [],
          message: "No git staged files found. Boundary check passed.",
        });
      }

      const filteredViolations = args.domain
        ? stagedViolations.filter(
            (v) =>
              v.source_domain.toLowerCase() === args.domain!.toLowerCase() ||
              v.target_domain.toLowerCase() === args.domain!.toLowerCase()
          )
        : stagedViolations;

      const hasViolations = filteredViolations.length > 0;
      return evaluated({
        status: hasViolations ? "rejected" : resolutionIssues.length ? "unknown" : "approved",
        resolution_issues: resolutionIssues,
        ...(backgroundResolutionIssuesCount > 0
          ? { background_resolution_issues_count: backgroundResolutionIssuesCount }
          : {}),
        scope: "staged",
        enforcement_mode: enforcementMode,
        total_checked: stagedFiles.length,
        total_violations: filteredViolations.length,
        ...summarizeViolations(filteredViolations),
        violations: filteredViolations,
        message: resolutionIssues.length && !hasViolations
          ? "Staged import resolution is incomplete; approval is unknown."
          : hasViolations
          ? `${filteredViolations.length} boundary violation(s) detected across ${stagedFiles.length} staged file(s).`
          : `All ${stagedFiles.length} staged file(s) approved. No boundary violations detected.`,
      });
    }

    // Scope: "all" or "domain"
    const auditResult = evaluator.auditCodebaseWithWarnings(config, evidence);
    let violations = auditResult.violations;
    let warnings = auditResult.warnings;
    if (args.domain) {
      const targetDom = args.domain.toLowerCase();
      violations = violations.filter(
        (v) =>
          v.source_domain.toLowerCase() === targetDom ||
          v.target_domain.toLowerCase() === targetDom
      );
      warnings = warnings.filter(
        (w) =>
          w.source_domain.toLowerCase() === targetDom ||
          w.target_domain.toLowerCase() === targetDom
      );
    }

    const summary = summarizeViolations(violations);
    const hasViolations = violations.length > 0;
    const hasWarnings = warnings.length > 0;
    const domainCount = Object.keys(config?.domains || {}).length;
    const allIndexedFiles = repo ? repo.getAllFiles() : [];
    const emptyScopedDomain = Boolean(args.domain && repo && !allIndexedFiles.some(
      (file) => evaluator.resolveSourceDomain(file.path, config) === args.domain,
    ));
    const emptyWorkspace = Boolean(repo && allIndexedFiles.length === 0);
    const uncoveredFiles: string[] = !args.domain && repo
      ? JSON.parse(repo.getMeta("uncovered_files") || "[]")
      : [];
    const hasUncoveredWorkspaceFiles = !args.domain && uncoveredFiles.length > 0;

    return evaluated({
      status: hasViolations ? "rejected" : emptyScopedDomain || emptyWorkspace || domainCount === 0 ? "unknown" : "approved",
      scope: args.domain ? "domain" : "all",
      enforcement_mode: config?.settings?.enforcement ?? "strict",
      ...(args.domain ? { domain: args.domain } : {}),
      total_domains_checked: domainCount,
      total_violations: violations.length,
      total_warnings: warnings.length,
      ...summary,
      violations,
      ...(hasWarnings ? { warnings } : {}),
      ...(hasUncoveredWorkspaceFiles ? { uncovered_files_count: uncoveredFiles.length } : {}),
      message: hasViolations
        ? `${violations.length} boundary violation(s) (${summary.circular_dependencies_count} circular) detected${
            args.domain ? ` in domain '${args.domain}'` : " across codebase"
          }.${hasWarnings ? ` Also ${warnings.length} unlisted dependency warning(s) in 'warn' mode.` : ""}`
        : emptyScopedDomain
        ? `Boundary check is incomplete: domain '${args.domain}' has 0 indexed files (it may be unindexed or shadowed by a parent domain).`
        : emptyWorkspace
        ? "Boundary check is incomplete: 0 source files are indexed across the workspace; an empty graph cannot prove boundary approval."
        : domainCount === 0
        ? "Boundary check is incomplete: no domain policies are available. Initialize or register domains before auditing."
        : hasWarnings
        ? `No blocking boundary violations detected${
            args.domain ? ` for domain '${args.domain}'` : ""
          }, but ${warnings.length} unlisted dependency warning(s) were found under 'warn' enforcement.`
        : hasUncoveredWorkspaceFiles
        ? `All registered domain boundaries are clean across ${allIndexedFiles.length} indexed file(s) (${uncoveredFiles.length} uncovered file(s) outside registered domains were not audited).`
        : `All domain boundaries are clean${
            args.domain ? ` for domain '${args.domain}'` : ""
          }. Zero cross-domain leaks or circular dependencies detected.`,
    });
  }

  const enforcementMode = config?.settings?.enforcement ?? "strict";

  // Multi-file batch evaluation
  if (filesToCheck.length > 1) {
    const results = filesToCheck.map((filePath) => {
      const violations = evaluator.evaluate(filePath, proposedImports, config, evidence);
      const impact = repo?.getFileInboundImpact(filePath, evidence?.relationships);
      return {
        file: filePath,
        evaluated_scope: evaluatedScope,
        status: violations.length > 0 ? "rejected" : "approved",
        total_violations: violations.length,
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

    return evaluated({
      status: hasViolations ? "rejected" : "approved",
      scope: "file",
      enforcement_mode: enforcementMode,
      total_checked: filesToCheck.length,
      total_violations: totalViolations,
      violations: results.flatMap((r) => r.violations),
      results,
      message: hasViolations
        ? `${totalViolations} boundary violation(s) detected across ${filesToCheck.length} file(s).`
        : Object.keys(config?.domains || {}).length === 0
        ? `All ${filesToCheck.length} file(s) approved. [Septum Notice: Domain catalog is currently unindexed. Run septum_map({action:'register', domain:'<name>', root:'<path>'}) to initialize bounded contexts.]`
        : `All ${filesToCheck.length} file(s) approved. No boundary violations detected.`,
    });
  }

  // Single file evaluation
  const singleFile = filesToCheck[0];
  const violations = evaluator.evaluate(singleFile, proposedImports, config, evidence);
  const impact = repo?.getFileInboundImpact(singleFile, evidence?.relationships);
  const impactSummary = impact
    ? {
        direct_dependents: impact.direct_dependents_count,
        top_consumers: impact.top_consumers,
        symbols_count: impact.symbols_count,
        risk_level: impact.risk_level,
      }
    : undefined;

  const newViolations = violations.filter((v) => !v.pre_existing);
  const preExistingViolations = violations.filter((v) => v.pre_existing);

  if (newViolations.length > 0) {
    return evaluated({
      status: "rejected",
      scope: "file",
      enforcement_mode: enforcementMode,
      file: singleFile,
      evaluated_scope: evaluatedScope,
      total_violations: newViolations.length,
      violations_count: newViolations.length,
      violations: newViolations,
      ...(preExistingViolations.length > 0 ? { pre_existing_violations: preExistingViolations } : {}),
      impact_summary: impactSummary,
      message:
        Object.keys(config?.domains || {}).length === 0
          ? "Boundary integrity check failed: Domain catalog is currently unindexed. Run septum_map({action:'register', domain:'<name>', root:'<path>'}) to initialize bounded contexts."
          : newViolations.some((v) => v.rule === "unmapped_domain")
          ? "Boundary integrity check failed: File does not belong to any declared bounded context."
          : "Boundary violation detected. Proposed imports violate bounded context architecture.",
    });
  }

  return evaluated({
    status: "approved",
    scope: "file",
    enforcement_mode: enforcementMode,
    file: singleFile,
    evaluated_scope: evaluatedScope,
    total_violations: 0,
    violations: [],
    ...(preExistingViolations.length > 0 ? {
      pre_existing_violations: preExistingViolations,
      pre_existing_violations_count: preExistingViolations.length,
    } : {}),
    impact_summary: impactSummary,
    message:
      preExistingViolations.length > 0
        ? `Approved. Proposed imports do not introduce new boundary violations (${preExistingViolations.length} pre-existing circular dependencies noted in codebase).`
        : Object.keys(config?.domains || {}).length === 0
        ? "No boundary violations detected. [Septum Notice: Domain catalog is currently unindexed. Run septum_map({action:'register', domain:'<name>', root:'<path>'}) to initialize bounded contexts.]"
        : enforcementMode === "warn"
        ? "Approved under 'warn' enforcement (unlisted allowed_dependencies are not blocked; only explicit forbidden_dependencies are rejected)."
        : impact && impact.direct_dependents_count > 0
        ? `No boundary violations detected. Caution: ${impact.direct_dependents_count} dependent file(s) consume this file.`
        : "Proposal approved. Existing file imports were not audited.",
  });
}
