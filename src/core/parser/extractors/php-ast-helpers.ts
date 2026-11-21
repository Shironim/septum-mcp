import type Parser from "web-tree-sitter";

type Node = Parser.SyntaxNode;

export function children(node?: Node | null): Node[] {
  return node?.namedChildren.filter(child => child.type !== "comment") ?? [];
}

export function literal(node?: Node): string | undefined {
  if (node?.type === "string") return node.text.slice(1, -1).replace(/\\([\\'])/g, "$1");
  if (node?.type === "encapsed_string" && children(node).every(child => child.type === "string_content")) {
    const value = node.text.slice(1, -1);
    if (!value.includes("\\")) return value;
  }
  return undefined;
}

export function phpSections(root: Node): Array<{ namespace: string; statements: Node[] }> {
  const sections = [{ namespace: "", statements: [] as Node[] }];
  for (const node of children(root)) {
    if (node.type !== "namespace_definition") {
      sections.at(-1)!.statements.push(node);
      continue;
    }
    const namespace = node.childForFieldName("name")?.text ?? "";
    const body = node.childForFieldName("body");
    sections.push({ namespace, statements: children(body) });
    if (body) sections.push({ namespace: "", statements: [] });
  }
  return sections;
}

export function importsFor(statements: Node[]): Map<string, string | null> {
  const imports = new Map<string, string | null>();
  for (const node of statements) {
    if (node.type !== "namespace_use_declaration" || /^use\s+(?:function|const)\b/i.test(node.text)) continue;
    const group = children(node).find(child => child.type === "namespace_use_group");
    const prefix = group ? children(node).find(child => child.type === "namespace_name")?.text : undefined;
    for (const clause of group ? children(group) : children(node)) {
      if (!["namespace_use_clause", "namespace_use_group_clause"].includes(clause.type) ||
          /^(?:function|const)\s/i.test(clause.text)) continue;
      const targetNode = children(clause).find(child => ["name", "qualified_name", "namespace_name"].includes(child.type));
      if (!targetNode) continue;
      const target = [prefix, targetNode.text].filter(Boolean).join("\\").replace(/^\\/, "");
      const alias = children(clause).find(child => child.type === "namespace_aliasing_clause");
      const key = (alias?.namedChild(0)?.text ?? target.split("\\").at(-1)!).toLowerCase();
      imports.set(key, imports.has(key) ? null : target);
    }
  }
  return imports;
}
