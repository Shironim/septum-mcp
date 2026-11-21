import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { blankCommentsAndStrings, calculateControlFlowNesting, findBraceBlockEnd } from "../boundary-tracker.ts";

export function extractTypeScriptFallback(content: string): ParsedFileAST {
  const symbols: ExtractedSymbol[] = [];
  const dependencies: ExtractedDependency[] = [];

  const rawLines = content.split("\n");
  const cleanContent = blankCommentsAndStrings(content);
  const cleanLines = cleanContent.split("\n");

  const importRegex =
    /^\s*(?:(?:import|export)\s+(?:type\s+)?(?:([\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]|(?:const|let|var)\s+([\w\s{},:$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/;

  for (let i = 0; i < rawLines.length; i++) {
    if (!cleanLines[i]?.trim()) continue;
    const line = rawLines[i];
    const match = importRegex.exec(line);
    if (match) {
      const target = match[2] || match[4] || match[5];
      const clause = match[1] || match[3] || "";
      if (target) {
        const importedSymbols = clause
          .replace(/[{}*]/g, " ")
          .split(/,|\bas\b/)
          .map((s) => s.trim())
          .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) && s !== "type");
        const isExternal = !target.startsWith(".") && !target.startsWith("/");
        dependencies.push({
          target,
          statement: line.trim(),
          line_number: i + 1,
          is_external: isExternal,
          ...(importedSymbols.length > 0 ? { imported_symbols: Array.from(new Set(importedSymbols)) } : {}),
        });
      }
    }
  }

  let currentClass: string | null = null;
  let currentClassDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < cleanLines.length; i++) {
    const cleanTrimmed = cleanLines[i].trim();
    const rawTrimmed = rawLines[i].trim();
    const lineNum = i + 1;

    if (currentClass && braceDepth < currentClassDepth) {
      currentClass = null;
      currentClassDepth = 0;
    }

    if (cleanTrimmed && braceDepth === 0) {
      const classMatch =
        /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?\b(class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(
          cleanTrimmed
        );
      if (classMatch) {
        currentClass = classMatch[2];
        currentClassDepth = braceDepth + 1;
        const endLine = findBraceBlockEnd(cleanLines, i);
        symbols.push({
          name: classMatch[2],
          kind: classMatch[1] as "class" | "interface",
          signature: rawTrimmed.replace(/\{$/, "").trim(),
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
      } else {
        const typeMatch = /^(?:export\s+)?\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\b\s*=/.exec(cleanTrimmed);
        if (typeMatch) {
          const endLine = cleanTrimmed.endsWith(";") ? lineNum : findBraceBlockEnd(cleanLines, i);
          symbols.push({
            name: typeMatch[1],
            kind: "type",
            signature: rawTrimmed.replace(/;$/, "").trim(),
            visibility: "public",
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
          });
        }

        const enumMatch = /^(?:export\s+)?(?:const\s+)?\benum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(cleanTrimmed);
        if (enumMatch) {
          const endLine = findBraceBlockEnd(cleanLines, i);
          symbols.push({
            name: enumMatch[1],
            kind: "enum",
            signature: rawTrimmed.replace(/\{$/, "").trim(),
            visibility: "public",
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
          });
        }

        const fnMatch =
          /^(?:export\s+)?(?:default\s+)?(?:async\s+)?\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(
            cleanTrimmed
          );
        if (fnMatch) {
          const name = fnMatch[1];
          const params = fnMatch[2];
          const retType = fnMatch[3] ? `: ${fnMatch[3].trim()}` : "";
          const endLine = findBraceBlockEnd(cleanLines, i);
          const nestingDepth = calculateControlFlowNesting(rawLines, i, endLine - 1);
          symbols.push({
            name,
            kind: "function",
            signature: `${name}(${params})${retType}`,
            visibility: "public",
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
            nesting_depth: nestingDepth,
          });
        }

        const varMatch =
          /^(?:export\s+)?\b(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*([^=;]+))?\s*=\s*(.*)$/.exec(
            cleanTrimmed
          );
        if (varMatch) {
          const declKind = varMatch[1];
          const varName = varMatch[2];
          const typeStr = varMatch[3] ? `: ${varMatch[3].trim()}` : "";
          const rhs = varMatch[4].trim();
          const isArrowOrFn = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^function\b/.test(rhs);
          symbols.push({
            name: varName,
            kind: isArrowOrFn ? "function" : declKind === "const" ? "constant" : "variable",
            signature: `${declKind} ${varName}${typeStr}`,
            visibility: cleanTrimmed.startsWith("export ") ? "public" : "private",
            line_start: lineNum,
            line_end: lineNum,
            line_count: 1,
          });
        }
      }
    } else if (cleanTrimmed && currentClass && braceDepth === currentClassDepth) {
      const methodMatch =
        /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(
          cleanTrimmed
        );
      if (
        methodMatch &&
        !["if", "for", "while", "switch", "catch", "function", "return"].includes(methodMatch[2])
      ) {
        const vis = (methodMatch[1] as Visibility) || "public";
        const name = methodMatch[2];
        const params = methodMatch[3];
        const retType = methodMatch[4] ? `: ${methodMatch[4].trim()}` : "";
        const endLine = findBraceBlockEnd(cleanLines, i);
        const nestingDepth = calculateControlFlowNesting(rawLines, i, endLine - 1);
        symbols.push({
          name: `${currentClass}::${name}`,
          kind: "method",
          signature: `${vis} ${name}(${params})${retType}`,
          visibility: vis,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
          nesting_depth: nestingDepth,
        });
      } else {
        const propMatch =
          /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:readonly\s+)?\b([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\?|\!)?\s*(?::\s*([^;={]+))?(?:\s*=[^;]+)?;\s*$/.exec(
            cleanTrimmed
          );
        if (
          propMatch &&
          !["return", "const", "let", "var", "throw", "import", "export", "continue", "break"].includes(
            propMatch[2]
          )
        ) {
          const vis = (propMatch[1] as Visibility) || "public";
          const propName = propMatch[2];
          const typeStr = propMatch[3] ? `: ${propMatch[3].trim()}` : "";
          symbols.push({
            name: `${currentClass}::${propName}`,
            kind: "property",
            signature: `${vis} ${propName}${typeStr}`,
            visibility: vis,
            line_start: lineNum,
            line_end: lineNum,
            line_count: 1,
          });
        }
      }
    }

    for (const ch of cleanLines[i]) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
    if (currentClass && braceDepth < currentClassDepth) {
      currentClass = null;
      currentClassDepth = 0;
    }
  }

  return { symbols, dependencies };
}
