import { registerDomainPolicy } from "../../core/config/domain-registration.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { buildNavigation, NAVIGATION_SCHEMA } from "../../core/discovery/navigation.ts";
import { SemanticSliceExtractorRegistry } from "../../core/parser/extractors/registry.ts";
import { getParserCapabilities } from "../../core/parser/language-capabilities.ts";
import { getCachedRuntimeVersion, type RuntimeVersionMeta } from "../../utils/version-check.ts";
import { formatMapAsText } from "../formatters/compact-text.ts";
import type { GetDomainCatalogArgs, MapToolArgs, RegisterDomainArgs } from "../schemas.ts";

export type { GetDomainCatalogArgs, MapToolArgs, RegisterDomainArgs };

export async function handleMapTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: MapToolArgs,
  workspaceRoot?: string,
  signal?: AbortSignal
) {
  const action = args.action || "catalog";

  switch (action) {
    case "register":
      return await handleRegisterDomain(repo, config, args, workspaceRoot, signal);

    case "catalog":
    default:
      return handleGetDomainCatalog(repo, config, args, workspaceRoot);
  }
}

export function buildDomainCatalog(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetDomainCatalogArgs,
  workspaceRoot?: string,
  runtimeVersion: RuntimeVersionMeta = getCachedRuntimeVersion()
) {
  const root = workspaceRoot ?? args.workspace_path ?? repo.getMeta("workspace_root") ?? process.cwd();
  const navigation = buildNavigation(repo, args, root);
  if (args.include_evidence && (!args.file_filter || !("files" in navigation) || navigation.files.length !== 1 || navigation.accounting.matching_files !== 1)) {
    throw new Error("include_evidence requires file_filter matching exactly one indexed file.");
  }
  const evidence = args.include_evidence && "files" in navigation
    ? repo.getImportRelationships(root, navigation.files[0]!.path) : [];
  return {
    ...navigation,
    ...(args.include_capabilities ? { parser_capabilities: { ...getParserCapabilities(args.detail_level === "full"), semantic_adapters: SemanticSliceExtractorRegistry.getCapabilities() } } : {}),
    ...(args.include_evidence ? { evidence: evidence.slice(0, 20), evidence_accounting: { total: evidence.length, returned: Math.min(20, evidence.length), omitted: Math.max(0, evidence.length - 20) } } : {}),
    runtime_version: runtimeVersion,
    ...(runtimeVersion.update_available ? { update_notice: `Update available: ${runtimeVersion.latest_version}; ${runtimeVersion.upgrade_command}. Reload after updating.` } : {}),
  };
}

export function handleGetDomainCatalog(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetDomainCatalogArgs,
  workspaceRoot?: string
) {
  const payload = buildDomainCatalog(repo, config, args, workspaceRoot);
  const format = args.format ?? "text";
  const text = format === "json" ? JSON.stringify(payload) : formatMapAsText(payload);
  return {
    content: [{ type: "text" as const, text }],
    metadata: { schema: payload.schema, status: payload.status, format },
    runtime_version: payload.runtime_version,
  };
}

export function buildUnindexedCatalog(root: string, runtimeVersion: RuntimeVersionMeta) {
  return {
    schema: NAVIGATION_SCHEMA,
    status: "NOT_INDEXED",
    total_domains: 0,
    runtime_version: runtimeVersion,
    message: `Workspace '${root}' belum diinisialisasi. Register a domain or run septum init.`,
    suggested_action: { tool: "septum_map", params: { action: "register", name: "core", root: "src", ingest_now: true } },
    next: [{ tool: "septum_map", args: { action: "register", name: "core", root: "src", ingest_now: true } }],
  };
}

export async function handleRegisterDomain(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: Partial<RegisterDomainArgs>,
  workspaceRoot: string = process.cwd(),
  signal?: AbortSignal
) {
  const result = await registerDomainPolicy(repo, config, args, workspaceRoot, signal);
  config.domains[result.domain] = result.config;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "success",
            policy_owner: result.policyOwner,
            message: `Domain '${result.domain}' successfully registered in ${
              result.policyOwner === "database" ? "SQLite" : "septum.config.json"
            }.${args.ingest_now ? " Initial ingestion completed." : ""}`,
            domain_id: result.domainId,
            domain: result.domain,
            name: result.domain,
            config: result.config,
            ...(result.conflictPending
              ? {
                  index_status: { sync_state: "error", code: "DOMAIN_ROOT_CONFLICT" },
                  next: [
                    "Resolve any remaining duplicate roots, then sync before using indexed facts. Registration success only records this policy change.",
                  ],
                }
              : {}),
            ...(result.ingestionMetrics ? { ingestion_metrics: result.ingestionMetrics } : {}),
          },
          null,
          2
        ),
      },
    ],
  };
}
