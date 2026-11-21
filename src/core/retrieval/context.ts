import { pageContext, response, budgetedResponse, type ContextItem, type SourceItem } from "./context-page.ts";
import ts from "typescript";
import { bindContextFile, type ContextValue } from "./typescript-references.ts";
import { resolve } from "node:path";
import type { SeptumRepository } from "../database/repository.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { ImportRelationship, SymbolReference } from "../../types/index.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { PARSER_FINGERPRINT } from "../parser/language-capabilities.ts";
import { RESOLVER_REVISION } from "../resolver/import-resolver.ts";
import { assertPathContained } from "../resolver/path-resolver.ts";
import { collectSourceSkips, readSourceFile, SOURCE_READ_REVISION } from "../resources/source-files.ts";
import { symbolTargetId } from "./symbol-evidence.ts";

export const CONTEXT_POLICY = "referenced-typescript-declarations/v4";
export const MIN_CONTEXT_BUDGET = 2048;
export const MAX_CONTEXT_BUDGET = 2 * 1024 * 1024;
export const DEFAULT_CONTEXT_DEPTH = 2;
export const MAX_CONTEXT_DEPTH = 4;
const MAX_ITEMS = 256;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export interface ContextQuery {
  query?: string;
  symbol?: string;
  symbol_ref?: SymbolReference;
  file_path?: string;
  domain?: string;
  budget_bytes?: number;
  max_depth?: number;
  continuation?: string;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function digest(value: unknown) { return computeContentHash(JSON.stringify(canonical(value))); }

type QueuedNode = { path: string; node: ts.Node; depth: number; hopDepth: number; reason: SourceItem["reason"]; typeOnlyClass: boolean; arguments?: ContextValue[] };
type BoundEntry = { text: string; bound: ReturnType<typeof bindContextFile> };

interface ContextWalkState {
  repo: SeptumRepository;
  root: string;
  maxDepth: number;
  signal?: AbortSignal;
  targetFilePath: string;
  targetSource: string;
  relationships: ImportRelationship[];
  referencedEdges: Set<ImportRelationship>;
  visited: Set<string>;
  emitted: Set<string>;
  directCallItems: WeakSet<ContextItem>;
  variants: Map<string, Set<string>>;
  files: Map<string, BoundEntry>;
  expansionQueue: QueuedNode[];
  items: ContextItem[];
  freshness: "current" | "stale" | "unavailable";
  incomplete: boolean;
  capacityOmissions: number;
  unexpandedFiles: number;
  sourceBytes: number;
}

function addContextItem(state: ContextWalkState, item: ContextItem) {
  if (state.items.length < MAX_ITEMS) state.items.push(item);
  else { state.incomplete = true; state.capacityOmissions++; }
}

function addContextDiagnostic(state: ContextWalkState, reason: string, file_path?: string, detail?: string) {
  state.incomplete = true;
  addContextItem(state, { kind: "diagnostic", reason, file_path, detail });
}

function readIndexedSource(state: ContextWalkState, path: string): string | undefined {
  state.signal?.throwIfAborted();
  try {
    assertPathContained(path, state.root, "Context source");
    const source = readSourceFile(resolve(state.root, path));
    state.sourceBytes += Buffer.byteLength(source, "utf8");
    if (state.sourceBytes > MAX_SOURCE_BYTES) { addContextDiagnostic(state, "analysis_source_byte_limit", path); return; }
    if (computeContentHash(source) !== state.repo.getFileByPath(path)?.content_hash) {
      state.freshness = "stale";
      addContextDiagnostic(state, "source_differs_from_index", path);
      return;
    }
    return source;
  } catch {
    if (state.freshness !== "stale") state.freshness = "unavailable";
    addContextDiagnostic(state, "source_unavailable_or_out_of_scope", path);
  }
}

function addSymbolSourceItem(
  state: ContextWalkState,
  path: string,
  source: string,
  symbol: { name: string; line_start: number; line_end: number },
  reason: SourceItem["reason"],
  depth = 0
) {
  const starts = [0];
  const ends: number[] = [];
  for (const match of source.matchAll(/\r\n|\n|\r/g)) { ends.push(match.index!); starts.push(match.index! + match[0].length); }
  ends.push(source.length);
  if (symbol.line_start < 1 || symbol.line_end < symbol.line_start || symbol.line_end > starts.length) {
    addContextDiagnostic(state, "invalid_indexed_span", path);
    return;
  }
  addContextItem(state, {
    kind: "source",
    depth,
    name: symbol.name,
    reason,
    source: {
      file_path: path,
      indexed_content_hash: state.repo.getFileByPath(path)!.content_hash,
      start_line: symbol.line_start,
      end_line: symbol.line_end,
      text: source.slice(starts[symbol.line_start - 1], ends[symbol.line_end - 1]),
    },
  });
}

function hasModuleExecution(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)) return true;
  return ts.forEachChild(node, child => hasModuleExecution(child) || undefined) ?? false;
}

function loadBoundTsFile(state: ContextWalkState, path: string): BoundEntry | undefined {
  if (state.files.has(path)) return state.files.get(path);
  if (state.sourceBytes >= MAX_SOURCE_BYTES || state.files.size >= 64) {
    state.unexpandedFiles++;
    addContextDiagnostic(state, "analysis_file_limit", path);
    return;
  }
  if (!state.repo.getFileByPath(path) || !/\.(?:ts|mts|cts|tsx)$/.test(path)) {
    addContextDiagnostic(state, "dependency_not_indexed_or_unsupported", path);
    return;
  }
  const text = path === state.targetFilePath ? state.targetSource : readIndexedSource(state, path);
  if (text === undefined) return;
  const bound = bindContextFile(path, text);
  const value = { text, bound };
  state.files.set(path, value);
  if (bound.hasErrors) addContextDiagnostic(state, "typescript_syntax_errors", path);
  // Initializers and decorators can execute independently of references; retain relationships and decline module-execution closure.
  if (bound.source.statements.some(node => ts.isImportDeclaration(node) && !node.importClause)) {
    addContextDiagnostic(state, "side_effect_import_not_expanded", path);
  }
  if (bound.source.statements.some(node => ts.isExpressionStatement(node) || ts.isExportDeclaration(node) || ts.isClassDeclaration(node) ||
    (ts.isVariableStatement(node) && hasModuleExecution(node)))) {
    addContextDiagnostic(state, "module_execution_or_reexport_not_expanded", path);
  }
  return value;
}

function isTypeOnlyImportBinding(declaration: ts.ImportDeclaration, exportedName: string): boolean {
  if (declaration.importClause?.isTypeOnly) return true;
  const bindings = declaration.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    const matching = bindings.elements.filter(el => (el.propertyName ?? el.name).text === exportedName);
    if (matching.length > 0 && matching.every(el => el.isTypeOnly)) return true;
  }
  return false;
}

function enqueueSymbolNode(
  state: ContextWalkState,
  path: string,
  node: ts.Node,
  depth: number,
  reason: SourceItem["reason"],
  typeOnlyClass = false,
  argumentFacts?: ContextValue[],
  isCall = false,
  hopDepth = depth
) {
  const declarationKey = `${path}:${node.pos}:${node.end}:${typeOnlyClass}`;
  const seen = state.variants.get(declarationKey) ?? new Set<string>();
  if (seen.size >= 4) argumentFacts = undefined;
  const variant = JSON.stringify(argumentFacts ?? null);
  seen.add(variant);
  state.variants.set(declarationKey, seen);
  const key = `${declarationKey}:${variant}`;
  if (state.visited.has(key)) return;
  state.visited.add(key);
  if (state.items.length >= MAX_ITEMS) { state.capacityOmissions++; state.incomplete = true; return; }
  const file = loadBoundTsFile(state, path);
  if (!file) return;
  if (reason === "target_implementation") state.emitted.add(declarationKey);

  if (reason !== "target_implementation" && !state.emitted.has(declarationKey)) {
    state.emitted.add(declarationKey);
    const start = file.bound.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const end = file.bound.source.getLineAndCharacterOfPosition(node.end).line + 1;
    const indexed = state.repo.getSymbolsByFileId(state.repo.getFileByPath(path)!.id).find(s => s.line_start >= start && s.line_end <= end);
    const name = indexed?.name ?? ("name" in node ? (node as ts.NamedDeclaration).name?.getText(file.bound.source) : undefined) ?? "local_declaration";
    if (typeOnlyClass && ts.isClassDeclaration(node)) {
      const contract = file.bound.contract(node);
      addContextItem(state, {
        kind: "type_contract", depth: hopDepth, name, file_path: path, indexed_content_hash: state.repo.getFileByPath(path)!.content_hash,
        start_line: start, end_line: end, projection: "public_instance_signatures", text: contract.text,
        inferred_types: contract.inferred ? "unknown" : "explicit",
      });
      addContextDiagnostic(state, "type_only_class_bodies_omitted", path, "Instance signature projection; constructors, private/static members, bodies and initializers omitted. Inferred types use unknown.");
    } else {
      const before = state.items.length;
      addSymbolSourceItem(state, path, file.text, { name, line_start: start, line_end: end }, reason, hopDepth);
      const item = state.items[before];
      if (item?.kind === "source") {
        item.selection_role = ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) ? "contract" : "implementation";
        if (isCall) state.directCallItems.add(item);
      }
    }
  }
  state.expansionQueue.push({ path, node, depth, hopDepth, reason, typeOnlyClass, arguments: argumentFacts });
}

async function expandSymbolReferences(state: ContextWalkState, entry: QueuedNode) {
  state.signal?.throwIfAborted();
  const file = loadBoundTsFile(state, entry.path);
  if (!file) return;
  const startLine = file.bound.source.getLineAndCharacterOfPosition(entry.node.getStart()).line + 1;
  const endLine = file.bound.source.getLineAndCharacterOfPosition(entry.node.end).line + 1;
  for (const edge of state.relationships.filter(e => !entry.typeOnlyClass && e.source.file === entry.path &&
    e.source.line >= startLine && e.source.line <= endLine)) {
    if (entry.path === state.targetFilePath) state.referencedEdges.add(edge);
    if (edge.freshness !== "current" || (edge.resolution.status !== "resolved" && edge.resolution.status !== "external") || edge.resolution.coverage === "conditional") {
      addContextDiagnostic(state, "import_not_fully_resolved", entry.path, `${edge.resolution.source.target}: ${edge.resolution.reason}`);
    }
  }
  const signatureNodes = entry.typeOnlyClass && ts.isClassDeclaration(entry.node) ? file.bound.contract(entry.node).signatures : undefined;
  const refs = file.bound.references(entry.node, entry.arguments, signatureNodes);
  if (refs.prunedBranches && entry.arguments) {
    addContextItem(state, { kind: "selection", reason: "known_call_arguments", file_path: entry.path, start_line: startLine, arguments: entry.arguments, pruned_branches: refs.prunedBranches });
  }
  for (const local of refs.locals) {
    const calls = refs.escapes.has(local) ? [] : refs.calls.filter(call => call.target === local);
    const prevLen = state.expansionQueue.length;
    if (calls.length) for (const call of calls) enqueueSymbolNode(state, entry.path, local, entry.depth, "local_dependency", false, call.arguments, true, entry.hopDepth + 1);
    else enqueueSymbolNode(state, entry.path, local, entry.depth, "local_dependency", entry.typeOnlyClass, undefined, false, entry.hopDepth + 1);
    if (entry.depth === 0) {
      while (state.expansionQueue.length > prevLen) {
        await expandSymbolReferences(state, state.expansionQueue.pop()!);
      }
    }
  }
  const deferredTypeOnlyClassImports: Array<{ dependencyPath: string; effectiveNames: string[]; depth: number; hopDepth: number }> = [];
  for (const [declaration, names] of refs.imports) {
    const sortedNames = [...names].sort();
    const typeOnlyByName = new Map<string, boolean>();
    for (const n of sortedNames) typeOnlyByName.set(n, entry.typeOnlyClass || isTypeOnlyImportBinding(declaration, n));
    const line = file.bound.source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
    const moduleName = ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : undefined;
    const edge = state.relationships.find(e => e.source.file === entry.path && e.source.line === line && e.resolution.source.target === moduleName);
    if (edge && entry.path === state.targetFilePath) state.referencedEdges.add(edge);
    if (!edge || edge.freshness !== "current" || edge.resolution.status !== "resolved" || edge.resolution.coverage === "conditional") {
      addContextDiagnostic(state, "referenced_import_not_expanded", entry.path, `${declaration.getText()}: ${edge?.resolution.reason ?? "relationship_not_found"}`);
      continue;
    }
    const paths = [...new Set(edge.resolution.targets.flatMap(t => t.files))];
    if (paths.length !== 1 || names.has("*")) {
      state.unexpandedFiles++;
      addContextDiagnostic(state, "dependency_depth_or_binding_limit", entry.path, declaration.getText());
      continue;
    }
    const dependencyPath = paths[0]!;
    if (entry.depth >= state.maxDepth) {
      const loaded = state.files.get(dependencyPath);
      const alreadyEmitted = Boolean(loaded) && sortedNames.length > 0 && sortedNames.every((n) => {
        const selected = loaded!.bound.exported(n);
        if (!selected) return false;
        const nextTypeOnlyClass = Boolean(typeOnlyByName.get(n)) && ts.isClassDeclaration(selected);
        return state.emitted.has(`${dependencyPath}:${selected.pos}:${selected.end}:${nextTypeOnlyClass}`);
      });
      if (!alreadyEmitted) {
        state.unexpandedFiles++;
        addContextDiagnostic(state, "dependency_depth_or_binding_limit", entry.path, declaration.getText());
      }
      continue;
    }
    const depFileRecord = state.repo.getFileByPath(dependencyPath);
    const depSymbols = depFileRecord ? state.repo.getSymbolsByFileId(depFileRecord.id) : [];
    if (sortedNames.length > 0 && sortedNames.every(n => Boolean(typeOnlyByName.get(n)) && depSymbols.some(s => s.name === n && s.kind === "class"))) {
      deferredTypeOnlyClassImports.push({ dependencyPath, effectiveNames: sortedNames, depth: entry.depth + 1, hopDepth: entry.hopDepth + 1 });
      continue;
    }
    const dependency = loadBoundTsFile(state, dependencyPath);
    if (!dependency) continue;
    for (const name of sortedNames) {
      const selected = dependency.bound.exported(name);
      if (!selected) { addContextDiagnostic(state, "export_binding_not_resolved", dependencyPath, name); continue; }
      const nextTypeOnlyClass = Boolean(typeOnlyByName.get(name)) && ts.isClassDeclaration(selected);
      const calls = refs.escapes.has(declaration) ? [] : refs.calls.filter(call => call.target === declaration && call.name === name);
      if (calls.length && !nextTypeOnlyClass) for (const call of calls) enqueueSymbolNode(state, dependencyPath, selected, entry.depth + 1, "direct_import_declaration", false, call.arguments, true, entry.hopDepth + 1);
      else enqueueSymbolNode(state, dependencyPath, selected, entry.depth + 1, "direct_import_declaration", nextTypeOnlyClass, undefined, false, entry.hopDepth + 1);
    }
  }
  for (const deferred of deferredTypeOnlyClassImports) {
    const dependency = loadBoundTsFile(state, deferred.dependencyPath);
    if (!dependency) continue;
    for (const name of deferred.effectiveNames) {
      const selected = dependency.bound.exported(name);
      if (!selected) { addContextDiagnostic(state, "export_binding_not_resolved", deferred.dependencyPath, name); continue; }
      enqueueSymbolNode(state, deferred.dependencyPath, selected, deferred.depth, "direct_import_declaration", ts.isClassDeclaration(selected), undefined, false, deferred.hopDepth);
    }
  }
  if (state.visited.size % 8 === 0) await new Promise<void>(done => setTimeout(done, 0));
}


/** Read-only context for a bounded import policy; no complete call graph claim. */
export async function retrieveContext(repo: SeptumRepository, config: ValidatedSeptumConfig, query: ContextQuery, workspaceRoot: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const budget = query.budget_bytes ?? 16 * 1024;
  if (!Number.isInteger(budget) || budget < MIN_CONTEXT_BUDGET || budget > MAX_CONTEXT_BUDGET) {
    return response({ status: "invalid_budget", minimum_budget_bytes: MIN_CONTEXT_BUDGET, maximum_budget_bytes: MAX_CONTEXT_BUDGET });
  }
  const maxDepth = query.max_depth ?? DEFAULT_CONTEXT_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_CONTEXT_DEPTH) {
    return response({ status: "invalid_max_depth", minimum_max_depth: 1, maximum_max_depth: MAX_CONTEXT_DEPTH });
  }
  const root = resolve(workspaceRoot);
  const name = (query.symbol_ref?.name || query.symbol || query.query || "").trim();
  if (!name) return response({ status: "invalid_query", message: "Choose a target with query, symbol or symbol_ref." });
  const initialIndex = repo.getIndexIdentity();
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
  if (!/\.(?:ts|mts|cts|tsx)$/.test(target.file_path)) {
    return response({ status: "unsupported", capability: "TypeScript static imports and indexed declarations", message: "Use locate/inspect/impact for other languages." });
  }
  const queryId = digest({ root, target: target.symbol_ref, policy: CONTEXT_POLICY, domain: query.domain ?? null,
    budget, max_depth: maxDepth, parser: PARSER_FINGERPRINT, resolver: RESOLVER_REVISION, reads: SOURCE_READ_REVISION, config });
  let cursor: { query: string; snapshot: string; offset: number; source_offset?: number } | undefined;
  if (query.continuation) {
    try {
      cursor = JSON.parse(Buffer.from(query.continuation, "base64url").toString("utf8"));
      if (!cursor || cursor.query !== queryId || typeof cursor.snapshot !== "string" ||
        !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
        cursor.source_offset !== undefined && (!Number.isSafeInteger(cursor.source_offset) || cursor.source_offset < 0)) throw new Error("invalid");
    } catch { return response({ status: "invalid_continuation", message: "Continuation must match the target, workspace, policy and budget; restart retrieval." }); }
  }
  const state: ContextWalkState = {
    repo,
    root,
    maxDepth,
    signal,
    targetFilePath: target.file_path,
    targetSource: "",
    relationships: [],
    referencedEdges: new Set<ImportRelationship>(),
    visited: new Set<string>(),
    emitted: new Set<string>(),
    directCallItems: new WeakSet<ContextItem>(),
    variants: new Map<string, Set<string>>(),
    files: new Map<string, BoundEntry>(),
    expansionQueue: [],
    items: [],
    freshness: "current",
    incomplete: repo.getMeta("sync_state") !== "complete",
    capacityOmissions: 0,
    unexpandedFiles: 0,
    sourceBytes: 0,
  };
  const collected = await collectSourceSkips(root, async () => {
    if (state.incomplete) addContextDiagnostic(state, "index_not_complete");
    const source = readIndexedSource(state, target.file_path);
    if (source === undefined) return state.items;
    state.targetSource = source;
    state.relationships = repo.getImportRelationships(root);
    addSymbolSourceItem(state, target.file_path, source, target, "target_implementation", 0);
    const targetFile = loadBoundTsFile(state, target.file_path);
    const declaration = targetFile?.bound.declaration(target.line_start, target.line_end);
    if (declaration) {
      if (targetFile!.bound.source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1 !== target.line_start ||
          targetFile!.bound.source.getLineAndCharacterOfPosition(declaration.end).line + 1 !== target.line_end) {
        addContextDiagnostic(state, "enclosing_declaration_reference_scope", target.file_path);
      }
      enqueueSymbolNode(state, target.file_path, declaration, 0, "target_implementation");
      while (state.expansionQueue.length > 0) {
        await expandSymbolReferences(state, state.expansionQueue.shift()!);
      }
    } else {
      addContextDiagnostic(state, "target_ast_declaration_not_found", target.file_path);
    }
    // Signal-first, hop-aware ordering:
    // 0: target implementation, 1: source & contracts sorted strictly by depth (0 -> 1 -> 2...),
    // within each depth: direct calls -> contracts -> local helpers -> other imports, then smaller span.
    // 2: selection notes, 3: diagnostics & relationships.
    const itemGroup = (item: ContextItem) =>
      item.kind === "source" && item.reason === "target_implementation" ? 0
        : item.kind === "source" || item.kind === "type_contract" ? 1
          : item.kind === "selection" ? 2 : 3;
    const itemDepth = (item: ContextItem) =>
      item.kind === "source" || item.kind === "type_contract" ? (item.depth ?? 1) : 99;
    const roleRank = (item: ContextItem) => {
      if (item.kind === "source" && state.directCallItems.has(item)) return 0;
      if (item.kind === "type_contract" || (item.kind === "source" && item.selection_role === "contract")) return 1;
      if (item.kind === "source" && item.reason === "local_dependency") return 2;
      return 3;
    };
    const spanLines = (item: ContextItem) =>
      item.kind === "source" ? item.source.end_line - item.source.start_line
        : item.kind === "type_contract" ? item.end_line - item.start_line : 0;
    state.items.sort((a, b) =>
      itemGroup(a) - itemGroup(b) ||
      (itemGroup(a) === 1
        ? itemDepth(a) - itemDepth(b) || roleRank(a) - roleRank(b) || spanLines(a) - spanLines(b)
        : 0)
    );
    for (const edge of state.referencedEdges) addContextItem(state, { kind: "relationship", reason: "target_file_import", relationship: edge });
    return state.items;
  });
  signal?.throwIfAborted();
  if (repo.getIndexIdentity() !== initialIndex) return response({ status: "index_changed", message: "Index changed during context analysis; retry retrieval." });
  // Negative resolution can change when an unindexed file appears. Observed file
  // reads alone cannot capture that; bind the resolved selection and diagnostics too.
  const snapshot = digest({ index: initialIndex, inputs: collected.inputs.map(({ path, hash }) => ({ path, hash })), observations: collected.observations, selection: collected.value });
  if (cursor && (cursor.snapshot !== snapshot || cursor.offset >= collected.value.length)) {
    return response({ status: "stale_continuation", message: "Input/index identity changed or the page is invalid; restart retrieval." });
  }
  return pageContext({
    items: collected.value, start: cursor?.offset ?? 0, sourceOffset: cursor?.source_offset ?? 0,
    budget, incomplete: state.incomplete,
    accounting: { omitted_by_capacity: state.capacityOmissions, unexpanded_dependency_files: state.unexpandedFiles },
    base: {
      policy: CONTEXT_POLICY, context_mode: "deep", workspace: root, target: target.symbol_ref,
      target_id: symbolTargetId(root, target.symbol_ref), query_id: queryId, snapshot_id: snapshot, freshness: state.freshness,
      freshness_scope: "returned source hashes checked against index during response preparation",
      completeness_scope: `target and bound local/referenced declarations in directly imported TypeScript files up to ${maxDepth} import edge(s)`,
      capability_limits: "static references, not calls", task_sufficiency: "unknown",
      input_count: collected.inputs.length, selected_source_bytes_read: state.sourceBytes, dependency_depth: maxDepth,
    },
  });
}
