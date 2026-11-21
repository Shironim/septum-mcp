export function extractImportedSymbolNames(statement: string): string[] {
  if (!statement) return [];
  const names = new Set<string>();
  const braceMatch = statement.match(/\{([^}]+)\}/);
  if (braceMatch) {
    for (const spec of braceMatch[1].split(",")) {
      const cleaned = spec.trim().replace(/^type\s+/, "");
      const parts = cleaned.split(/\s+as\s+/);
      for (const p of parts) {
        const id = p.trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) names.add(id);
      }
    }
  }
  const defaultMatch = statement.match(/^\s*import\s+(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s+from\b/);
  if (defaultMatch) names.add(defaultMatch[1]);
  const pyMatch = statement.match(/\bfrom\s+[^\s]+\s+import\s+([^;(\n]+)/);
  if (pyMatch) {
    for (const spec of pyMatch[1].split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      const id = (parts[0] || "").trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) names.add(id);
    }
  }
  const phpMatch = statement.match(/^\s*use\s+(?:function\s+|const\s+)?[A-Za-z0-9_\\]+\\([A-Za-z0-9_]+)/);
  if (phpMatch) names.add(phpMatch[1]);
  return Array.from(names);
}

/**
 * Detect generic pipeline stage from file path and archetype.
 */
export function detectPipelineStage(filePath: string, archetype: string): string {
  const norm = filePath.toLowerCase();

  if (
    archetype === "validation" ||
    archetype === "dto" ||
    /validation|middleware|dto|request|schema/i.test(norm)
  ) {
    return "validation";
  }

  if (archetype === "controller" || /controller|handler/i.test(norm)) {
    return "controller";
  }

  if (
    archetype === "service" ||
    archetype === "use_case" ||
    /use-?cases?|interactor|application|workflow/i.test(norm)
  ) {
    return "use_case";
  }

  if (
    archetype === "model" ||
    archetype === "entity" ||
    /domain|entities|entity|aggregate/i.test(norm)
  ) {
    return "entity";
  }

  if (
    archetype === "repository" ||
    /repositories|repository|database|persistence|egress|adapter/i.test(norm)
  ) {
    return "repository";
  }

  return "service";
}
