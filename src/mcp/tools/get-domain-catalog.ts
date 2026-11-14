import { buildNavigation, NAVIGATION_SCHEMA } from '../../core/discovery/navigation.ts';
import { getParserCapabilities } from '../../core/parser/language-capabilities.ts';
import { SemanticSliceExtractorRegistry } from '../../core/parser/extractors/registry.ts';
import type { ValidatedSeptumConfig } from '../../core/config/schema.ts';
import type { SeptumRepository } from '../../core/database/repository.ts';
import type { GetDomainCatalogArgs } from '../schemas.ts';
import { getCachedRuntimeVersion, type RuntimeVersionMeta } from '../../utils/version-check.ts';

export type { GetDomainCatalogArgs };

export function buildDomainCatalog(repo: SeptumRepository, _config: ValidatedSeptumConfig, args: GetDomainCatalogArgs,
  workspaceRoot?: string, runtimeVersion: RuntimeVersionMeta = getCachedRuntimeVersion()) {
  const root = workspaceRoot ?? args.workspace_path ?? repo.getMeta('workspace_root') ?? process.cwd();
  const navigation = buildNavigation(repo, args, root);
  if (args.include_evidence && (!args.file_filter || !('files' in navigation) || navigation.files.length !== 1 || navigation.accounting.matching_files !== 1)) {
    throw new Error('include_evidence requires file_filter matching exactly one indexed file.');
  }
  const evidence = args.include_evidence && 'files' in navigation
    ? repo.getImportRelationships(root, navigation.files[0]!.path) : [];
  return { ...navigation,
    ...(args.include_capabilities ? { parser_capabilities: { ...getParserCapabilities(args.detail_level === 'full'), semantic_adapters: SemanticSliceExtractorRegistry.getCapabilities() } } : {}),
    ...(args.include_evidence ? { evidence: evidence.slice(0, 20), evidence_accounting: { total: evidence.length, returned: Math.min(20, evidence.length), omitted: Math.max(0, evidence.length - 20) } } : {}),
    runtime_version: runtimeVersion,
    ...(runtimeVersion.update_available ? { update_notice: `Update available: ${runtimeVersion.latest_version}; ${runtimeVersion.upgrade_command}. Reload after updating.` } : {}),
  };
}

export function handleGetDomainCatalog(repo: SeptumRepository, config: ValidatedSeptumConfig, args: GetDomainCatalogArgs, workspaceRoot?: string) {
  const payload = buildDomainCatalog(repo, config, args, workspaceRoot);
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], metadata: { schema: payload.schema, status: payload.status }, runtime_version: payload.runtime_version };
}

export function buildUnindexedCatalog(root: string, runtimeVersion: RuntimeVersionMeta) {
  return { schema: NAVIGATION_SCHEMA, status: 'NOT_INDEXED', total_domains: 0, runtime_version: runtimeVersion,
    message: `Workspace '${root}' belum diinisialisasi. Register a domain or run septum init.`,
    suggested_action: { tool: 'septum_map', params: { action: 'register', name: 'core', root: 'src', ingest_now: true } },
    next: [{ tool: 'septum_map', args: { action: 'register', name: 'core', root: 'src', ingest_now: true } }],
  };
}
