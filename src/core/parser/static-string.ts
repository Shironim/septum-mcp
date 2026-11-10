import type Parser from "web-tree-sitter";

// Decode literal values without executing source. Unsupported evaluation stays unresolved.
export function readPythonStaticString(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "concatenated_string") {
    let value = "";
    for (const child of node.namedChildren) {
      if (child.type === "comment") continue;
      const part = readPythonStaticString(child);
      if (part === undefined) return undefined;
      value += part;
    }
    return value;
  }
  if (node.type !== "string") return undefined;
  const match = /^([rRuU]*)("""|'''|"|')([\s\S]*)\2$/.exec(node.text);
  if (!match || node.namedChildren.some(child => child.type === "interpolation")) return undefined;
  const body = match[3];
  if (match[1].toLowerCase().includes("r")) return body;

  let value = "";
  const escapes: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { value += body[i]; continue; }
    const escaped = body[++i];
    if (escaped === undefined) return undefined;
    if (escaped === "\n") continue;
    if (escaped === "\r" && body[i + 1] === "\n") { i++; continue; }
    if (escapes[escaped] !== undefined) { value += escapes[escaped]; continue; }
    if (/[0-7]/.test(escaped)) {
      const octal = body.slice(i).match(/^[0-7]{1,3}/)![0];
      value += String.fromCodePoint(parseInt(octal, 8));
      i += octal.length - 1;
      continue;
    }
    const digits = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
    if (digits) {
      const hex = body.slice(i + 1, i + 1 + digits);
      if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) return undefined;
      const point = parseInt(hex, 16);
      if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return undefined;
      value += String.fromCodePoint(point);
      i += digits;
      continue;
    }
    if (escaped === "N") return undefined; // Unicode names require a Unicode database.
    value += `\\${escaped}`;
  }
  return value;
}
