import * as path from "node:path";
import type {
  FileConnectionsSummary,
  GetSymbolDetailsResponse,
  ImportRelationship,
  ResolvedOutboundCall,
  SymbolCandidate,
  SymbolComplexitySmell,
  SymbolRecord,
  SymbolSelectionOptions,
} from "../../types/index.ts";
import { assertPathContained } from "../resolver/path-resolver.ts";
import { symbolReference } from "../resolver/symbol-reference.ts";
import { probeSourcePath, readSourceFile } from "../resources/source-files.ts";

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
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`])*`/g, '""');
}

export interface SymbolDetailsStore {
  findSymbolsByName(name: string, options?: SymbolSelectionOptions): SymbolCandidate[];
  getSymbolsByFileId(fileId: number): SymbolRecord[];
  findConstructorSignature(fileId: number, classOwner: string): string | null;
  getInternalImportStatements(fileId: number): string[];
  getFileConnections(filePath: string, workspaceRoot?: string): FileConnectionsSummary;
  getImportRelationships(workspaceRoot?: string, sourceFile?: string): ImportRelationship[];
}

export function buildSymbolDetails(
  store: SymbolDetailsStore,
  symbolQuery: string,
  options: SymbolSelectionOptions & { includeDependencies?: boolean; workspaceRoot?: string } = {}
): GetSymbolDetailsResponse | null {
  const trimmed = symbolQuery.trim();
  if (!trimmed) return null;

  const candidates = store.findSymbolsByName(trimmed, options);
  if (candidates.length !== 1) return null;
  const row = candidates[0]!;

  // 1. Sibling methods
  const isRust = /\.rs$/i.test(row.file_path);
  const containerName = row.symbol_ref.container ?? "";
  const owner = ["class", "interface", "trait", "struct", "enum"].includes(row.kind)
    ? row.name
    : row.kind === "method"
      ? containerName
      : "";
  let siblingMethods: string[] = owner
    ? store
        .getSymbolsByFileId(row.file_id)
        .filter((s) => s.kind === "method" && s.id !== row.id)
        .filter(
          (s) =>
            symbolReference({
              ...s,
              file_path: row.file_path,
              indexed_content_hash: row.indexed_content_hash,
            }).container === owner
        )
        .map((s) => s.name.split(/::|[.#]/).pop()!)
    : [];

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
      let token = rawToken
        .trim()
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
          const leftTokens = p
            .slice(0, colonIdx)
            .trim()
            .replace(/^\.{3}/, "")
            .split(/\s+/)
            .filter((t) => !modifierWords.has(t.toLowerCase()));
          const rawParamName = (leftTokens.pop() || "").replace(/\?$/, "").replace(/^\$/, "");
          const typeExpr = p.slice(colonIdx + 1).trim();
          if (typeExpr.startsWith("{") || typeExpr.startsWith("(") || typeExpr.startsWith("[")) continue;
          for (const branch of splitTopLevel(typeExpr, "|")) {
            const trimmedBranch = branch.trim();
            const wrapperMatch = /^(?:Promise|Array|ReadonlyArray|Partial|Required|Readonly)\s*<(.+)>$/s.exec(trimmedBranch);
            registerTypeToken(wrapperMatch ? wrapperMatch[1] : trimmedBranch, rawParamName);
          }
        } else {
          const parts = p
            .replace(/^\.{3}/, "")
            .split(/\s+/)
            .filter((t) => !modifierWords.has(t.toLowerCase()));
          if (parts.length >= 2) {
            if (isGo) {
              registerTypeToken(parts[parts.length - 1], parts[0]);
            } else {
              registerTypeToken(parts[0], parts[1].replace(/^[$&]+/, ""));
            }
          }
        }
      }
    };

    if (!isRust) extractTypeHints(row.signature);

    const classOwner = containerName || (row.kind === "class" ? row.name : "");
    if (classOwner && !isRust) {
      const ctorSig = store.findConstructorSignature(row.file_id, classOwner);
      if (ctorSig) {
        extractTypeHints(ctorSig);
      }
    }

    // 3. Outbound Calls (inspected from physical source file lines if accessible)
    try {
      const fullPath = options.workspaceRoot ? path.resolve(options.workspaceRoot, row.file_path) : row.file_path;
      if (options.workspaceRoot) assertPathContained(fullPath, options.workspaceRoot, "Outbound call source");
      if (probeSourcePath(fullPath) === "file") {
        const fileContent = readSourceFile(fullPath);
        const lines = fileContent.split(/\r?\n/);
        const start = Math.max(0, row.line_start - 1);
        const end = Math.min(lines.length, row.line_end);
        const rawSlice = lines.slice(start, end).join("\n");
        const sanitizedSlice = stripCommentsAndStrings(rawSlice);

        for (const m of sanitizedSlice.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g)) {
          varTypes.set(m[1], m[2]);
        }
        for (const m of sanitizedSlice.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g)) {
          varTypes.set(m[1], m[2]);
        }

        for (const m of sanitizedSlice.matchAll(/([A-Z][a-zA-Z0-9_]+)::([a-zA-Z0-9_]+)\s*\(/g)) {
          if (m[1] !== "self" && m[1] !== "parent" && m[1] !== "static") {
            outboundCalls.add(`${m[1]}::${m[2]}`);
          }
        }

        for (const m of sanitizedSlice.matchAll(/\$this->([a-zA-Z0-9_]+)->([a-zA-Z0-9_]+)\s*\(/g)) {
          const propName = m[1];
          const methodName = m[2];
          const mappedType = varTypes.get(propName);
          const inferredClass = mappedType || propName.charAt(0).toUpperCase() + propName.slice(1);
          outboundCalls.add(`${inferredClass}::${methodName}`);
        }

        for (const m of sanitizedSlice.matchAll(/\bthis\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\(/g)) {
          const propName = m[1];
          const methodName = m[2];
          if (propName !== "db") {
            const mappedType = varTypes.get(propName);
            const inferredClass = mappedType || propName.charAt(0).toUpperCase() + propName.slice(1);
            outboundCalls.add(`${inferredClass}::${methodName}`);
          }
        }

        const isPython = row.file_path.endsWith(".py");
        const className = row.name.includes("::") ? row.name.split("::")[0] : undefined;

        if (isPython) {
          for (const m of sanitizedSlice.matchAll(/\bself\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
            const propName = m[1];
            const methodName = m[2];
            const mappedType = varTypes.get(propName) || propName.charAt(0).toUpperCase() + propName.slice(1);
            outboundCalls.add(`${mappedType}::${methodName}`);
          }
          for (const m of sanitizedSlice.matchAll(/\bself\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
            const methodName = m[1];
            if (className) {
              outboundCalls.add(`${className}::${methodName}`);
            } else {
              outboundCalls.add(methodName);
            }
          }
        }

        const sameFileSymbols = store.getSymbolsByFileId(row.file_id);
        const knownDirectCallables = new Set<string>();
        const knownStaticReceivers = new Set<string>();
        for (const s of sameFileSymbols) {
          if (s.id === row.id) continue;
          if (s.kind === "function") knownDirectCallables.add(s.name);
          else if (s.kind === "class") knownStaticReceivers.add(s.name);
        }

        for (const stmt of store.getInternalImportStatements(row.file_id)) {
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
          // Python: from x import a, B as C
          const pyFromMatch = stmt.match(/^\s*from\s+[\w.]+\s+import\s+(.+)$/);
          if (pyFromMatch) {
            for (const item of pyFromMatch[1].replace(/[()]/g, "").split(",")) {
              const trimmed = item.trim();
              if (!trimmed) continue;
              const aliasParts = trimmed.split(/\s+as\s+/);
              const localName = (aliasParts[1] || aliasParts[0] || "").trim();
              if (/^[a-z_][a-zA-Z0-9_]*$/.test(localName)) knownDirectCallables.add(localName);
              else if (/^[A-Z][a-zA-Z0-9_]*$/.test(localName)) knownStaticReceivers.add(localName);
            }
          }
          // Python: import foo as bar
          const pyImportMatch = stmt.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
          if (pyImportMatch) {
            const localName = pyImportMatch[2] || pyImportMatch[1].split(".").pop() || "";
            if (/^[a-z_][a-zA-Z0-9_]*$/.test(localName)) knownDirectCallables.add(localName);
            else if (/^[A-Z][a-zA-Z0-9_]*$/.test(localName)) knownStaticReceivers.add(localName);
          }
        }

        for (const m of sanitizedSlice.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)) {
          const receiver = m[1];
          const method = m[2];
          if (
            receiver === "this" || receiver === "super" || receiver === "console" || receiver === "process" ||
            receiver === "Math" || receiver === "JSON" || receiver === "Object" || receiver === "Array" ||
            receiver === "Buffer" || receiver === "Promise" || receiver === "Number" || receiver === "String"
          ) continue;
          const mappedType = varTypes.get(receiver);
          if (mappedType) outboundCalls.add(`${mappedType}::${method}`);
          else if (knownStaticReceivers.has(receiver)) outboundCalls.add(`${receiver}::${method}`);
        }
        for (const m of sanitizedSlice.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
          const receiver = m[1];
          if (receiver === "this") continue;
          const mappedType = varTypes.get(receiver);
          if (mappedType) outboundCalls.add(`${mappedType}::${m[2]}`);
        }

        let bodySlice = "";
        if (isPython) {
          const colonIdx = sanitizedSlice.indexOf(":");
          bodySlice = colonIdx !== -1 ? sanitizedSlice.slice(colonIdx + 1) : sanitizedSlice;
        } else {
          const bodyStartIdx = sanitizedSlice.indexOf("{");
          bodySlice = bodyStartIdx !== -1 ? sanitizedSlice.slice(bodyStartIdx + 1) : "";
        }
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

    connectedFiles = store.getFileConnections(row.file_path, options.workspaceRoot);

    for (const call of outboundCalls) {
      try {
        const matches = store.findSymbolsByName(call);
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
          resolvedOutboundCalls.push({ symbol: call, is_resolved: false });
        }
      } catch {
        resolvedOutboundCalls.push({ symbol: call, is_resolved: false });
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
    resolved_outbound_calls:
      resolvedOutboundCalls.length > 0
        ? resolvedOutboundCalls.map((call) => ({ ...call, derivation: "inferred" as const }))
        : undefined,
    complexity_smell: complexitySmell,
    sibling_methods: siblingMethods.length > 0 ? siblingMethods : undefined,
    connected_files: connectedFiles,
    ...(options.includeDependencies === true
      ? {
          relationships: store
            .getImportRelationships(options.workspaceRoot, row.file_path)
            .filter((edge) => edge.source.file === row.file_path),
        }
      : {}),
  };
}
