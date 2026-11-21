/**
 * Token-efficient text formatters for all 4 Septum MCP tools (default format='text' in v0.4.0).
 * Preserves all architectural signals, freshness/coverage limits, and next-step hints
 * while eliminating repetitive JSON punctuation and field keys.
 */

export function formatMapAsText(payload: Record<string, any>): string {
  if (payload.status === "not_found" || payload.status === "NOT_INDEXED") {
    const lines = [`[${String(payload.status).toUpperCase()}] ${payload.message ?? "No navigation results."}`];
    if (Array.isArray(payload.available_domains) && payload.available_domains.length) {
      lines.push(`Domains: ${payload.available_domains.join(", ")}`);
    }
    return lines.join("\n");
  }

  const scope = payload.scope ?? {};
  const headerScope = scope.file_filter
    ? `${scope.domain ?? "workspace"} (${scope.file_filter})`
    : scope.domain ?? "workspace";
  const health = payload.health ?? {};
  const acc = payload.accounting ?? {};
  const lines: string[] = [
    `# Septum Map: ${headerScope} [${payload.status}]`,
    `Health: index=${health.index ?? "unknown"} coverage=${health.coverage ?? "unknown"} sync_needed=${Boolean(health.sync_needed)} unresolved=${health.unresolved_imports ?? 0}`,
  ];

  if (Array.isArray(payload.domains) && payload.domains.length) {
    lines.push("", "## Domains");
    for (const d of payload.domains) {
      const allowed = Array.isArray(d.allowed_dependencies) && d.allowed_dependencies.length ? d.allowed_dependencies.join(",") : "-";
      const forbidden = Array.isArray(d.forbidden_dependencies) && d.forbidden_dependencies.length ? ` forbidden:[${d.forbidden_dependencies.join(",")}]` : "";
      lines.push(`- ${d.name} (${d.root}, ${d.file_count} files) allowed:[${allowed}]${forbidden}`);
    }
  }

  if (Array.isArray(payload.submodules) && payload.submodules.length) {
    lines.push("", "## Submodules (zoom in via file_filter)");
    for (const sub of payload.submodules) {
      const anchors = Array.isArray(sub.top_anchors) && sub.top_anchors.length ? ` anchors: ${sub.top_anchors.join(", ")}` : "";
      lines.push(`- ${sub.path} (${sub.file_count} files)${anchors}`);
    }
  }

  if (Array.isArray(payload.files) && payload.files.length) {
    const omitted = acc.omitted_files ? ` (+${acc.omitted_files} omitted)` : "";
    lines.push("", `## Files (${payload.files.length}/${acc.matching_files ?? payload.files.length}${omitted})`);
    for (const f of payload.files) {
      const anchor = f.anchor ? ` anchor:${f.anchor}` : "";
      lines.push(`- ${f.path} [${f.archetype}] (${f.symbol_count} syms${anchor})`);
    }
  }

  if (Array.isArray(payload.dependencies) && payload.dependencies.length) {
    const isAggregated = Array.isArray(payload.submodules) && payload.submodules.length > 0;
    const omitted = !isAggregated && acc.omitted_dependencies ? ` (+${acc.omitted_dependencies} omitted)` : "";
    const depTitle = isAggregated
      ? `## Dependencies (aggregated by submodule, ${payload.dependencies.length} groups)`
      : `## Dependencies (${payload.dependencies.length}/${acc.total_dependencies ?? payload.dependencies.length}${omitted})`;
    lines.push("", depTitle);
    for (const dep of payload.dependencies) {
      const count = dep.count > 1 ? ` x${dep.count}` : "";
      lines.push(`- ${dep.from} -> ${dep.to}${count}`);
    }
  }

  if (Array.isArray(payload.entrypoints) && payload.entrypoints.length) {
    lines.push("", `## Entrypoints (${payload.entrypoints.length})`);
    for (const ep of payload.entrypoints) {
      lines.push(`- ${ep.method} ${ep.target} -> ${ep.handler} (${ep.file ?? "unknown"})`);
    }
  }

  if (Array.isArray(payload.evidence) && payload.evidence.length) {
    lines.push("", `## Import Evidence (${payload.evidence.length})`);
    for (const ev of payload.evidence) {
      const targets = ev.resolution?.targets?.flatMap((t: any) => t.files ?? []).join(", ") || ev.resolution?.reason || "unresolved";
      lines.push(`- L${ev.source?.line ?? "?"}: ${ev.resolution?.source?.target ?? "?"} => ${ev.resolution?.status ?? "?"} (${targets})`);
    }
  }

  if (Array.isArray(payload.next) && payload.next.length) {
    lines.push("", "## Next");
    for (const n of payload.next) {
      lines.push(`- ${n.tool}(${JSON.stringify(n.args)})`);
    }
  }

  if (payload.relationship_limits) {
    lines.push("", `Limits: ${payload.relationship_limits}`);
  }
  return lines.join("\n");
}

export function formatSliceAsText(payload: Record<string, any>): string {
  const ep = payload.entrypoint;
  const lines: string[] = [
    `# Septum Slice: ${payload.query} [${payload.status}]`,
    `Match: found=${Boolean(payload.found)} exact=${Boolean(payload.is_exact_match)} confidence=${payload.confidence ?? "none"} style=${payload.architecture_style ?? "unknown"} depth=${payload.max_depth_applied ?? "?"}`,
  ];

  if (ep) {
    lines.push(`Entrypoint: ${ep.method} ${ep.uri} -> ${ep.controller}@${ep.action} (${ep.file ?? "?"}:${ep.line ?? "?"})`);
  }

  if (Array.isArray(payload.diagnostics) && payload.diagnostics.length) {
    lines.push(`Diagnostics: ${payload.diagnostics.join(", ")}`);
  }

  if (Array.isArray(payload.chain) && payload.chain.length) {
    lines.push("", `## Chain (${payload.chain.length} nodes)`);
    for (const node of payload.chain) {
      const indent = typeof node.depth === "number" && node.depth > 0 ? "  ".repeat(Math.min(node.depth, 6)) : "";
      const loc = node.file ? ` @ ${node.file}:${node.line ?? 1}` : "";
      const rel = node.relationship ? ` [${node.relationship.kind}; ${node.relationship.reason}]` : "";
      const via = node.parent_symbol ? ` (via ${node.parent_symbol})` : "";
      lines.push(`${indent}- [${String(node.stage).toUpperCase()}] ${node.symbol}${loc}${rel}${via}`);
    }
  } else if (payload.summary) {
    lines.push("", payload.summary);
  }

  if (Array.isArray(payload.alternatives) && payload.alternatives.length) {
    lines.push("", "## Alternatives");
    for (const alt of payload.alternatives.slice(0, 5)) {
      lines.push(`- ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}${alt.file ? ` (${alt.file})` : ""}`);
    }
  }

  if (Array.isArray(payload.next) && payload.next.length) {
    lines.push("", "## Next");
    for (const n of payload.next) {
      lines.push(`- ${typeof n === "string" ? n : JSON.stringify(n)}`);
    }
  }

  if (payload.relationship_limits) {
    lines.push("", `Limits: ${payload.relationship_limits}`);
  }
  return lines.join("\n");
}

export function formatLocateAsText(payload: Record<string, any>): string {
  const status = payload.status ?? (payload.found ? "success" : "not_found");
  const freshness = payload.retrieval?.freshness ?? "unknown";
  const lines: string[] = [`# Septum Locate: ${payload.query ?? payload.file_path ?? "?"} [${status}]`];

  if (status === "NOT_INDEXED" || status === "stale_reference") {
    lines.push(payload.message ?? "Workspace not indexed or reference stale.");
    return lines.join("\n");
  }

  // File outline mode (query="*" with file_path)
  if (Array.isArray(payload.candidates) && payload.file_path && !payload.exact_symbol && status === "success") {
    const omitted = payload.omitted_candidates ? ` (+${payload.omitted_candidates} omitted)` : "";
    lines.push(`File: ${payload.file_path} (${payload.candidates.length}/${payload.total_candidates ?? payload.candidates.length} declarations${omitted}) freshness=${freshness}`, "");
    for (const c of payload.candidates) {
      lines.push(`- L${c.start_line}-${c.end_line} [${c.kind}] ${c.name}${c.signature ? `: ${String(c.signature).replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
    }
    return lines.join("\n");
  }

  // Ambiguous candidates
  if (status === "ambiguous" && Array.isArray(payload.candidates)) {
    lines.push(payload.message ?? "Multiple matching declarations.", "");
    for (const c of payload.candidates) {
      const ref = c.symbol_ref;
      const span = ref ? `:${ref.start_line}-${ref.end_line}` : "";
      lines.push(`- ${c.name} @ ${c.file_path}${span}${c.signature ? ` — ${String(c.signature).replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
    }
    return lines.join("\n");
  }

  // Exact match
  if (payload.found && payload.exact_symbol) {
    const sym = payload.exact_symbol;
    const ref = payload.symbol_ref;
    const sig = ref?.signature ?? sym.signature;
    lines.push(`Target: ${sym.name} [${sym.kind}, ${sym.visibility ?? "public"}] @ ${payload.file_path}:${sym.start_line ?? sym.line_start}-${sym.end_line ?? sym.line_end} (${sym.total_lines ?? "?"} lines) freshness=${freshness}`);
    if (sig) lines.push(`Signature: ${String(sig).replace(/\s+/g, " ")}`);
    if (payload.complexity_smell?.warning) lines.push(`Warning: ${payload.complexity_smell.warning}`);
    if (Array.isArray(payload.sibling_methods) && payload.sibling_methods.length) {
      lines.push(`Siblings (${payload.sibling_methods.length}): ${payload.sibling_methods.slice(0, 15).join(", ")}${payload.sibling_methods.length > 15 ? ", ..." : ""}`);
    }
    return lines.join("\n");
  }

  // Not found + suggestions
  lines.push(payload.message ?? `Symbol '${payload.query}' not found.`);
  if (Array.isArray(payload.suggestions) && payload.suggestions.length) {
    lines.push("", "## Suggestions");
    for (const s of payload.suggestions) {
      lines.push(`- ${s.name} [${s.kind}] (${s.similarity_score}) @ ${s.file_path ?? "?"}:${s.start_line ?? s.line_start}`);
    }
  }
  return lines.join("\n");
}

export function formatSourceContextAsText(payload: Record<string, any>): string {
  if (!payload.symbol && payload.status) {
    return `# Septum Symbol Context [${payload.status}]\n${payload.message ?? "Unable to inspect symbol."}`;
  }
  const range = payload.exact_range ?? {};
  const freshness = payload.retrieval?.freshness ?? "unknown";
  const lines: string[] = [
    `# Septum Symbol: ${payload.symbol} [${payload.kind ?? "symbol"}] @ ${payload.file_path}:${range.start_line ?? "?"}-${range.end_line ?? "?"} (${range.total_lines ?? "?"}L)`,
    `Domain: ${payload.domain ?? "unknown"} | Visibility: ${payload.visibility ?? "unknown"} | Freshness: ${freshness} | Mode: source`,
  ];
  if (payload.signature) lines.push(`Signature: ${String(payload.signature).replace(/\s+/g, " ")}`);
  if (Array.isArray(payload.dependencies_injected) && payload.dependencies_injected.length) {
    lines.push(`Injected/Params: ${payload.dependencies_injected.join(", ")}`);
  }
  if (Array.isArray(payload.resolved_outbound_calls) && payload.resolved_outbound_calls.length) {
    lines.push("", `## Outbound Calls (${payload.resolved_outbound_calls.length})`);
    for (const c of payload.resolved_outbound_calls) {
      const target = c.target_file
        ? ` -> ${c.target_file}:${c.target_range?.start_line ?? "?"}-${c.target_range?.end_line ?? "?"}`
        : " (unresolved)";
      lines.push(`- ${c.symbol}${target}`);
    }
  } else if (Array.isArray(payload.outbound_calls) && payload.outbound_calls.length) {
    lines.push(`Outbound Calls: ${payload.outbound_calls.join(", ")}`);
  }
  if (payload.connected_files) {
    const cf = payload.connected_files;
    if (Array.isArray(cf.imports_from) && cf.imports_from.length) {
      lines.push("", `Imports (${cf.imports_from.length}): ${cf.imports_from.join(", ")}`);
    }
    if (Array.isArray(cf.imported_by) && cf.imported_by.length) {
      lines.push(`Imported by (${cf.imported_by_count ?? cf.imported_by.length}): ${cf.imported_by.join(", ")}`);
    }
  }
  if (typeof payload.source_code === "string") {
    const slice = payload.source_slice;
    const sliceNote = slice ? ` (L${slice.start_line}-${slice.end_line}${slice.truncated ? `, next_start_line=${slice.next_start_line}` : ""})` : "";
    lines.push("", `## Source${sliceNote}`, "```", payload.source_code, "```");
  }
  return lines.join("\n");
}

export function formatDeepContextAsText(payload: Record<string, any>): string {
  if (!Array.isArray(payload.items)) {
    const lines = [`# Septum Deep Context [${payload.status ?? "error"}]`];
    if (payload.message) lines.push(payload.message);
    if (Array.isArray(payload.candidates) && payload.candidates.length) {
      lines.push("", "## Candidates");
      for (const c of payload.candidates) {
        lines.push(`- ${c.name} [${c.kind}] @ ${c.file_path}:${c.start_line}-${c.end_line}`);
      }
    }
    return lines.join("\n");
  }

  const t = payload.target ?? {};
  const acc = payload.accounting ?? {};
  const lines: string[] = [
    `# Septum Deep Context: ${t.name ?? "?"} @ ${t.file_path ?? "?"}:${t.start_line ?? "?"}-${t.end_line ?? "?"} [${payload.status}]`,
    `Freshness: ${payload.freshness ?? "unknown"} | Depth: ${payload.dependency_depth ?? "?"} | Items: ${acc.returned ?? payload.items.length}/${acc.total ?? payload.items.length} (+${acc.omitted_after ?? 0} after) | Bytes: ${payload.output_bytes ?? "?"}/${payload.budget_bytes ?? "?"}`,
  ];

  const diagnostics: string[] = [];
  for (const item of payload.items) {
    if (item.kind === "source" && item.source) {
      const s = item.source;
      const frag = item.fragment ? ` [fragment ${item.fragment.start_utf16}..${item.fragment.end_utf16}/${item.fragment.total_utf16}]` : "";
      lines.push(
        "",
        `## [hop=${item.depth ?? 0}] ${item.name} @ ${s.file_path}:${s.start_line}-${s.end_line} (${item.reason}${frag})`,
        "```ts",
        s.text,
        "```"
      );
    } else if (item.kind === "type_contract") {
      lines.push(
        "",
        `## [hop=${item.depth ?? 1}] ${item.name} @ ${item.file_path}:${item.start_line}-${item.end_line} (type_contract)`,
        "```ts",
        item.text,
        "```"
      );
    } else if (item.kind === "diagnostic") {
      diagnostics.push(`${item.reason}${item.file_path ? ` (${item.file_path})` : ""}${item.detail ? `: ${item.detail}` : ""}`);
    }
  }

  if (diagnostics.length) {
    lines.push("", "## Diagnostics");
    for (const d of diagnostics.slice(0, 10)) lines.push(`- ${d}`);
  }
  if (payload.continuation) {
    lines.push("", `Continuation: ${payload.continuation}`);
  }
  lines.push("", `Limits: ${payload.capability_limits ?? "static references, not calls"}; ${payload.completeness_scope ?? ""}`);
  return lines.join("\n");
}

export function formatImpactAsText(payload: Record<string, any>): string {
  if (payload.status === "ambiguous" || payload.status === "stale_reference") {
    const lines = [`# Septum Impact: ${payload.target_symbol ?? "?"} [${payload.status}]`, payload.message ?? ""];
    if (Array.isArray(payload.candidates)) {
      for (const c of payload.candidates) lines.push(`- ${c.name} @ ${c.file_path}`);
    }
    return lines.join("\n");
  }

  const ref = payload.symbol_ref;
  const loc = ref ? ` @ ${ref.file_path}:${ref.start_line}-${ref.end_line}` : "";
  const sum = payload.impact_summary ?? {};
  const freshness = payload.retrieval?.freshness ?? "unknown";
  const callSites = Array.isArray(payload.call_sites) ? payload.call_sites : [];
  const runtimeImports = Array.isArray(payload.runtime_imports) ? payload.runtime_imports : [];
  const typeOnlyImports = Array.isArray(payload.type_only_imports) ? payload.type_only_imports : [];

  const lines: string[] = [
    `# Septum Impact: ${payload.target_symbol ?? "?"}${loc} [risk=${sum.risk_level ?? "unknown"}]`,
    `Files: ${sum.affected_files_count ?? sum.total_dependents ?? 0} | Call sites: ${callSites.length} | Runtime imports: ${runtimeImports.length} | Type-only imports: ${typeOnlyImports.length} | Freshness: ${freshness}`,
  ];

  if (!payload.found_in_index) {
    if (payload.warning) lines.push(`Warning: ${payload.warning}`);
    if (Array.isArray(payload.suggestions) && payload.suggestions.length) {
      lines.push(`Suggestions: ${payload.suggestions.join(", ")}`);
    }
    return lines.join("\n");
  }

  if (callSites.length) {
    lines.push("", `## Call Sites (${callSites.length})`);
    for (const c of callSites) {
      lines.push(`- ${c.file}:${c.line} ${c.caller} [${c.kind ?? "call"}${c.domain ? `, ${c.domain}` : ""}]`);
    }
  }

  if (runtimeImports.length) {
    lines.push("", `## Runtime Imports (${runtimeImports.length})`);
    for (const r of runtimeImports) {
      lines.push(`- ${r.file}:${r.line}${r.domain ? ` [${r.domain}]` : ""}`);
    }
  }

  if (typeOnlyImports.length) {
    lines.push("", `## Type-Only Imports (${typeOnlyImports.length})`);
    for (const t of typeOnlyImports) {
      lines.push(`- ${t.file}:${t.line}${t.domain ? ` [${t.domain}]` : ""}`);
    }
  }

  if (Array.isArray(payload.resolution_warnings) && payload.resolution_warnings.length) {
    lines.push("", `## Resolution Warnings (${payload.resolution_warnings.length})`);
    for (const w of payload.resolution_warnings.slice(0, 10)) {
      lines.push(`- ${w.source?.file ?? "?"}:${w.source?.line ?? "?"} (${w.resolution?.reason ?? "unresolved"})`);
    }
  }

  lines.push("", `Limits: ${payload.relationship_limits ?? "Incomplete static consumer evidence."}`);
  return lines.join("\n");
}

export function formatBoundaryAsText(payload: Record<string, any>): string {
  const scope = payload.scope ?? "file";
  const target = payload.file ? ` (${payload.file})` : payload.domain ? ` (${payload.domain})` : "";
  const mode = payload.enforcement_mode ? ` enforcement=${payload.enforcement_mode}` : "";
  const lines: string[] = [
    `# Septum Boundary: ${scope}${target} [${payload.status}]${mode}`,
  ];

  if (payload.message) lines.push(payload.message);

  if (payload.total_domains_checked !== undefined) {
    lines.push(`Checked: ${payload.total_domains_checked} domains | Violations: ${payload.total_violations ?? 0} | Warnings: ${payload.total_warnings ?? 0} | Circular: ${payload.circular_dependencies_count ?? 0}`);
  } else if (payload.violations_count !== undefined || payload.total_violations !== undefined) {
    lines.push(`Violations: ${payload.total_violations ?? payload.violations_count ?? 0}`);
  }

  if (Array.isArray(payload.violations) && payload.violations.length) {
    lines.push("", `## Violations (${payload.violations.length})`);
    for (const v of payload.violations) {
      lines.push(`- [${v.rule}] ${v.file}:${v.line ?? 1} (${v.source_domain} -> ${v.target_domain}): ${v.message}`);
    }
  }

  if (Array.isArray(payload.warnings) && payload.warnings.length) {
    lines.push("", `## Warnings (${payload.warnings.length})`);
    for (const w of payload.warnings) {
      lines.push(`- [${w.rule}] ${w.file}:${w.line ?? 1} (${w.source_domain} -> ${w.target_domain}): ${w.message}`);
    }
  }

  if (Array.isArray(payload.circular_dependencies) && payload.circular_dependencies.length) {
    lines.push("", `## Circular Dependencies (${payload.circular_dependencies.length})`);
    for (const c of payload.circular_dependencies) {
      lines.push(`- ${typeof c === "string" ? c : JSON.stringify(c)}`);
    }
  }

  if (payload.impact_summary) {
    const imp = payload.impact_summary;
    lines.push("", `Impact: ${imp.direct_dependents ?? 0} direct dependents, risk=${imp.risk_level ?? "unknown"}${Array.isArray(imp.top_consumers) && imp.top_consumers.length ? ` (${imp.top_consumers.join(", ")})` : ""}`);
  }

  if (Array.isArray(payload.files) && payload.files.length) {
    lines.push("", `## Files (${payload.files.length})`);
    for (const f of payload.files) {
      lines.push(`- ${f.file}: [${f.status}] violations=${f.violations_count ?? f.total_violations ?? 0}`);
    }
  }

  if (Array.isArray(payload.next) && payload.next.length) {
    lines.push("", "## Next");
    for (const n of payload.next) lines.push(`- ${typeof n === "string" ? n : JSON.stringify(n)}`);
  }

  return lines.join("\n");
}
