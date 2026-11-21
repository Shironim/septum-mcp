import { symbolReference } from "./symbol-reference.ts";
import type { SymbolReference, SymbolSelectionOptions } from "../../types/index.ts";
import type { SymbolKind } from "../database/repository.ts";
import type { SeptumRepository } from "../database/repository.ts";

export interface ParsedSymbolQuery {
  raw: string;
  container?: string; // e.g. "OrderController" or "App\\Http\\Controllers\\OrderController"
  member?: string;    // e.g. "calculateTotal"
  kind?: SymbolKind;
}

export interface SuggestionMatch {
  name: string;
  kind: string;
  signature: string;
  line_start: number;
  line_end: number;
  start_line?: number;
  end_line?: number;
  similarity_score: number; // 0.0 - 1.0
  file_path?: string;
}

export interface SymbolLocationResult {
  query: string;
  parsed: ParsedSymbolQuery;
  found: boolean;
  status?: "ambiguous" | "stale_reference";
  candidates?: Array<{ name: string; file_path: string; signature: string; symbol_ref: SymbolReference }>;
  symbol_ref?: SymbolReference;
  file_path?: string;
  container_name?: string;
  exact_symbol?: {
    name: string;
    kind: string;
    signature: string;
    visibility: string;
    line_start: number;
    line_end: number;
    start_line?: number;
    end_line?: number;
  };
  sibling_methods?: string[];
  suggestions: SuggestionMatch[];
  message: string;
}

export class SymbolLocator {
  constructor(private repo: SeptumRepository) {}

  /**
   * Parse error log strings, method call syntax, or symbol names into container & member.
   * Examples:
   *  - "Method OrderController::calculateTotal() does not exist"
   *  - "Call to undefined method App\\Http\\Controllers\\OrderController::calculateTotal()"
   *  - "OrderController->calculateTotal()"
   *  - "OrderController.calculateTotal"
   *  - "OrderController"
   *  - "calculateTotal"
   */
  public parseQuery(rawQuery: string): ParsedSymbolQuery {
    const trimmed = rawQuery.trim();

    // 1. Error string matching: "Method X::y() does not exist" or "Call to undefined method X::y()"
    const methodNotExistMatch = trimmed.match(/(?:Method|method)\s+([A-Za-z0-9_\\\/\.]+)::([A-Za-z0-9_]+)\s*\(\)?/i);
    if (methodNotExistMatch) {
      return {
        raw: trimmed,
        container: methodNotExistMatch[1],
        member: methodNotExistMatch[2],
        kind: "method",
      };
    }

    // 2. Python / JS error: "'X' object has no attribute 'y'"
    const pyAttrMatch = trimmed.match(/['"]?([A-Za-z0-9_]+)['"]?\s+object has no attribute\s+['"]?([A-Za-z0-9_]+)['"]?/i);
    if (pyAttrMatch) {
      return {
        raw: trimmed,
        container: pyAttrMatch[1],
        member: pyAttrMatch[2],
      };
    }

    // 3. Class::member or Class->member or Class.member
    const staticCallMatch = trimmed.match(/^([A-Za-z0-9_\\\/\.]+)::([A-Za-z0-9_]+)(?:\(\))?$/);
    if (staticCallMatch) {
      return {
        raw: trimmed,
        container: staticCallMatch[1],
        member: staticCallMatch[2],
        kind: "method",
      };
    }

    const arrowCallMatch = trimmed.match(/^([A-Za-z0-9_\\\/\.]+)->([A-Za-z0-9_]+)(?:\(\))?$/);
    if (arrowCallMatch) {
      return {
        raw: trimmed,
        container: arrowCallMatch[1],
        member: arrowCallMatch[2],
        kind: "method",
      };
    }

    const dotCallMatch = trimmed.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)(?:\(\))?$/);
    if (dotCallMatch) {
      return {
        raw: trimmed,
        container: dotCallMatch[1],
        member: dotCallMatch[2],
      };
    }

    // 4. Function call: "calculateTotal()"
    const funcMatch = trimmed.match(/^([A-Za-z0-9_]+)\(\)$/);
    if (funcMatch) {
      return {
        raw: trimmed,
        member: funcMatch[1],
        kind: "function",
      };
    }

    // 5. Bare word: could be class or function
    return {
      raw: trimmed,
      member: trimmed,
    };
  }

  /**
   * Locate the symbol or diagnostic resolution in the database.
   */
  public locate(rawQuery: string, domainFilter?: string, options: SymbolSelectionOptions = {}): SymbolLocationResult {
    const parsed = this.parseQuery(rawQuery);
    const selection = { ...options, domain: domainFilter ?? options.domain };
    const base = { query: parsed.raw, parsed, found: false, suggestions: [] };
    if (selection.reference) {
      const file = this.repo.getFileByPath(selection.reference.file_path);
      if (!file || file.content_hash !== selection.reference.indexed_content_hash) {
        return { ...base, status: "stale_reference", message: "Declaration reference is stale; locate the symbol again." };
      }
    }
    const container = parsed.container?.split(/\\|\//).pop();
    const qualified = parsed.raw === `${parsed.container}.${parsed.member}` ? parsed.raw : `${container}::${parsed.member}`;
    const query = selection.reference?.name ?? (container ? qualified : parsed.member ?? parsed.raw);
    const candidates = this.repo.findSymbolsByName(query, selection);
    if (candidates.length > 1) {
      return {
        ...base, status: "ambiguous",
        candidates: candidates.map(c => ({ name: c.name, file_path: c.file_path, signature: c.signature, symbol_ref: c.symbol_ref })),
        message: "Multiple matching declarations; select a candidate with symbol_ref.",
      };
    }
    if (candidates.length === 1) {
      const exact = candidates[0]!;
      const details = this.repo.getSymbolDetails(exact.name, { ...selection, reference: exact.symbol_ref, includeDependencies: false });
      return {
        ...base, found: true, file_path: exact.file_path, container_name: exact.symbol_ref.container,
        symbol_ref: exact.symbol_ref,
        exact_symbol: { name: exact.name, kind: exact.kind, signature: exact.signature, visibility: exact.visibility, line_start: exact.line_start, line_end: exact.line_end, start_line: exact.line_start, end_line: exact.line_end },
        sibling_methods: details?.sibling_methods,
        message: `Found exact symbol '${exact.name}' in ${exact.file_path}:${exact.line_start}`,
      };
    }
    const target = parsed.member ?? parsed.raw;
    const owners = container ? this.repo.findSymbolsByName(container, selection)
      .filter(s => ["class", "interface", "trait", "struct", "enum"].includes(s.kind)) : [];
    const owner = owners.length === 1 ? owners[0] : undefined;
    const siblings = owner ? this.repo.getSymbolDetails(owner.name, { ...selection, reference: owner.symbol_ref, includeDependencies: false })?.sibling_methods : undefined;
    const searchable = owner ? this.repo.getSymbolsByFileId(owner.file_id)
      .filter(s => s.kind === "method" && symbolReference({ ...s, file_path: owner.file_path, indexed_content_hash: owner.indexed_content_hash }).container === owner.name)
      .map(s => ({ ...s, file_path: owner.file_path })) : this.repo.getAllSymbolsWithFiles();
    const domainId = selection.domain ? this.repo.getAllDomains().find(d => d.name.toLowerCase() === selection.domain!.toLowerCase())?.id : undefined;
    const seenNames = new Set<string>();
    const suggestions = searchable
      .filter(s => !selection.filePath || s.file_path === selection.filePath)
      .filter(s => !selection.domain || this.repo.getFileByPath(s.file_path)?.domain_id === domainId)
      .map(s => ({
        name: owner ? s.name.split(/::|[.#]/).pop()! : s.name, kind: s.kind, signature: s.signature, line_start: s.line_start, line_end: s.line_end, start_line: s.line_start, end_line: s.line_end, file_path: s.file_path,
        similarity_score: Math.round(Math.max(calculateSimilarity(target, s.name.split(/::|[.#]/).pop()!), calculateSimilarity(parsed.raw, s.name)) * 100) / 100,
      }))
      .filter(s => s.similarity_score >= 0.3)
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .filter(s => {
        if (seenNames.has(s.name)) return false;
        seenNames.add(s.name);
        return true;
      })
      .slice(0, 10);
    return { ...base, file_path: owner?.file_path, container_name: owner?.name, sibling_methods: siblings, suggestions, message: `Symbol '${parsed.raw}' not found.${suggestions.length ? ` Did you mean '${suggestions[0]!.name}'?` : ""}` };
  }

}

/**
 * Enhanced similarity matching:
 * Combines Damerau-Levenshtein distance (handling typos & transpositions),
 * prefix/suffix matching, substring inclusion, and token Jaccard similarity.
 */
export function calculateSimilarity(source: string, target: string): number {
  const s1 = source.toLowerCase();
  const s2 = target.toLowerCase();

  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  // Prefix bonus: highly relevant for autocomplete-style / partial searches
  let prefixBonus = 0;
  if (s2.startsWith(s1) || s1.startsWith(s2)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    prefixBonus = 0.25 * (minLen / maxLen);
  }

  // Substring inclusion bonus
  let substringBonus = 0;
  if (s2.includes(s1) || s1.includes(s2)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    substringBonus = 0.3 * (minLen / maxLen);
  }

  // Token-based matching (CamelCase, snake_case, kebab-case, namespaces)
  const tokenize = (str: string) =>
    str
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s_\-\.\:\/\\]+/)
      .filter((t) => t.length > 1);

  const t1 = tokenize(source);
  const t2 = tokenize(target);
  let tokenBonus = 0;
  let sharedTokenCount = 0;
  let exactTokenMatchCount = 0;
  if (t1.length > 0 && t2.length > 0) {
    const exactTokens = t1.filter((token) => t2.includes(token));
    exactTokenMatchCount = exactTokens.length;
    const sharedTokens = t1.filter((token) =>
      t2.some((t) => t.includes(token) || token.includes(t))
    );
    sharedTokenCount = sharedTokens.length;
    const allUniqueTokens = new Set([...t1, ...t2]);
    const jaccard = sharedTokens.length / (allUniqueTokens.size || 1);
    const exactCoverage = exactTokens.length / t1.length;
    tokenBonus = jaccard * 0.35 + (exactTokens.length > 0 ? 0.25 + exactCoverage * 0.2 : 0);
  }

  // Damerau-Levenshtein Matrix
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      let minCost = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );

      // Transposition check (Damerau)
      if (
        i > 1 &&
        j > 1 &&
        s1[i - 1] === s2[j - 2] &&
        s1[i - 2] === s2[j - 1]
      ) {
        minCost = Math.min(minCost, matrix[i - 2][j - 2] + 1);
      }

      matrix[i][j] = minCost;
    }
  }

  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  let rawSimilarity = 1.0 - distance / maxLen;

  // Dampen accidental subsequence matches for short unrelated words against multi-token queries
  if (t1.length > 1 && t2.length > 0 && sharedTokenCount === 0 && !s2.includes(s1) && !s1.includes(s2) && Math.min(len1, len2) / maxLen < 0.65) {
    rawSimilarity *= 0.55;
  }

  // Boost exact word-boundary token matches (e.g. "Store" -> "SymbolDetailsStore") above edit-distance noise ("Scope", "close")
  const totalScore = exactTokenMatchCount > 0
    ? Math.max(rawSimilarity + prefixBonus + substringBonus + tokenBonus, 0.72 + (exactTokenMatchCount / t2.length) * 0.2)
    : rawSimilarity + prefixBonus + substringBonus + tokenBonus;
  return Math.min(1.0, Math.max(0.0, totalScore));
}
