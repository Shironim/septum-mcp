import { symbolReference, matchesSymbolName, matchesSymbolReference } from "../../resolver/symbol-reference.ts";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import type {
  DomainRecord,
  ExtractedSymbol,
  FileRecord,
  GetSymbolDetailsResponse,
  FileConnectionsSummary,
  ResolvedOutboundCall,
  SymbolComplexitySmell,
  SymbolKind,
  SymbolRecord,
  SymbolCandidate,
  SymbolSelectionOptions,
} from "../../../types/index.ts";
import { DependencyRepository } from "./dependency.repository.ts";
import { probeSourcePath, readSourceFile } from "../../resources/source-files.ts";
import { assertPathContained } from "../../resolver/path-resolver.ts";

const SQL_KEYWORD_BLACKLIST = new Set([
  "VALUES",
  "WHERE",
  "SELECT",
  "FROM",
  "JOIN",
  "LIKE",
  "INSERT",
  "UPDATE",
  "DELETE",
]);

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

export class SymbolRepository {
  constructor(private db: Database) {}

  public replaceFileSymbols(fileId: number, symbols: ExtractedSymbol[]): void {
    this.db.query("DELETE FROM symbols WHERE file_id = ?").run(fileId);
    if (symbols.length === 0) return;

    const stmt = this.db.query(
      `INSERT INTO symbols (file_id, name, kind, signature, visibility, line_start, line_end, line_count, nesting_depth) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const sym of symbols) {
      const lineCount = sym.line_count ?? Math.max(1, sym.line_end - sym.line_start + 1);
      const nestingDepth = sym.nesting_depth ?? 1;
      stmt.run(
        fileId,
        sym.name,
        sym.kind,
        sym.signature,
        sym.visibility,
        sym.line_start,
        sym.line_end,
        lineCount,
        nestingDepth
      );
    }
  }

  public getSymbolsByFileId(fileId: number): SymbolRecord[] {
    return this.db
      .query<SymbolRecord, [number]>(
        "SELECT * FROM symbols WHERE file_id = ? ORDER BY line_start ASC"
      )
      .all(fileId);
  }

  public findSymbolsByName(
    name: string,
    options: SymbolSelectionOptions = {}
  ): SymbolCandidate[] {
    const target = name.trim().replace(/\(\)$/, "");
    const leaf = target.split(/::|->|[.#\\]/).pop() ?? target;
    let query = `SELECT s.*, f.path AS file_path, f.content_hash AS indexed_content_hash, d.name AS domain_name
      FROM symbols s JOIN files f ON s.file_id = f.id JOIN domains d ON f.domain_id = d.id
      WHERE (s.name = ? OR substr(s.name, -length(?)) = ?)`;
    const params: string[] = [target, leaf, leaf];
    if (options.domain) { query += " AND d.name = ?"; params.push(options.domain); }
    const filePath = options.filePath ?? options.reference?.file_path;
    if (filePath) { query += " AND f.path = ?"; params.push(filePath); }
    query += " ORDER BY f.path, s.line_start, s.line_end, s.signature, s.id";
    return this.db.query<SymbolCandidate, string[]>(query).all(...params)
      .filter(row => matchesSymbolName(row, target))
      .map(row => ({ ...row, symbol_ref: symbolReference(row) }))
      .filter(row => !options.reference || matchesSymbolReference(row.symbol_ref, options.reference));
  }

  public findContainers(
    containerName: string
  ): Array<{ file: FileRecord; symbol?: SymbolRecord }> {
    const symbolQuery = `
      SELECT s.*, f.path AS file_path, f.id AS f_id, f.domain_id AS f_domain_id, 
             f.archetype AS f_archetype, f.content_hash AS f_content_hash, 
             f.line_count AS f_line_count, f.mtime_ms AS f_mtime_ms, 
             f.size_bytes AS f_size_bytes, f.last_scanned_at AS f_last_scanned_at
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE (s.name = ? OR s.name LIKE ? OR s.name LIKE ?)
        AND s.kind IN ('class', 'interface', 'trait', 'enum')
      LIMIT 10
    `;
    const rows = this.db
      .query<any, [string, string, string]>(symbolQuery)
      .all(containerName, `%\\${containerName}`, `%/${containerName}`);

    if (rows.length > 0) {
      return rows.map((r) => ({
        file: {
          id: r.f_id,
          domain_id: r.f_domain_id,
          path: r.file_path,
          archetype: r.f_archetype,
          content_hash: r.f_content_hash,
          line_count: r.f_line_count,
          mtime_ms: r.f_mtime_ms,
          size_bytes: r.f_size_bytes,
          last_scanned_at: r.f_last_scanned_at,
        },
        symbol: {
          id: r.id,
          file_id: r.file_id,
          name: r.name,
          kind: r.kind,
          signature: r.signature,
          visibility: r.visibility,
          line_start: r.line_start,
          line_end: r.line_end,
          line_count: r.line_count ?? (r.line_end - r.line_start + 1),
          nesting_depth: r.nesting_depth ?? 1,
        },
      }));
    }

    const fileQuery = `
      SELECT * FROM files
      WHERE path LIKE ? OR path LIKE ?
      LIMIT 10
    `;
    const files = this.db
      .query<FileRecord, [string, string]>(fileQuery)
      .all(`%/${containerName}.%`, `%\\${containerName}.%`);

    return files.map((file) => ({ file }));
  }

  public getAllSymbolsWithFiles(): Array<SymbolRecord & { file_path: string }> {
    const query = `
      SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.kind IN ('class', 'interface', 'trait', 'struct', 'enum', 'type', 'method', 'function', 'constant')
      ORDER BY s.line_start ASC, s.name ASC
    `;
    return this.db.query<SymbolRecord & { file_path: string }, []>(query).all();
  }

  public findSymbolWithDomain(symbolName: string): {
    symbol_name: string;
    kind: string;
    file_path: string;
    domain_name: string;
  } | null {
    const query = `
      SELECT 
        s.name AS symbol_name,
        s.kind,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE s.name = ?
      LIMIT 1
    `;
    return this.db.query<any, [string]>(query).get(symbolName) ?? null;
  }

  public findSymbolWithMembers(symbolName: string): {
    symbol_name: string;
    kind: string;
    signature: string;
    file_path: string;
    domain_name: string;
    methods: string[];
    properties: string[];
  } | null {
    const rootQuery = `
      SELECT 
        s.id AS symbol_id,
        s.file_id,
        s.name AS symbol_name,
        s.kind,
        s.signature,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE s.name = ?
      LIMIT 1
    `;
    const root = this.db.query<any, [string]>(rootQuery).get(symbolName);
    if (!root) return null;

    const membersQuery = `
      SELECT name, kind, signature
      FROM symbols
      WHERE file_id = ? AND name LIKE ?
      ORDER BY line_start ASC
    `;
    const members = this.db
      .query<any, [number, string]>(membersQuery)
      .all(root.file_id, `${symbolName}::%`);

    const methods: string[] = [];
    const properties: string[] = [];

    for (const m of members) {
      if (m.kind === "method") {
        methods.push(m.signature);
      } else if (m.kind === "property") {
        properties.push(m.signature);
      }
    }

    return {
      symbol_name: root.symbol_name,
      kind: root.kind,
      signature: root.signature,
      file_path: root.file_path,
      domain_name: root.domain_name,
      methods,
      properties,
    };
  }

  public getFileWithDomain(filePath: string): {
    file_id: number;
    file_path: string;
    domain_name: string;
  } | null {
    const query = `
      SELECT 
        f.id AS file_id,
        f.path AS file_path,
        d.name AS domain_name
      FROM files f
      JOIN domains d ON f.domain_id = d.id
      WHERE f.path = ?
      LIMIT 1
    `;
    return this.db.query<any, [string]>(query).get(filePath) ?? null;
  }

  public getSymbolDetails(
    symbolQuery: string,
    options: SymbolSelectionOptions & { includeDependencies?: boolean; workspaceRoot?: string } = {}
  ): GetSymbolDetailsResponse | null {
    const trimmed = symbolQuery.trim();
    if (!trimmed) return null;

    const candidates = this.findSymbolsByName(trimmed, options);
    if (candidates.length !== 1) return null;
    const row = candidates[0]!;

    // 1. Sibling methods
    const isRust = /\.rs$/i.test(row.file_path);
    const containerName = row.symbol_ref.container ?? "";
    const owner = ["class", "interface", "trait", "struct", "enum"].includes(row.kind) ? row.name
      : row.kind === "method" ? containerName : "";
    let siblingMethods: string[] = owner ? this.getSymbolsByFileId(row.file_id)
      .filter(s => s.kind === "method" && s.id !== row.id)
      .filter(s => symbolReference({ ...s, file_path: row.file_path, indexed_content_hash: row.indexed_content_hash }).container === owner)
      .map(s => s.name.split(/::|[.#]/).pop()!) : [];

    siblingMethods = Array.from(new Set(siblingMethods)).filter(
      (m) => !SQL_KEYWORD_BLACKLIST.has(m.toUpperCase())
    );

    // 2. Dependencies Injected (from signature type-hints and constructor)
    const dependenciesInjected = new Set<string>();
    const outboundCalls = new Set<string>();
    const resolvedOutboundCalls: ResolvedOutboundCall[] = [];
    let connectedFiles: FileConnectionsSummary = { imports_from: [], imported_by_count: 0 };

    const shouldIncludeDeps = options.includeDependencies !== false;

    if (shouldIncludeDeps) {
      const varTypes = new Map<string, string>();
      const primitiveTypes = new Set([
        "int", "string", "str", "bool", "boolean", "float", "double", "decimal",
        "number", "bigint", "symbol", "array", "list", "dict", "tuple", "set",
        "iterable", "callable", "function", "void", "mixed", "object", "null",
        "undefined", "never", "any", "unknown", "true", "false", "record",
        "partial", "omit", "pick", "readonly", "required", "promise", "map",
        "weakmap", "weakset", "date", "error", "regexp", "buffer", "abortsignal",
        "uint8array", "self", "cls",
      ]);
      const modifierWords = new Set([
        "public", "private", "protected", "readonly", "final", "var", "val",
        "mut", "ref", "in", "out", "params", "async",
      ]);

      const splitTopLevel = (input: string, delimiter: string): string[] => {
        const result: string[] = [];
        let current = "";
        let depth = 0;
        for (let i = 0; i < input.length; i++) {
          const ch = input[i];
          if (ch === "(" || ch === "<" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === ">" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
          if (depth === 0 && input.startsWith(delimiter, i)) {
            result.push(current);
            current = "";
            i += delimiter.length - 1;
          } else {
            current += ch;
          }
        }
        if (current.trim()) result.push(current);
        return result;
      };

      const registerTypeToken = (rawToken: string, paramName?: string) => {
        let token = rawToken.trim()
          .replace(/^\?+/, "")
          .replace(/^&+/, "")
          .replace(/^\*+/, "")
          .replace(/\[\]$/, "")
          .replace(/<.*>$/s, "")
          .replace(/^[\\$]/, "")
          .trim();
        if (token.includes("\\")) token = token.split("\\").pop() || token;
        if (token.includes(".")) token = token.split(".").pop() || token;
        if (!token || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return;
        if (primitiveTypes.has(token.toLowerCase()) || modifierWords.has(token.toLowerCase())) return;
        dependenciesInjected.add(token);
        if (paramName && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(paramName) && !varTypes.has(paramName)) {
          varTypes.set(paramName, token);
        }
      };

      const extractTypeHints = (sig: string) => {
        const openIdx = sig.indexOf("(");
        if (openIdx === -1) return;
        let closeIdx = -1;
        let depth = 0;
        for (let i = openIdx; i < sig.length; i++) {
          if (sig[i] === "(") depth++;
          else if (sig[i] === ")") {
            depth--;
            if (depth === 0) {
              closeIdx = i;
              break;
            }
          }
        }
        if (closeIdx <= openIdx + 1) return;
        const paramBlock = sig.slice(openIdx + 1, closeIdx);
        const params = splitTopLevel(paramBlock, ",");
        const isGo = /\.go$/i.test(row.file_path);

        for (const rawParam of params) {
          let p = rawParam.trim();
          if (!p) continue;
          // Strip top-level default value `= ...` (ignoring `=>` in arrow types)
          let eqDepth = 0;
          for (let i = 0; i < p.length; i++) {
            const ch = p[i];
            if (ch === "(" || ch === "<" || ch === "[" || ch === "{") eqDepth++;
            else if (ch === ")" || ch === ">" || ch === "]" || ch === "}") eqDepth = Math.max(0, eqDepth - 1);
            else if (eqDepth === 0 && ch === "=" && p[i + 1] !== ">" && p[i - 1] !== "!" && p[i - 1] !== "=" && p[i - 1] !== "<" && p[i - 1] !== ">") {
              p = p.slice(0, i).trim();
              break;
            }
          }
          // Check for top-level colon `param: Type` (TypeScript, Python, etc.)
          let colonIdx = -1;
          let colDepth = 0;
          for (let i = 0; i < p.length; i++) {
            const ch = p[i];
            if (ch === "(" || ch === "<" || ch === "[" || ch === "{") colDepth++;
            else if (ch === ")" || ch === ">" || ch === "]" || ch === "}") colDepth = Math.max(0, colDepth - 1);
            else if (colDepth === 0 && ch === ":" && p[i + 1] !== ":" && p[i - 1] !== ":") {
              colonIdx = i;
              break;
            }
          }

          if (colonIdx !== -1) {
            const leftTokens = p.slice(0, colonIdx).trim().replace(/^\.{3}/, "").split(/\s+/)
              .filter(t => !modifierWords.has(t.toLowerCase()));
            const rawParamName = (leftTokens.pop() || "").replace(/\?$/, "").replace(/^\$/, "");
            const typeExpr = p.slice(colonIdx + 1).trim();
            if (typeExpr.startsWith("{") || typeExpr.startsWith("(") || typeExpr.startsWith("[")) continue;
            // Support generic wrappers like Promise<Type> or Array<Type> or union TypeA | TypeB
            for (const branch of splitTopLevel(typeExpr, "|")) {
              const trimmedBranch = branch.trim();
              const wrapperMatch = /^(?:Promise|Array|ReadonlyArray|Partial|Required|Readonly)\s*<(.+)>$/s.exec(trimmedBranch);
              registerTypeToken(wrapperMatch ? wrapperMatch[1] : trimmedBranch, rawParamName);
            }
          } else {
            const parts = p.replace(/^\.{3}/, "").split(/\s+/).filter(t => !modifierWords.has(t.toLowerCase()));
            if (parts.length >= 2) {
              if (isGo) {
                const rawParamName = parts[0];
                const rawType = parts[parts.length - 1];
                registerTypeToken(rawType, rawParamName);
              } else {
                const rawType = parts[0];
                const rawParamName = parts[1].replace(/^[$&]+/, "");
                registerTypeToken(rawType, rawParamName);
              }
            }
          }
        }
      };

      // Rust parameter types do not establish a dependency injection binding.
      if (!isRust) extractTypeHints(row.signature);

      // Also check constructor injection if this is a method or class
      const classOwner = containerName || (row.kind === "class" ? row.name : "");
      if (classOwner && !isRust) {
        const ctor = this.db
          .query<{ signature: string }, [number, string, string, string, string]>(
            "SELECT signature FROM symbols WHERE file_id = ? AND (name = ? OR name = ? OR name = ? OR name LIKE ?) LIMIT 1"
          )
          .get(
            row.file_id,
            `${classOwner}::__construct`,
            `${classOwner}::constructor`,
            `${classOwner}::__init__`,
            `%::__construct`
          );
        if (ctor) {
          extractTypeHints(ctor.signature);
        }
      }

      // 3. Outbound Calls (inspected from physical source file lines if accessible)
      try {
        const fullPath = options.workspaceRoot
          ? path.resolve(options.workspaceRoot, row.file_path)
          : row.file_path;
        // Public handlers provide a workspace; the legacy rootless repository API also accepts absolute paths.
        if (options.workspaceRoot) assertPathContained(fullPath, options.workspaceRoot, "Outbound call source");
        if (probeSourcePath(fullPath) === "file") {
          const fileContent = readSourceFile(fullPath);
          const lines = fileContent.split(/\r?\n/);
          const start = Math.max(0, row.line_start - 1);
          const end = Math.min(lines.length, row.line_end);
          const rawSlice = lines.slice(start, end).join("\n");
          const sanitizedSlice = stripCommentsAndStrings(rawSlice);

          // Track local `new ClassName(...)` assignments inside the symbol slice
          for (const m of sanitizedSlice.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g)) {
            varTypes.set(m[1], m[2]);
          }
          for (const m of sanitizedSlice.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g)) {
            varTypes.set(m[1], m[2]);
          }

          // Match Static invocations: ClassName::methodName(
          const staticCalls = sanitizedSlice.matchAll(/([A-Z][a-zA-Z0-9_]+)::([a-zA-Z0-9_]+)\s*\(/g);
          for (const m of staticCalls) {
            if (m[1] !== "self" && m[1] !== "parent" && m[1] !== "static") {
              outboundCalls.add(`${m[1]}::${m[2]}`);
            }
          }

          // Match PHP property calls: $this->property->method(
          const propCalls = sanitizedSlice.matchAll(/\$this->([a-zA-Z0-9_]+)->([a-zA-Z0-9_]+)\s*\(/g);
          for (const m of propCalls) {
            const propName = m[1];
            const methodName = m[2];
            const mappedType = varTypes.get(propName);
            const inferredClass = mappedType || (propName.charAt(0).toUpperCase() + propName.slice(1));
            outboundCalls.add(`${inferredClass}::${methodName}`);
          }

          // Match TS/JS property calls: this.property.method(
          const tsPropCalls = sanitizedSlice.matchAll(/\bthis\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\(/g);
          for (const m of tsPropCalls) {
            const propName = m[1];
            const methodName = m[2];
            if (propName !== "db") {
              const mappedType = varTypes.get(propName);
              const inferredClass = mappedType || (propName.charAt(0).toUpperCase() + propName.slice(1));
              outboundCalls.add(`${inferredClass}::${methodName}`);
            }
          }

          // Collect same-file symbols and explicitly imported symbols for high-precision direct & receiver call detection
          const sameFileSymbols = this.getSymbolsByFileId(row.file_id);
          const knownDirectCallables = new Set<string>();
          const knownStaticReceivers = new Set<string>();
          for (const s of sameFileSymbols) {
            if (s.id === row.id) continue;
            if (s.kind === "function") knownDirectCallables.add(s.name);
            else if (s.kind === "class") knownStaticReceivers.add(s.name);
          }

          const fileDeps = this.db
            .query<{ import_statement: string }, [number]>(
              "SELECT import_statement FROM dependencies WHERE source_file_id = ? AND is_external = 0"
            )
            .all(row.file_id);
          for (const dep of fileDeps) {
            const stmt = dep.import_statement || "";
            if (/^\s*import\s+type\b/.test(stmt)) continue;
            const braceMatch = stmt.match(/\{([^}]+)\}/);
            if (braceMatch) {
              for (const spec of braceMatch[1].split(",")) {
                const trimmedSpec = spec.trim();
                if (/^type\s+/.test(trimmedSpec)) continue;
                const aliasParts = trimmedSpec.split(/\s+as\s+/);
                const localName = (aliasParts[1] || aliasParts[0] || "").trim();
                if (/^[a-z_$][a-zA-Z0-9_$]*$/.test(localName)) knownDirectCallables.add(localName);
                else if (/^[A-Z][a-zA-Z0-9_$]*$/.test(localName)) knownStaticReceivers.add(localName);
              }
            }
            const defaultMatch = stmt.match(/^\s*import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\b/);
            if (defaultMatch) {
              const localName = defaultMatch[1];
              if (/^[a-z_$]/.test(localName)) knownDirectCallables.add(localName);
              else knownStaticReceivers.add(localName);
            }
          }

          // Match calls on typed parameters / local instances (`repo.findSymbolsByName(` or `TopologyDetector.detect(`)
          for (const m of sanitizedSlice.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)) {
            const receiver = m[1];
            const method = m[2];
            if (receiver === "this" || receiver === "super" || receiver === "console" || receiver === "process" || receiver === "Math" || receiver === "JSON" || receiver === "Object" || receiver === "Array" || receiver === "Buffer" || receiver === "Promise" || receiver === "Number" || receiver === "String") continue;
            const mappedType = varTypes.get(receiver);
            if (mappedType) {
              outboundCalls.add(`${mappedType}::${method}`);
            } else if (knownStaticReceivers.has(receiver)) {
              outboundCalls.add(`${receiver}::${method}`);
            }
          }
          for (const m of sanitizedSlice.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
            const receiver = m[1];
            const method = m[2];
            if (receiver === "this") continue;
            const mappedType = varTypes.get(receiver);
            if (mappedType) {
              outboundCalls.add(`${mappedType}::${method}`);
            }
          }

          // Match direct function calls inside symbol body (after opening `{`)
          const bodyStartIdx = sanitizedSlice.indexOf("{");
          const bodySlice = bodyStartIdx !== -1 ? sanitizedSlice.slice(bodyStartIdx + 1) : "";
          if (bodySlice && knownDirectCallables.size > 0) {
            for (const m of bodySlice.matchAll(/(?:^|[^.\w$:])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)) {
              const fnName = m[1];
              if (fnName !== row.name && knownDirectCallables.has(fnName)) {
                outboundCalls.add(fnName);
              }
            }
          }
        }
      } catch {
        // Graceful fallback if file not physically accessible
      }

      const depRepo = new DependencyRepository(this.db);
      connectedFiles = depRepo.getFileConnections(row.file_path,options.workspaceRoot);

      // 4. Resolve Outbound Calls to target symbol line ranges
      for (const call of outboundCalls) {
        try {
          const matches = this.findSymbolsByName(call);
          const target = matches.length === 1 ? matches[0] : undefined;
          if (target) {
            resolvedOutboundCalls.push({
              symbol: call,
              target_file: target.file_path,
              target_range: {
                start_line: target.line_start,
                end_line: target.line_end,
                total_lines: target.line_count,
              },
              domain: target.domain_name,
              is_resolved: true,
            });
          } else {
            resolvedOutboundCalls.push({
              symbol: call,
              is_resolved: false,
            });
          }
        } catch {
          resolvedOutboundCalls.push({
            symbol: call,
            is_resolved: false,
          });
        }
      }
    }

    const complexitySmell: SymbolComplexitySmell | undefined =
      row.line_count > 300
        ? {
            is_high_complexity: true,
            threshold: 300,
            total_lines: row.line_count,
            warning: `Symbol '${row.name}' spans ${row.line_count} lines (exceeds 300-line threshold). Candidate for decomposition/refactoring.`,
          }
        : undefined;

    return {
      symbol_ref: row.symbol_ref,
      visibility_semantics: "legacy_normalized",
      symbol: row.name,
      kind: row.kind,
      file_path: row.file_path,
      domain: row.domain_name,
      exact_range: {
        start_line: row.line_start,
        end_line: row.line_end,
        total_lines: row.line_count,
      },
      signature: row.signature,
      visibility: row.visibility,
      dependencies_injected: Array.from(dependenciesInjected),
      outbound_calls: Array.from(outboundCalls),
      resolved_outbound_calls: resolvedOutboundCalls.length > 0 ? resolvedOutboundCalls.map(call => ({ ...call, derivation: "inferred" as const })) : undefined,
      complexity_smell: complexitySmell,
      sibling_methods: siblingMethods.length > 0 ? siblingMethods : undefined,
      connected_files: connectedFiles,
      ...(shouldIncludeDeps ? { relationships: new DependencyRepository(this.db).getImportRelationships(options.workspaceRoot).filter(edge => edge.source.file === row.file_path) } : {}),
    };
  }

}
