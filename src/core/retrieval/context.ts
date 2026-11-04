import ts from "typescript";
import { bindContextFile } from "./typescript-references.ts";
import { resolve } from "node:path";
import type { SeptumRepository } from "../database/repository.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { ImportRelationship, SymbolReference } from "../../types/index.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { PARSER_REVISION } from "../parser/language-capabilities.ts";
import { RESOLVER_REVISION } from "../resolver/import-resolver.ts";
import { assertPathContained } from "../resolver/path-resolver.ts";
import { collectSourceSkips, readSourceFile, SOURCE_READ_REVISION } from "../resources/source-files.ts";
import { symbolTargetId } from "./symbol-evidence.ts";

export const CONTEXT_POLICY = "referenced-typescript-declarations/v2";
export const MIN_CONTEXT_BUDGET = 2048;
export const MAX_CONTEXT_BUDGET = 2 * 1024 * 1024;
const MAX_ITEMS = 256;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export interface ContextQuery {
  query?: string;
  symbol?: string;
  symbol_ref?: SymbolReference;
  file_path?: string;
  domain?: string;
  budget_bytes?: number;
  continuation?: string;
}
type SourceItem = {
  kind: "source";
  name: string;
  reason: "target_implementation" | "direct_import_declaration" | "local_dependency";
  source: { file_path: string; indexed_content_hash: string; start_line: number; end_line: number; text: string };
};
type DiagnosticItem = { kind: "diagnostic"; reason: string; file_path?: string; detail?: string };
type ContextItem = SourceItem | DiagnosticItem | { kind: "relationship"; reason: "target_file_import"; relationship: ImportRelationship };

function response(payload: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function budgetedResponse(payload: Record<string, unknown>, budget: number) {
  let bytes = 0;
  for (;;) {
    const result = response({ ...payload, output_bytes: bytes });
    const measured = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes === measured) {
      if (measured > budget) return response({ status: "budget_too_small", minimum_budget_bytes: measured,
        message: "Required response metadata exceeds this budget; retry with a larger budget." });
      return result;
    }
    bytes = measured;
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function digest(value: unknown) { return computeContentHash(JSON.stringify(canonical(value))); }

// Conservative identity until a publication revision covers every writer.
// Compare actual facts, excluding insertion IDs and timestamps.
function indexIdentity(repo: SeptumRepository) {
  const domains = repo.getAllDomains();
  return digest({
    files: repo.getAllFiles().map(file => ({ path: file.path, hash: file.content_hash,
      domain: domains.find(domain => domain.id === file.domain_id)?.name,
      symbols: repo.getSymbolsByFileId(file.id).map(({ id, file_id, ...symbol }) => symbol)
        .sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))),
    })).sort((a, b) => a.path.localeCompare(b.path)),
    domains: domains.map(({ id, created_at, updated_at, ...domain }) => domain).sort((a, b) => a.name.localeCompare(b.name)),
    dependencies: repo.getAllDependenciesWithDomains().sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))),
    state: repo.getMeta("sync_state"), parser: repo.getMeta("parser_revision"),
  });
}

/** Read-only context for a bounded import policy; no complete call graph claim. */
export async function retrieveContext(repo: SeptumRepository, config: ValidatedSeptumConfig, query: ContextQuery, workspaceRoot: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const budget = query.budget_bytes ?? 64 * 1024;
  if (!Number.isInteger(budget) || budget < MIN_CONTEXT_BUDGET || budget > MAX_CONTEXT_BUDGET) {
    return response({ status: "invalid_budget", minimum_budget_bytes: MIN_CONTEXT_BUDGET, maximum_budget_bytes: MAX_CONTEXT_BUDGET });
  }
  const root = resolve(workspaceRoot);
  const name = (query.symbol_ref?.name || query.symbol || query.query || "").trim();
  if (!name) return response({ status: "invalid_query", message: "Choose a target with query, symbol or symbol_ref." });
  const initialIndex = indexIdentity(repo);
  if (query.symbol_ref && repo.getFileByPath(query.symbol_ref.file_path)?.content_hash !== query.symbol_ref.indexed_content_hash) {
    return response({ status: "stale_reference", message: "Locate the target again before retrieving context." });
  }
  const candidates = repo.findSymbolsByName(name, { filePath: query.file_path, reference: query.symbol_ref, domain: query.domain });
  if (candidates.length !== 1) {
    return budgetedResponse({ status: candidates.length ? "ambiguous" : "not_found", policy: CONTEXT_POLICY,
      candidate_count: candidates.length, candidates: candidates.slice(0, 5).map(candidate => candidate.symbol_ref),
      candidates_omitted: Math.max(0, candidates.length - 5), message: "Select one declaration with file_path or symbol_ref; narrow the query if candidates are omitted." }, budget);
  }
  const target = candidates[0]!;
  if (!/\.(?:ts|mts|cts)$/.test(target.file_path)) {
    return response({ status: "unsupported", capability: "TypeScript static imports and indexed declarations", message: "Use locate/inspect/impact for other languages." });
  }
  const queryId = digest({ root, target: target.symbol_ref, policy: CONTEXT_POLICY, domain: query.domain ?? null,
    budget, parser: PARSER_REVISION, resolver: RESOLVER_REVISION, reads: SOURCE_READ_REVISION, config });
  let cursor: { query: string; snapshot: string; offset: number } | undefined;
  if (query.continuation) {
    try {
      cursor = JSON.parse(Buffer.from(query.continuation, "base64url").toString("utf8"));
      if (!cursor || cursor.query !== queryId || typeof cursor.snapshot !== "string" ||
        !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error("invalid");
    } catch { return response({ status: "invalid_continuation", message: "Continuation must match the target, workspace, policy and budget; restart retrieval." }); }
  }
  let freshness: "current" | "stale" | "unavailable" = "current";
  let incomplete = repo.getMeta("sync_state") !== "complete";
  let capacityOmissions = 0;
  let unexpandedFiles = 0;
  let sourceBytes = 0;
  const collected = await collectSourceSkips(root, async () => {
    const items: ContextItem[] = [];
    const add = (item: ContextItem) => {
      if (items.length < MAX_ITEMS) items.push(item);
      else { incomplete = true; capacityOmissions++; }
    };
    const addDiagnostic = (reason: string, file_path?: string, detail?: string) => {
      incomplete = true; add({ kind: "diagnostic", reason, file_path, detail });
    };
    const readIndexed = (path: string): string | undefined => {
      signal?.throwIfAborted();
      try {
        assertPathContained(path, root, "Context source");
        const source = readSourceFile(resolve(root, path));
        sourceBytes += Buffer.byteLength(source, "utf8");
        if (sourceBytes > MAX_SOURCE_BYTES) { addDiagnostic("analysis_source_byte_limit", path); return; }
        if (computeContentHash(source) !== repo.getFileByPath(path)?.content_hash) {
          freshness = "stale"; addDiagnostic("source_differs_from_index", path); return;
        }
        return source;
      } catch {
        if (freshness !== "stale") freshness = "unavailable";
        addDiagnostic("source_unavailable_or_out_of_scope", path);
      }
    };
    const addSource = (path: string, source: string, symbol: { name: string; line_start: number; line_end: number }, reason: SourceItem["reason"]) => {
      const starts = [0]; const ends: number[] = [];
      for (const match of source.matchAll(/\r\n|\n|\r/g)) { ends.push(match.index!); starts.push(match.index! + match[0].length); }
      ends.push(source.length);
      if (symbol.line_start < 1 || symbol.line_end < symbol.line_start || symbol.line_end > starts.length) {
        addDiagnostic("invalid_indexed_span", path); return;
      }
      add({ kind: "source", name: symbol.name, reason, source: { file_path: path,
        indexed_content_hash: repo.getFileByPath(path)!.content_hash, start_line: symbol.line_start, end_line: symbol.line_end,
        text: source.slice(starts[symbol.line_start - 1], ends[symbol.line_end - 1]) } });
    };
    if (incomplete) addDiagnostic("index_not_complete");
    const source = readIndexed(target.file_path);
    if (source === undefined) return items;
    addSource(target.file_path, source, target, "target_implementation");
    const relationships = repo.getImportRelationships(root);
    const visited = new Set<string>();
    const files = new Map<string, { text: string; bound: ReturnType<typeof bindContextFile> }>();
    const load = (path: string) => {
      if (files.has(path)) return files.get(path);
      if (sourceBytes >= MAX_SOURCE_BYTES || files.size >= 64) {
        unexpandedFiles++; addDiagnostic("analysis_file_limit", path); return;
      }
      if (!repo.getFileByPath(path) || !/\.(?:ts|mts|cts)$/.test(path)) {
        addDiagnostic("dependency_not_indexed_or_unsupported", path); return;
      }
      const text = path === target.file_path ? source : readIndexed(path);
      if (text === undefined) return;
      const bound = bindContextFile(path, text);
      const value = { text, bound }; files.set(path, value);
      if (bound.hasErrors) addDiagnostic("typescript_syntax_errors", path);
      if (path === target.file_path) {
        for (const edge of relationships.filter(e => e.source.file === path)) {
          add({ kind: "relationship", reason: "target_file_import", relationship: edge });
          if (edge.freshness !== "current" || (edge.resolution.status !== "resolved" && edge.resolution.status !== "external") || edge.resolution.coverage === "conditional")
            addDiagnostic("import_not_fully_resolved", path, `${edge.resolution.source.target}: ${edge.resolution.reason}`);
        }
      }
      // Initializers and decorators can execute independently of references.
      // Retain relationships and explicitly decline module-execution closure.
      if (bound.source.statements.some(node => ts.isImportDeclaration(node) && !node.importClause))
        addDiagnostic("side_effect_import_not_expanded", path);
      const hasExecution = (node: ts.Node): boolean => {
        if (ts.isFunctionLike(node)) return false;
        if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)) return true;
        return ts.forEachChild(node, child => hasExecution(child) || undefined) ?? false;
      };
      if (bound.source.statements.some(node => ts.isExpressionStatement(node) || ts.isExportDeclaration(node) || ts.isClassDeclaration(node) ||
        (ts.isVariableStatement(node) && hasExecution(node))))
        addDiagnostic("module_execution_or_reexport_not_expanded", path);
      return value;
    };
    const isTypeOnlyImportBinding = (declaration: ts.ImportDeclaration, exportedName: string): boolean => {
      if (declaration.importClause?.isTypeOnly) return true;
      const bindings = declaration.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        const matching = bindings.elements.filter(el => (el.propertyName ?? el.name).text === exportedName);
        if (matching.length > 0 && matching.every(el => el.isTypeOnly)) return true;
      }
      return false;
    };
    type QueuedNode = { path: string; node: ts.Node; depth: number; reason: SourceItem["reason"]; typeOnlyClass: boolean };
    const expansionQueue: QueuedNode[] = [];
    const enqueueNode = (path: string, node: ts.Node, depth: number, reason: SourceItem["reason"], typeOnlyClass = false) => {
      const key = `${path}:${node.pos}:${node.end}`;
      if (visited.has(key)) return;
      visited.add(key);
      if (items.length >= MAX_ITEMS) { capacityOmissions++; incomplete = true; return; }
      const file = load(path);
      if (!file) return;
      if (reason !== "target_implementation") {
        const start = file.bound.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const end = file.bound.source.getLineAndCharacterOfPosition(node.end).line + 1;
        const indexed = repo.getSymbolsByFileId(repo.getFileByPath(path)!.id).find(s => s.line_start >= start && s.line_end <= end);
        const name = indexed?.name ?? ("name" in node ? (node as ts.NamedDeclaration).name?.getText(file.bound.source) : undefined) ?? "local_declaration";
        addSource(path, file.text, { name, line_start: start, line_end: end }, reason);
      }
      expansionQueue.push({ path, node, depth, reason, typeOnlyClass });
    };
    const expandReferences = async (entry: QueuedNode) => {
      signal?.throwIfAborted();
      const file = load(entry.path);
      if (!file) return;
      const refs = file.bound.references(entry.node);
      for (const local of refs.locals) {
        if (entry.depth === 0) {
          // For the target file (depth 0), emit and expand local helpers immediately before cross-file imports
          const prevLen = expansionQueue.length;
          enqueueNode(entry.path, local, 0, "local_dependency", entry.typeOnlyClass);
          while (expansionQueue.length > prevLen) {
            const localEntry = expansionQueue.pop()!;
            await expandReferences(localEntry);
          }
        } else {
          enqueueNode(entry.path, local, entry.depth, "local_dependency", entry.typeOnlyClass);
        }
      }
      const deferredTypeOnlyClassImports: Array<{ dependencyPath: string; effectiveNames: string[]; depth: number }> = [];
      for (const [declaration, names] of refs.imports) {
        const sortedNames = [...names].sort();
        const typeOnlyByName = new Map<string, boolean>();
        for (const n of sortedNames) typeOnlyByName.set(n, isTypeOnlyImportBinding(declaration, n));
        if (entry.typeOnlyClass && sortedNames.every(n => !typeOnlyByName.get(n))) {
          unexpandedFiles++; addDiagnostic("type_only_class_runtime_import_not_expanded", entry.path, declaration.getText()); continue;
        }
        const effectiveNames = entry.typeOnlyClass ? sortedNames.filter(n => typeOnlyByName.get(n)) : sortedNames;
        const line = file.bound.source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
        const moduleName = ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : undefined;
        const edge = relationships.find(e => e.source.file === entry.path && e.source.line === line &&
          e.resolution.source.target === moduleName);
        if (!edge || edge.freshness !== "current" || edge.resolution.status !== "resolved" || edge.resolution.coverage === "conditional") {
          addDiagnostic("referenced_import_not_expanded", entry.path, declaration.getText()); continue;
        }
        const paths = [...new Set(edge.resolution.targets.flatMap(t => t.files))];
        if (entry.depth >= 3 || paths.length !== 1 || names.has("*")) {
          unexpandedFiles++; addDiagnostic("dependency_depth_or_binding_limit", entry.path, declaration.getText()); continue;
        }
        const dependencyPath = paths[0]!;
        const depFileRecord = repo.getFileByPath(dependencyPath);
        const depSymbols = depFileRecord ? repo.getSymbolsByFileId(depFileRecord.id) : [];
        const isAllTypeOnlyClass = effectiveNames.length > 0 && effectiveNames.every(
          n => Boolean(typeOnlyByName.get(n)) && depSymbols.some(s => s.name === n && s.kind === "class")
        );
        if (isAllTypeOnlyClass) {
          deferredTypeOnlyClassImports.push({ dependencyPath, effectiveNames, depth: entry.depth + 1 });
          continue;
        }
        const dependency = load(dependencyPath);
        if (!dependency) continue;
        for (const name of effectiveNames) {
          const selected = dependency.bound.exported(name);
          if (!selected) { addDiagnostic("export_binding_not_resolved", dependencyPath, name); continue; }
          const nextTypeOnlyClass = Boolean(typeOnlyByName.get(name)) && ts.isClassDeclaration(selected);
          enqueueNode(dependencyPath, selected, entry.depth + 1, "direct_import_declaration", nextTypeOnlyClass);
        }
      }
      for (const deferred of deferredTypeOnlyClassImports) {
        const dependency = load(deferred.dependencyPath);
        if (!dependency) continue;
        for (const name of deferred.effectiveNames) {
          const selected = dependency.bound.exported(name);
          if (!selected) { addDiagnostic("export_binding_not_resolved", deferred.dependencyPath, name); continue; }
          enqueueNode(deferred.dependencyPath, selected, deferred.depth, "direct_import_declaration", ts.isClassDeclaration(selected));
        }
      }
      if (visited.size % 8 === 0) await new Promise<void>(done => setTimeout(done, 0));
    };
    const targetFile = load(target.file_path);
    const declaration = targetFile?.bound.declaration(target.line_start, target.line_end);
    if (declaration) {
      if (targetFile!.bound.source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1 !== target.line_start ||
          targetFile!.bound.source.getLineAndCharacterOfPosition(declaration.end).line + 1 !== target.line_end)
        addDiagnostic("enclosing_declaration_reference_scope", target.file_path);
      enqueueNode(target.file_path, declaration, 0, "target_implementation");
      while (expansionQueue.length > 0) {
        await expandReferences(expansionQueue.shift()!);
      }
    }
    else addDiagnostic("target_ast_declaration_not_found", target.file_path);
    return items;
  });
  signal?.throwIfAborted();
  if (indexIdentity(repo) !== initialIndex) return response({ status: "index_changed", message: "Index changed during context analysis; retry retrieval." });
  // Negative resolution can change when an unindexed file appears. Observed file
  // reads alone cannot capture that; bind the resolved selection and diagnostics too.
  const snapshot = digest({ index: initialIndex, inputs: collected.inputs.map(({ path, hash }) => ({ path, hash })), observations: collected.observations, selection: collected.value });
  if (cursor && (cursor.snapshot !== snapshot || cursor.offset >= collected.value.length)) {
    return response({ status: "stale_continuation", message: "Input/index identity changed or the page is invalid; restart retrieval." });
  }
  const start = cursor?.offset ?? 0;
  const all = collected.value;
  const envelope = (items: ContextItem[], end: number) => ({
    status: incomplete || end < all.length || start > 0 ? "partial" : "success", policy: CONTEXT_POLICY, workspace: root, target: target.symbol_ref,
    target_id: symbolTargetId(root, target.symbol_ref),
    query_id: queryId, snapshot_id: snapshot, freshness,
    freshness_scope: "returned source hashes checked against index during response preparation",
    completeness: incomplete || end < all.length || start > 0 ? "partial" : "complete",
    completeness_scope: "target and bound local/referenced declarations in directly imported TypeScript files and up to three import edges",
    capability_limits: "Static references, not calls or runtime execution. Namespace imports, reexports and module execution may need further context. Dynamic/runtime dependencies and business requirements are not covered. Identity covers observed reads and resolver probes; filesystem is not an atomic snapshot.",
    task_sufficiency: "unknown",
    parser_revision: PARSER_REVISION, resolver_revision: RESOLVER_REVISION,
    input_count: collected.inputs.length, selected_source_bytes_read: sourceBytes,
    observed_path_count: collected.observations.paths.length, observed_directory_count: collected.observations.directories.length,
    resolution_scope: "workspace relationships; selection follows bound references", dependency_depth: 3, items,
    accounting: { total: all.length, returned: items.length, offset: start, omitted_before: start,
      omitted_after: all.length - end, omitted_by_capacity: capacityOmissions, unexpanded_dependency_files: unexpandedFiles },
    ...(end < all.length && end > start ? { continuation: Buffer.from(JSON.stringify({ query: queryId, snapshot, offset: end })).toString("base64url") } : {}),
    budget_bytes: budget, budget_unit: "UTF-8 bytes of serialized MCP tool result",
  });
  let end = start;
  let result = budgetedResponse(envelope([], start), budget);
  for (; end < all.length; end++) {
    const next = budgetedResponse(envelope(all.slice(start, end + 1), end + 1), budget);
    if (JSON.parse(next.content[0]!.text).status === "budget_too_small") break;
    result = next;
  }
  if (end === start && all.length > start) {
    return budgetedResponse({ ...envelope([], start), status: "item_exceeds_budget", completeness: "partial",
      message: "The next whole declaration or diagnostic does not fit; retry with a larger budget or use inspect with bounded source lines. No source was silently cut." }, budget);
  }
  return result;
}
