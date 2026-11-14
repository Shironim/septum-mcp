import * as path from "node:path";
import { blankCommentsAndStrings } from "../../parser/boundary-tracker.ts";
import { ancestors, existingFiles, fileResult, packageResult, toml, type ResolutionIO } from "./shared.ts";

interface Module { file: string; name: string[]; mask: string; children: Map<string, Module> }
function modules(io: ResolutionIO, file: string, name: string[], state: { count: number; conditional: boolean }, active = new Set<string>(), body?: string, inlineDirectory?: string): Module {
  if (++state.count > 256 || name.length > 32) throw new Error("rust_module_limit");
  if (body === undefined && active.has(file)) throw new Error("rust_module_cycle");
  const source = body ?? io.read(file);
  if (source === undefined) throw new Error("rust_module_file_missing");
  if (/#\s*\[\s*(?:cfg|cfg_attr)\b/.test(source)) state.conditional = true;
  const mask = blankCommentsAndStrings(source.replace(/'[A-Za-z_]\w*\b(?!')/g, value => " " + value.slice(1)));
  const directory = inlineDirectory ?? (/^(?:lib|main|mod)\.rs$/.test(path.basename(file)) ? path.dirname(file) : file.replace(/\.rs$/, ""));
  const result: Module = { file, name, mask, children: new Map() };
  const children = /\bmod\s+([A-Za-z_]\w*)\s*([;{])/g;
  let match: RegExpExecArray | null; let scanned = 0; let depth = 0;
  while ((match = children.exec(mask))) {
    for (; scanned < match.index; scanned++) { if (mask[scanned] === "{") depth++; if (mask[scanned] === "}") depth--; }
    if (depth !== 0) continue;
    const childName = match[1]!;
    if (match[2] === "{") {
      const open = children.lastIndex - 1; let end = open + 1, nesting = 1;
      for (; end < mask.length && nesting; end++) { if (mask[end] === "{") nesting++; if (mask[end] === "}") nesting--; }
      if (nesting) throw new Error("rust_unclosed_module");
      result.children.set(childName, modules(io, file, [...name, childName], state, active, source.slice(open + 1, end - 1), path.join(directory, childName)));
      children.lastIndex = end; scanned = end;
    } else {
      const prior = source.slice(Math.max(0, match.index - 160), match.index);
      const attr = /#\s*\[\s*path\s*=\s*"([^"\n]+)"\s*\]\s*(?:pub(?:\([^)]*\))?\s*)?$/.exec(prior);
      const candidates = attr ? [path.resolve(path.dirname(file), attr[1]!)]
        : [path.join(directory, childName + ".rs"), path.join(directory, childName, "mod.rs")];
      const files = existingFiles(io, candidates);
      if (files.length !== 1) throw new Error(files.length ? "rust_ambiguous_module" : "rust_module_file_missing");
      result.children.set(childName, modules(io, path.resolve(io.root, files[0]!), [...name, childName], state, new Set([...active, file])));
    }
  }
  return result;
}

export function resolveRust(io: ResolutionIO, target: string, source: string) {
  const dirs = ancestors(io, source);
  const manifests = dirs.map(dir => ({ dir, text: io.read(path.join(dir, "Cargo.toml")) }));
  const own = manifests.find(entry => entry.text !== undefined && toml(entry.text).package);
  if (!own) return io.finish("unsupported", "cargo_package_missing");
  const cargo = toml(own.text!);
  const workspace = manifests.find(entry => entry.text !== undefined && toml(entry.text).workspace);
  const inherited = workspace ? toml(workspace.text!).workspace.dependencies ?? {} : {};
  const deps: Record<string, any> = { ...cargo.dependencies, ...cargo["dev-dependencies"], ...cargo["build-dependencies"] };
  const conditional = Object.values(cargo.target ?? {}).some((config: any) => Object.keys(config.dependencies ?? {}).some(name => target === name || target.startsWith(name + "::")));
  for (const cfg of Object.values(cargo.target ?? {}) as any[]) Object.assign(deps, cfg.dependencies);
  const parts = target.replace(/^mod:/, "").split("::");
  const first = parts[0]!;
  if (["std", "core", "alloc"].includes(first)) return io.finish("external", "rust_standard_library");
  const depKey = Object.keys(deps).find(name => name.replace(/-/g, "_") === first);
  if (depKey) {
    let dependency = deps[depKey]; let owner = own.dir;
    if (dependency?.workspace === true) {
      const base = inherited[depKey];
      if (base === undefined) return io.finish("unsupported", "cargo_workspace_dependency_missing");
      dependency = { ...(typeof base === "string" ? { version: base } : base), ...dependency };
      owner = workspace?.dir ?? own.dir;
    }
    if (dependency === undefined) return io.finish("unsupported", "cargo_workspace_dependency_missing");
    if (typeof dependency !== "string" && typeof dependency !== "object") return io.finish("unsupported", "malformed_cargo_dependency");
    if (!dependency.path) {
      const result = io.finish("external", "cargo_manifest_dependency"); if (conditional || dependency.optional) result.coverage = "conditional"; return result;
    }
    const directory = path.resolve(owner, dependency.path); io.check(directory);
    const text = io.read(path.join(directory, "Cargo.toml"));
    if (!text) return io.finish("unresolved", "cargo_path_dependency_missing");
    const lib = toml(text).lib?.path ?? "src/lib.rs";
    const root = path.resolve(directory, lib); io.check(root);
    const state = { count: 0, conditional: conditional || Boolean(dependency.optional) };
    const tree = modules(io, root, [], state);
    return select(io, tree, tree, parts.slice(1), state.conditional);
  }
  const rootFiles = existingFiles(io, [path.resolve(own.dir, cargo.lib?.path ?? "src/lib.rs"), path.join(own.dir, "src/main.rs"),
    ...(cargo.bin ?? []).flatMap((bin: any) => typeof bin.path === "string" ? [path.resolve(own.dir, bin.path)] : [])]);
  const matches: { root: Module; current: Module; conditional: boolean }[] = [];
  for (const file of rootFiles) {
    const state = { count: 0, conditional: false };
    const tree = modules(io, path.resolve(io.root, file), [], state);
    const visit = (node: Module) => {
      if (path.relative(io.root, node.file).replace(/\\/g, "/") === source) matches.push({ root: tree, current: node, conditional: state.conditional });
      for (const child of node.children.values()) visit(child);
    };
    visit(tree);
  }
  // Inline modules need a declaration span to distinguish multiple contexts in one file.
  const contexts = parts[0] === "crate" ? matches.filter(match => match.current === match.root || !matches.some(other => other.root === match.root && other.current === other.root)) : matches;
  if (contexts.length !== 1) return io.finish(contexts.length ? "ambiguous" : "unresolved", "rust_source_module_not_unique");
  const match = contexts[0]!;
  if (target.startsWith("mod:")) return select(io, match.root, match.current, parts, match.conditional);
  if (first === "crate") return select(io, match.root, match.root, parts.slice(1), match.conditional);
  if (first === "self") return select(io, match.root, match.current, parts.slice(1), match.conditional);
  if (first === "super") {
    let count = 0; while (parts[count] === "super") count++;
    if (count > match.current.name.length) return io.finish("unresolved", "rust_super_outside_crate");
    let parent = match.root;
    for (const name of match.current.name.slice(0, -count)) parent = parent.children.get(name)!;
    return select(io, match.root, parent, parts.slice(count), match.conditional);
  }
  return select(io, match.root, match.root, parts, match.conditional);
}

function select(io: ResolutionIO, _root: Module, start: Module, parts: string[], conditional: boolean) {
  let node = start; let index = 0;
  for (; index < parts.length && node.children.has(parts[index]!); index++) node = node.children.get(parts[index]!)!;
  const rest = parts.slice(index);
  if (rest.length > 1) return io.finish("unsupported", "rust_associated_item_not_resolved");
  let declared = false;
  const declarations = /\b(?:struct|enum|trait|type|fn|const|static|mod)\s+([A-Za-z_]\w*)/g;
  let position = 0, depth = 0;
  for (const declaration of node.mask.matchAll(declarations)) {
    for (; position < declaration.index!; position++) {
      if (node.mask[position] === "{") depth++;
      if (node.mask[position] === "}") depth--;
    }
    if (depth === 0 && declaration[1] === rest[0]) declared = true;
  }
  if (rest.length && rest[0] !== "*" && !declared)
    return io.finish("unresolved", "rust_item_or_reexport_not_resolved");
  const file = path.relative(io.root, node.file).replace(/\\/g, "/");
  const result = rest[0] === "*" ? packageResult(io, [file, ...[...node.children.values()].map(child => path.relative(io.root, child.file).replace(/\\/g, "/"))], "rust_module_glob") : fileResult(io, [file], "rust_module_item");
  if (conditional) result.coverage = "conditional";
  return result;
}
