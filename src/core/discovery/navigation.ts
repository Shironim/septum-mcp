import type { SeptumRepository } from "../database/repository.ts";
import type { NavigationQuery } from "../../types/index.ts";

export const NAVIGATION_SCHEMA = "navigation/v1";

/** Navigation selects indexed structure; declaration inspection belongs to symbol. */
export function buildNavigation(repo: SeptumRepository, args: NavigationQuery, root: string) {
  const domains = repo.getAllDomains();
  const requested = args.domain ?? args.name;
  const domain = domains.find(domain => domain.name.toLowerCase() === requested?.toLowerCase());
  if (requested && !domain) return {
    schema: NAVIGATION_SCHEMA, status: "not_found", domain: requested,
    found: false, message: `Domain '${requested}' not found in Septum catalog.`,
    suggestions: domains.map(domain => domain.name),
    suggested_action: { tool: "septum_map", params: { action: "catalog" } },
    available_domains: domains.map(domain => domain.name),
    next: [{ tool: "septum_map", args: { action: "catalog" } }],
  };
  const files = repo.getNavigationFiles();
  const byPath = new Map(files.map(file => [file.path, file]));
  const domainCounts = new Map<string, number>();
  for (const file of files) domainCounts.set(file.domain, (domainCounts.get(file.domain) ?? 0) + 1);
  const filter = args.file_filter?.replace(/\\/g, "/").toLowerCase();
  const matching = files.filter(file => (!domain || file.domain === domain.name) &&
    (!filter || file.path.toLowerCase().includes(filter)) &&
    (!(args.archetype_filter ?? args.archetype) || file.archetype === (args.archetype_filter ?? args.archetype)));
  const paths = new Set(matching.map(file => file.path));
  const relationships = repo.getImportRelationships(root);
  const degree = new Map<string, number>();
  const edges = new Map<string, { from: string; to: string; relation: "imports"; count: number }>();
  const unresolved: Array<{ file: string; target: string; reason: string }> = [];
  const workspace = !domain && !filter && !args.archetype_filter && !args.archetype;
  for (const edge of relationships) {
    const source = edge.source.file;
    const targets = [...new Set(edge.resolution.targets.flatMap(target => target.files))];
    const relevant = paths.has(source) || targets.some(target => paths.has(target));
    if (!relevant) continue;
    if (edge.freshness !== "current" || !["resolved", "external"].includes(edge.resolution.status) || edge.resolution.coverage === "conditional" || edge.index_coverage === "partial") {
      unresolved.push({ file: source, target: edge.resolution.source.target,
        reason: edge.freshness !== "current" ? `source_${edge.freshness}` : edge.index_coverage === "partial" ? "target_not_fully_indexed" : edge.resolution.reason });
    }
    if (edge.freshness !== "current" || edge.resolution.status !== "resolved") continue;
    for (const target of targets) {
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
      const from = workspace ? byPath.get(source)?.domain : source;
      const to = workspace ? byPath.get(target)?.domain : target;
      if (!from || !to || workspace && from === to) continue;
      const key = JSON.stringify([from, to]);
      const prior = edges.get(key);
      if (prior) prior.count++;
      else edges.set(key, { from, to, relation: "imports", count: 1 });
    }
  }
  const entries = repo.getNavigationEntrypoints().filter(entry => entry.file && paths.has(entry.file));
  const entryFiles = new Set(entries.map(entry => entry.file));
  matching.sort((a, b) => Number(entryFiles.has(b.path)) - Number(entryFiles.has(a.path)) ||
    (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || a.path.localeCompare(b.path));
  const offset = args.file_offset ?? 0;
  const limit = args.file_limit ?? (args.detail_level === "full" ? 100 : 40);
  const selected = workspace ? [] : matching.slice(offset, offset + limit);
  const selectedPaths = new Set(selected.map(file => file.path));
  const allEdges = [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const relevantEdges = workspace ? allEdges : allEdges.filter(edge => selectedPaths.has(edge.from) || selectedPaths.has(edge.to));
  const compactDomainOnly = Boolean(domain && !filter && !(args.archetype_filter ?? args.archetype) && args.detail_level !== "full");
  const filteredEdges = compactDomainOnly
    ? relevantEdges.filter(edge => byPath.get(edge.from)?.domain !== byPath.get(edge.to)?.domain)
    : relevantEdges;
  const dependencies = filteredEdges.slice(0, 100);
  const entrypoints = entries.filter(entry => workspace || selectedPaths.has(entry.file!)).slice(0, 20);
  const sync = repo.getMeta("sync_state") ?? "unindexed";
  const dirty = repo.getMeta("slices_dirty") === "1";
  const end = offset + selected.length;
  const diagnostics = {
    unresolved_imports: unresolved.length,
    unsupported_files: (JSON.parse(repo.getMeta("unsupported_files") || "[]") as string[]).filter(path => !domain || path.startsWith(domain.root_path.replace(/\/$/, "") + "/")).length,
    skipped_files: (JSON.parse(repo.getMeta("skipped_files") || "[]") as Array<{ path: string }>).filter(file => !domain || file.path.startsWith(domain.root_path.replace(/\/$/, "") + "/")).length,
  };
  return {
    schema: NAVIGATION_SCHEMA,
    status: requested || filter ? matching.length ? "success" : "not_found" : domains.length ? "success" : "NOT_INDEXED",
    scope: { level: workspace ? "workspace" : filter ? "file" : "domain", ...(domain ? { domain: domain.name } : {}), ...(filter ? { file_filter: args.file_filter } : {}) },
    domains: (workspace ? domains : domain ? [domain] : []).map(domain => ({ name: domain.name, root: domain.root_path,
      file_count: domainCounts.get(domain.name) ?? 0,
      allowed_dependencies: JSON.parse(domain.allowed_deps_json || "[]") as string[],
      forbidden_dependencies: JSON.parse(domain.forbidden_deps_json || "[]") as string[],
    })),
    files: selected,
    dependencies,
    entrypoints: entrypoints.map(entry => ({ ...entry, evidence: "static_catalog", runtime_verified: false })),
    health: { index: sync, sync_needed: dirty, coverage: "partial", ...diagnostics,
      reasons: [...new Set(unresolved.map(item => item.reason))].sort().slice(0, 10) },
    index_status: { sync_state: sync, sync_needed: dirty },
    accounting: { matching_files: matching.length, returned_files: selected.length,
      omitted_files: workspace ? 0 : Math.max(0, matching.length - selected.length),
      total_dependencies: allEdges.length, returned_dependencies: dependencies.length, omitted_dependencies: allEdges.length - dependencies.length,
      total_entrypoints: entries.length, omitted_entrypoints: entries.length - entrypoints.length },
    ...(!workspace && end < matching.length ? { pagination: { next_file_offset: end, file_offset: offset } } : {}),
    ...(args.include_evidence ? { diagnostics: unresolved.slice(0, 5), diagnostics_omitted: Math.max(0, unresolved.length - 5) } : {}),
    next: entrypoints[0] ? [{ tool: "septum_slice", args: { query: `${entrypoints[0].method} ${entrypoints[0].target}`, controller_file: entrypoints[0].file } }]
      : selected[0]?.anchor ? [{ tool: "septum_symbol", args: { action: "locate", query: selected[0].anchor, file_path: selected[0].path } }]
      : [{ tool: "septum_map", args: { action: "catalog", ...(domains[0] ? { domain: domains[0].name } : {}) } }],
    relationship_limits: "Dependencies are imports, not calls or execution order. Entrypoints come from the static catalog and may be inferred. Unindexed targets remain uncertain.",
  };
}
