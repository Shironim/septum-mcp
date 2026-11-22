import type { SeptumRepository } from "../database/repository.ts";
import type { NavigationQuery } from "../../types/index.ts";

export const NAVIGATION_SCHEMA = "navigation/v1";

type NavEdge = { from: string; to: string; relation: "imports"; count: number };
type NavUnresolved = { file: string; target: string; reason: string };

/** Aggregate resolved import edges and collect unresolved/stale import diagnostics. */
function aggregateImportEdges(
  repo: SeptumRepository,
  root: string,
  files: ReturnType<SeptumRepository["getNavigationFiles"]>,
  paths: Set<string>,
  workspace: boolean
) {
  const byPath = new Map(files.map(file => [file.path, file]));
  const degree = new Map<string, number>();
  const edges = new Map<string, NavEdge>();
  const unresolved: NavUnresolved[] = [];

  for (const edge of repo.getImportRelationships(root)) {
    const source = edge.source.file;
    const targets = [...new Set(edge.resolution.targets.flatMap(target => target.files))];
    if (!paths.has(source) && !targets.some(target => paths.has(target))) continue;

    const isIncomplete = edge.freshness !== "current" ||
      !["resolved", "external"].includes(edge.resolution.status) ||
      edge.resolution.coverage === "conditional" ||
      edge.index_coverage === "partial";
    if (isIncomplete) {
      unresolved.push({
        file: source,
        target: edge.resolution.source.target,
        reason: edge.freshness !== "current"
          ? `source_${edge.freshness}`
          : edge.index_coverage === "partial"
            ? "target_not_fully_indexed"
            : edge.resolution.reason,
      });
    }
    if (edge.freshness !== "current" || edge.resolution.status !== "resolved") continue;

    for (const target of targets) {
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
      const from = workspace ? byPath.get(source)?.domain : source;
      const to = workspace ? byPath.get(target)?.domain : target;
      if (!from || !to || (workspace && from === to)) continue;
      const key = JSON.stringify([from, to]);
      const prior = edges.get(key);
      if (prior) prior.count++;
      else edges.set(key, { from, to, relation: "imports", count: 1 });
    }
  }

  return { byPath, degree, edges, unresolved };
}

/** Summarize index health and coverage diagnostics for the selected navigation scope. */
function computeNavigationHealth(
  repo: SeptumRepository,
  domainRoot: string | undefined,
  unresolved: NavUnresolved[]
) {
  const sync = repo.getMeta("sync_state") ?? "unindexed";
  const dirty = repo.getMeta("slices_dirty") === "1";
  const prefix = domainRoot ? domainRoot.replace(/\/$/, "") + "/" : undefined;
  const unsupported = (JSON.parse(repo.getMeta("unsupported_files") || "[]") as string[])
    .filter(path => !prefix || path.startsWith(prefix)).length;
  const skipped = (JSON.parse(repo.getMeta("skipped_files") || "[]") as Array<{ path: string }>)
    .filter(file => !prefix || file.path.startsWith(prefix)).length;

  const reasons = [...new Set([
    ...unresolved.map(item => item.reason),
    ...(unsupported > 0 ? ["unsupported_files"] : []),
    ...(skipped > 0 ? ["skipped_files"] : []),
    ...(dirty ? ["slices_dirty"] : []),
    ...(sync !== "complete" ? [`index_${sync}`] : []),
  ])].sort().slice(0, 10);

  const coverage = sync === "complete" && !dirty && unresolved.length === 0 && unsupported === 0 && skipped === 0
    ? "complete"
    : "partial";

  return {
    sync,
    dirty,
    health: { index: sync, sync_needed: dirty, coverage, unresolved_imports: unresolved.length, unsupported_files: unsupported, skipped_files: skipped, reasons },
  };
}

/** Navigation selects indexed structure; declaration inspection belongs to symbol. */
export function buildNavigation(repo: SeptumRepository, args: NavigationQuery, root: string) {
  const domains = repo.getAllDomains();
  const requested = args.domain ?? args.name;
  const domain = domains.find(d => d.name.toLowerCase() === requested?.toLowerCase());
  if (requested && !domain) return {
    schema: NAVIGATION_SCHEMA, status: "not_found", domain: requested,
    found: false, message: `Domain '${requested}' not found in Septum catalog.`,
    suggestions: domains.map(d => d.name),
    suggested_action: { tool: "septum_map", params: { action: "catalog" } },
    available_domains: domains.map(d => d.name),
    next: [{ tool: "septum_map", args: { action: "catalog" } }],
  };

  const files = repo.getNavigationFiles();
  const domainCounts = new Map<string, number>();
  for (const file of files) domainCounts.set(file.domain, (domainCounts.get(file.domain) ?? 0) + 1);

  const filter = args.file_filter?.replace(/\\/g, "/").toLowerCase();
  const archetype = args.archetype_filter ?? args.archetype;
  const matching = files.filter(file =>
    (!domain || file.domain === domain.name) &&
    (!filter || file.path.toLowerCase().includes(filter)) &&
    (!archetype || file.archetype === archetype)
  );
  const paths = new Set(matching.map(file => file.path));
  const workspace = !domain && !filter && !archetype;

  const { byPath, degree, edges, unresolved } = aggregateImportEdges(repo, root, files, paths, workspace);
  const entries = repo.getNavigationEntrypoints().filter(entry => entry.file && paths.has(entry.file));
  const entryFiles = new Set(entries.map(entry => entry.file));
  matching.sort((a, b) =>
    Number(entryFiles.has(b.path)) - Number(entryFiles.has(a.path)) ||
    (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) ||
    a.path.localeCompare(b.path)
  );

  const compactDomainOnly = Boolean(domain && !filter && !archetype && args.detail_level !== "full");
  const useSubmoduleZoom = Boolean(
    compactDomainOnly &&
    domain &&
    matching.length > 25 &&
    args.file_offset === undefined &&
    args.file_limit === undefined
  );

  const submodules = useSubmoduleZoom && domain ? (() => {
    const rootPrefix = domain.root_path.replace(/\\/g, "/").replace(/\/+$/, "");
    const groups = new Map<string, { path: string; name: string; file_count: number; top_anchors: string[] }>();
    for (const file of matching) {
      const norm = file.path.replace(/\\/g, "/");
      const rel = norm.startsWith(`${rootPrefix}/`) ? norm.slice(rootPrefix.length + 1) : norm;
      const slash = rel.indexOf("/");
      const subName = slash > 0 ? rel.slice(0, slash) : "(root)";
      const subPath = slash > 0 ? `${rootPrefix}/${subName}` : rootPrefix;
      let group = groups.get(subPath);
      if (!group) {
        group = { path: subPath, name: subName, file_count: 0, top_anchors: [] };
        groups.set(subPath, group);
      }
      group.file_count++;
      if (file.anchor && group.top_anchors.length < 3 && !group.top_anchors.includes(file.anchor)) {
        group.top_anchors.push(file.anchor);
      }
    }
    return [...groups.values()].sort((a, b) => b.file_count - a.file_count || a.path.localeCompare(b.path));
  })() : undefined;

  const offset = args.file_offset ?? 0;
  const limit = args.file_limit ?? (useSubmoduleZoom ? 15 : args.detail_level === "full" ? 100 : 40);
  const selected = workspace ? [] : matching.slice(offset, offset + limit);
  const selectedPaths = new Set(selected.map(file => file.path));

  const allEdges = [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const relevantEdges = workspace ? allEdges : allEdges.filter(edge => selectedPaths.has(edge.from) || selectedPaths.has(edge.to));
  const filteredEdges = compactDomainOnly
    ? relevantEdges.filter(edge => byPath.get(edge.from)?.domain !== byPath.get(edge.to)?.domain)
    : relevantEdges;

  // When zooming out on a large domain (>25 files with submodules), aggregate cross-domain edges
  // by submodule/domain instead of emitting dozens of raw file-to-file lines.
  const dependencies = (() => {
    if (useSubmoduleZoom && submodules && submodules.length > 1 && domain) {
      const rootPrefix = domain.root_path.replace(/\\/g, "/").replace(/\/+$/, "");
      const groupLabel = (filePath: string): string => {
        const meta = byPath.get(filePath);
        if (!meta || meta.domain !== domain.name) return meta?.domain ?? filePath;
        const norm = filePath.replace(/\\/g, "/");
        const rel = norm.startsWith(`${rootPrefix}/`) ? norm.slice(rootPrefix.length + 1) : norm;
        const slash = rel.indexOf("/");
        return slash > 0 ? `${rootPrefix}/${rel.slice(0, slash)}` : rootPrefix;
      };
      const grouped = new Map<string, NavEdge>();
      for (const edge of allEdges) {
        const fromDomain = byPath.get(edge.from)?.domain;
        const toDomain = byPath.get(edge.to)?.domain;
        if (fromDomain === toDomain) continue;
        const from = groupLabel(edge.from);
        const to = groupLabel(edge.to);
        if (from === to) continue;
        const key = JSON.stringify([from, to]);
        const prior = grouped.get(key);
        if (prior) prior.count += edge.count;
        else grouped.set(key, { from, to, relation: "imports", count: edge.count });
      }
      return [...grouped.values()]
        .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
        .slice(0, 30);
    }
    return filteredEdges.slice(0, 100);
  })();
  const entrypoints = entries.filter(entry => workspace || selectedPaths.has(entry.file!)).slice(0, 20);
  const { sync, dirty, health } = computeNavigationHealth(repo, domain?.root_path, unresolved);
  const end = offset + selected.length;

  return {
    schema: NAVIGATION_SCHEMA,
    status: requested || filter ? (matching.length ? "success" : domain && !filter ? "empty_domain" : "not_found") : (domains.length ? "success" : "NOT_INDEXED"),
    scope: { level: workspace ? "workspace" : filter ? "file" : "domain", ...(domain ? { domain: domain.name } : {}), ...(filter ? { file_filter: args.file_filter } : {}) },
    domains: (workspace ? domains : domain ? [domain] : []).map(d => ({
      name: d.name,
      root: d.root_path,
      file_count: domainCounts.get(d.name) ?? 0,
      allowed_dependencies: JSON.parse(d.allowed_deps_json || "[]") as string[],
      forbidden_dependencies: JSON.parse(d.forbidden_deps_json || "[]") as string[],
    })),
    ...(submodules && submodules.length > 1 ? { submodules } : {}),
    files: selected,
    dependencies,
    entrypoints: entrypoints.map(entry => ({ ...entry, evidence: "static_catalog", runtime_verified: false })),
    health,
    index_status: { sync_state: sync, sync_needed: dirty },
    accounting: {
      matching_files: matching.length,
      returned_files: selected.length,
      omitted_files: workspace ? 0 : Math.max(0, matching.length - selected.length),
      total_dependencies: allEdges.length,
      returned_dependencies: dependencies.length,
      omitted_dependencies: allEdges.length - dependencies.length,
      total_entrypoints: entries.length,
      omitted_entrypoints: entries.length - entrypoints.length,
    },
    ...(!workspace && end < matching.length ? { pagination: { next_file_offset: end, file_offset: offset } } : {}),
    ...(args.include_evidence ? { diagnostics: unresolved.slice(0, 5), diagnostics_omitted: Math.max(0, unresolved.length - 5) } : {}),
    next: submodules && submodules.length > 1 && domain
      ? [
          { tool: "septum_map", args: { action: "catalog", domain: domain.name, file_filter: submodules[0]!.path } },
          ...(selected[0]?.anchor ? [{ tool: "septum_symbol", args: { action: "locate", query: selected[0].anchor, file_path: selected[0].path } }] : []),
        ]
      : entrypoints[0]
        ? [{ tool: "septum_slice", args: { query: `${entrypoints[0].method} ${entrypoints[0].target}`, controller_file: entrypoints[0].file } }]
        : selected[0]?.anchor
          ? [{ tool: "septum_symbol", args: { action: "locate", query: selected[0].anchor, file_path: selected[0].path } }]
          : [{ tool: "septum_map", args: { action: "catalog", ...(domains[0] ? { domain: domains[0].name } : {}) } }],
    relationship_limits: "Dependencies are static imports; entrypoints are from the static catalog.",
  };
}
