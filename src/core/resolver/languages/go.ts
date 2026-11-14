import * as path from "node:path";
import { probeSourcePath, readSourceDirectory } from "../../resources/source-files.ts";
import { ancestors, packageResult, type ResolutionIO } from "./shared.ts";

interface Replace { from: string; version?: string; to: string; remoteVersion?: string; directory: string }
function tokens(line: string): string[] {
  const clean = line.replace(/"(?:\\.|[^"\\])*"|\/\/.*$/g, token => token.startsWith('"') ? token : "");
  return (clean.match(/"(?:\\.|[^"\\])*"|[^\s]+/g) ?? []).map(token => token.startsWith('"') ? JSON.parse(token) : token);
}
function directives(text: string, kind: string): string[][] {
  const result: string[][] = []; let block = false;
  for (const line of text.split(/\r?\n/)) {
    const parts = tokens(line); if (!parts.length) continue;
    if (parts[0] === ")") { block = false; continue; }
    if (parts[0] === kind) {
      if (parts[1] === "(") block = true;
      else result.push(parts.slice(1));
    } else if (block) result.push(parts);
  }
  return result;
}
function replacements(text: string, directory: string): Replace[] {
  return directives(text, "replace").map(parts => {
    const arrow = parts.indexOf("=>");
    if (![1, 2].includes(arrow) || ![arrow + 2, arrow + 3].includes(parts.length)) throw new Error("malformed_go_replace");
    return { from: parts[0]!, version: arrow === 2 ? parts[1] : undefined, to: parts[arrow + 1]!, remoteVersion: parts[arrow + 2], directory };
  });
}
function moduleName(text: string): string {
  const names = directives(text, "module");
  if (names.length !== 1 || names[0]!.length !== 1) throw new Error("malformed_go_mod");
  return names[0]![0]!;
}

export function resolveGo(io: ResolutionIO, target: string, source: string, stdlib: ReadonlySet<string>) {
  const dirs = ancestors(io, source);
  const mods = dirs.map(dir => ({ dir, text: io.read(path.join(dir, "go.mod")) }));
  const own = mods.find(mod => mod.text !== undefined);
  if (!own) return io.finish("unsupported", "go_mod_missing");
  const ownName = moduleName(own.text!);
  const matches = (name: string) => target === name || target.startsWith(name + "/");
  if (!matches(ownName) && stdlib.has(target.split("/")[0]!)) return io.finish("external", "go_standard_library");
  const works = dirs.map(dir => ({ dir, text: io.read(path.join(dir, "go.work")) }));
  const work = works.find(work => work.text !== undefined);
  const modules = new Map<string, string[]>();
  const addModule = (dir: string, text?: string) => {
    io.check(dir);
    const content = text ?? io.read(path.join(dir, "go.mod"));
    if (content === undefined) throw new Error("go_workspace_module_missing");
    const name = moduleName(content);
    modules.set(name, [...new Set([...(modules.get(name) ?? []), dir])]);
  };
  if (work) {
    for (const use of directives(work.text!, "use")) {
      if (use.length !== 1) throw new Error("malformed_go_work_use");
      addModule(path.resolve(work.dir, use[0]!));
    }
    if (!modules.get(ownName)?.includes(own.dir)) return io.finish("unsupported", "go_source_module_not_in_workspace");
  } else addModule(own.dir, own.text);
  const required = new Map(directives(own.text!, "require").map(parts => [parts[0]!, parts[1]]));
  const moduleReplaces = replacements(own.text!, own.dir);
  const workReplaces = work ? replacements(work.text!, work.dir) : [];
  const allNames = [...new Set([...modules.keys(), ...moduleReplaces.map(r => r.from), ...workReplaces.map(r => r.from)])]
    .filter(matches).sort((a, b) => b.length - a.length);
  const name = allNames[0];
  if (name) {
    const select = (entries: Replace[]) => entries.filter(r => r.from === name && (!r.version || r.version === required.get(name)))
      .sort((a, b) => Number(Boolean(b.version)) - Number(Boolean(a.version)));
    const candidates = select(workReplaces).length ? select(workReplaces) : select(moduleReplaces);
    const replacement = candidates[0];
    if (candidates.length > 1 && candidates[1]!.version === replacement!.version) return io.finish("ambiguous", "multiple_go_replacements");
    let roots = modules.get(name) ?? [];
    if (replacement) {
      if (!modules.has(name) && !required.has(name)) return io.finish("unresolved", "go_module_not_required");
      if (replacement.remoteVersion) return required.has(name) ? io.finish("external", "go_replaced_required_module") : io.finish("unresolved", "go_module_not_required");
      if (!replacement.to.startsWith(".") && !path.isAbsolute(replacement.to)) return io.finish("unsupported", "go_replace_target_not_local");
      roots = [path.resolve(replacement.directory, replacement.to)];
      io.check(roots[0]!);
      if (io.read(path.join(roots[0]!, "go.mod")) === undefined) return io.finish("unresolved", "go_replacement_module_missing");
    }
    if (roots.length !== 1) return io.finish(roots.length ? "ambiguous" : "unresolved", "go_module_root_not_unique");
    const root = roots[0]!;
    const directory = path.resolve(root, target.slice(name.length).replace(/^\//, "")); io.check(directory);
    for (let dir = directory; dir !== root; dir = path.dirname(dir)) {
      if (!dir.startsWith(root + path.sep)) return io.finish("unsupported", "outside_module");
      if (io.read(path.join(dir, "go.mod")) !== undefined) return io.finish("unsupported", "nested_go_mod");
    }
    if (probeSourcePath(directory) !== "directory") return io.finish("unresolved", "go_package_missing");
    const files: string[] = []; let conditional = false;
    for (const entry of readSourceDirectory(directory)) {
      if (!entry.name.endsWith(".go") || entry.name.endsWith("_test.go")) continue;
      const file = path.join(directory, entry.name); io.check(file);
      const content = io.read(file); if (content === undefined) continue;
      conditional ||= /^\s*\/\/\s*(?:go:build|\+build)\b/m.test(content) || /_(?:linux|windows|darwin|freebsd|openbsd|netbsd|android|ios|amd64|arm64|386|arm)(?:_(?:amd64|arm64|386|arm))?\.go$/.test(entry.name);
      files.push(path.relative(io.root, file).replace(/\\/g, "/"));
    }
    const result = packageResult(io, files, files.length ? "go_module_package" : "go_package_empty");
    if (conditional) result.coverage = "conditional";
    return result;
  }
  if ([...required.keys()].some(matches)) return io.finish("external", "go_required_module");
  return io.finish("unresolved", "go_module_not_declared");
}
