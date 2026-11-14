import * as path from "node:path";
import { blankCommentsAndStrings } from "../../parser/boundary-tracker.ts";
import { probeSourcePath, readSourceDirectory } from "../../resources/source-files.ts";
import { ancestors, fileResult, packageResult, walkFiles, literalString, type ResolutionIO } from "./shared.ts";

function xmlValues(text: string, tag: string): string[] {
  return [...text.replace(new RegExp("<!--[\\s\\S]*?-->", "g"), "").matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))]
    .map(match => literalString(match[1]!.trim().replace(/&amp;/g, "&"), "dynamic_project_path"));
}
function xmlAttributes(text: string, tag: string, attribute: string): string[] {
  return [...text.replace(new RegExp("<!--[\\s\\S]*?-->", "g"), "").matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].flatMap(match => {
    const value = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`).exec(match[1]!);
    return value ? [literalString(value[1]!.replace(/&amp;/g, "&").replace(/\\/g, "/"), "dynamic_project_path")] : [];
  });
}

function javaRoots(io: ResolutionIO, source: string, state: { conditional: boolean }): string[] {
  const testSource = /(?:^|\/)src\/test\//.test(source);
  const dirs = ancestors(io, source);
  const projects = dirs.map(dir => ({ dir, pom: io.read(path.join(dir, "pom.xml")),
    gradle: io.read(path.join(dir, "build.gradle")) ?? io.read(path.join(dir, "build.gradle.kts")) }));
  const nearest = projects.find(project => project.pom !== undefined || project.gradle !== undefined);
  if (!nearest) return [io.root];
  if (nearest.pom !== undefined) {
    const catalog = new Map<string, { directory: string; text: string }>();
    const visit = (directory: string, seen = new Set<string>()): void => {
      io.check(directory);
      if (seen.has(directory) || seen.size > 128) throw new Error("maven_module_cycle_or_limit");
      seen.add(directory);
      const raw = io.read(path.join(directory, "pom.xml")); if (raw === undefined) throw new Error("maven_module_missing");
      const text = raw.replace(new RegExp("<!--[\\s\\S]*?-->", "g"), "");
      catalog.set(directory, { directory, text });
      const modules = xmlValues(text, "module");
      for (const module of modules) visit(path.resolve(directory, module), seen);
    };
    const aggregate = [...projects].reverse().find(project => project.pom !== undefined) ?? nearest;
    visit(aggregate.dir);
    if (!catalog.has(nearest.dir)) visit(nearest.dir);
    const selected = new Set<string>();
    const roots: string[] = [];
    const include = (directory: string): void => {
      if (selected.has(directory)) return;
      selected.add(directory);
      const project = catalog.get(directory)!;
      state.conditional ||= /<(?:profiles|activation)\b/.test(project.text);
      const testRoots = directory === nearest.dir && testSource ? ["src/test/java", ...xmlValues(project.text, "testSourceDirectory")] : [];
      for (const root of ["src/main/java", ...xmlValues(project.text, "sourceDirectory"), ...testRoots]) roots.push(path.resolve(directory, root));
      const active = project.text.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "");
      for (const block of active.matchAll(/<dependency>\s*([\s\S]*?)<\/dependency>/g)) {
        const group = xmlValues(block[1]!, "groupId")[0], artifact = xmlValues(block[1]!, "artifactId")[0];
        const matches = [...catalog.values()].filter(candidate => {
          const header = candidate.text.split(/<(?:dependencies|dependencyManagement|build)>/)[0]!;
          const ids = xmlValues(header, "artifactId");
          return ids.at(-1) === artifact && xmlValues(header, "groupId").includes(group ?? "");
        });
        if (matches.length > 1) throw new Error("maven_project_dependency_ambiguous");
        if (matches[0]) include(matches[0].directory);
      }
    };
    include(nearest.dir); return roots;
  }
  const roots = [path.join(nearest.dir, "src/main/java"), ...(testSource ? [path.join(nearest.dir, "src/test/java")] : [])];
  if (/\bsourceSets\b|\bsrcDirs?\b/.test(nearest.gradle!)) throw new Error("gradle_custom_sources_not_supported");
  const settings = projects.map(project => ({ dir: project.dir,
    text: io.read(path.join(project.dir, "settings.gradle")) ?? io.read(path.join(project.dir, "settings.gradle.kts")) })).find(project => project.text !== undefined);
  const declared = new Set<string>();
  if (settings) {
    if (/\.projectDir\b|\bincludeBuild\b/.test(settings.text!)) throw new Error("gradle_custom_project_layout");
    const mask = blankCommentsAndStrings(settings.text!);
    for (const include of settings.text!.matchAll(/\binclude\b([^\n]+)/g)) {
      if (!/^include\b/.test(mask.slice(include.index!))) continue;
      for (const name of include[1]!.matchAll(/["'](:?[\w:-]+)["']/g)) declared.add(name[1]!.replace(/^:?/, ":"));
    }
  }
  const gradleMask = blankCommentsAndStrings(nearest.gradle!);
  state.conditional ||= /\b(?:if|when|findProperty|providers)\b/.test(gradleMask);
  for (const match of nearest.gradle!.matchAll(/\bproject\s*\(\s*["'](:[\w:-]+)["']\s*\)/g)) {
    if (!/^project\b/.test(gradleMask.slice(match.index!))) continue;
    if (!settings || !declared.has(match[1]!)) throw new Error("gradle_project_not_declared");
    const directory = path.join(settings.dir, match[1]!.slice(1).replace(/:/g, "/"));
    const build = io.read(path.join(directory, "build.gradle")) ?? io.read(path.join(directory, "build.gradle.kts"));
    if (build === undefined || /\bsourceSets\b|\bsrcDirs?\b/.test(build)) throw new Error("gradle_project_sources_not_supported");
    roots.push(path.join(directory, "src/main/java"));
  }
  return roots;
}

export function resolveJava(io: ResolutionIO, target: string, source: string, statement?: string) {
  const raw = (statement ?? target).replace(/^\s*import\s+(?:static\s+)?/, "").replace(/;\s*$/, "").trim();
  if (raw.startsWith("java.")) return io.finish("external", "java_platform_package");
  const wildcard = raw.endsWith(".*");
  const requested = wildcard ? raw.slice(0, -2) : raw;
  const state = { conditional: false };
  const files = [...new Set(javaRoots(io, source, state).flatMap(root => walkFiles(io, root, file => file.endsWith(".java"))))];
  const candidates: string[] = [];
  for (const file of files) {
    const mask = blankCommentsAndStrings(io.read(file)!);
    const pkg = /\bpackage\s+([\w.]+)\s*;/.exec(mask)?.[1] ?? "";
    const types = declarationScopes(mask, /\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g);
    const matchingType = types.find(type => {
      const qualified = [pkg, type.name].filter(Boolean).join(".");
      if (requested === qualified) return true;
      if (!/^\s*import\s+static\b/.test(statement ?? "") || !requested.startsWith(qualified + ".")) return false;
      const member = requested.slice(qualified.length + 1);
      return !member.includes(".") && new RegExp(`\\bstatic\\b[^;{}]*\\b${member}\\b`).test(mask.slice(type.start, type.end));
    });
    if (wildcard && requested === pkg || matchingType)
      candidates.push(path.relative(io.root, file).replace(/\\/g, "/"));
  }
  const result = wildcard && candidates.length ? packageResult(io, candidates, "java_source_package")
    : fileResult(io, candidates, candidates.length ? "java_source_type" : "java_classpath_not_established");
  if (state.conditional) result.coverage = "conditional";
  return result;
}

interface Scope { name: string; start: number; end: number }
function closingBrace(mask: string, open: number): number {
  let depth = 1;
  for (let pos = open + 1; pos < mask.length; pos++) {
    if (mask[pos] === "{") depth++;
    if (mask[pos] === "}" && --depth === 0) return pos;
  }
  return mask.length;
}
function declarationScopes(mask: string, pattern: RegExp, fileScoped = false): Scope[] {
  const scopes: Scope[] = [];
  for (const match of mask.matchAll(pattern)) {
    const parent = scopes.filter(scope => scope.start < match.index! && scope.end > match.index!).at(-1);
    const delimiter = /[;{]/g; delimiter.lastIndex = match.index! + match[0].length;
    const found = delimiter.exec(mask);
    const end = found?.[0] === "{" ? closingBrace(mask, found.index) : fileScoped ? mask.length : found?.index ?? mask.length;
    scopes.push({ name: [parent?.name, match[1]].filter(Boolean).join("."), start: match.index!, end });
  }
  return scopes;
}

function glob(pattern: string, file: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "@@DIR@@").replace(/\*\*/g, "@@ALL@@").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/@@DIR@@/g, "(?:.*/)?").replace(/@@ALL@@/g, ".*");
  return new RegExp(`^${escaped}$`).test(file);
}

export function resolveCSharp(io: ResolutionIO, target: string, source: string, statement?: string) {
  const raw = (statement ?? target).replace(/^\s*(?:global\s+)?using\s+(?:static\s+)?/, "").replace(/;\s*$/, "").trim();
  const requested = (raw.includes("=") ? raw.slice(raw.indexOf("=") + 1).trim() : raw).replace(/^global::/, "");
  const dirs = ancestors(io, source);
  let project: string | undefined;
  for (const dir of dirs) {
    if (probeSourcePath(dir) !== "directory") continue;
    const projects = readSourceDirectory(dir).filter(entry => entry.isFile() && entry.name.endsWith(".csproj")).map(entry => path.join(dir, entry.name));
    if (projects.length > 1) return io.finish("ambiguous", "csharp_source_project_ambiguous");
    if (projects[0]) { project = projects[0]; break; }
  }
  let conditional = false;
  const files = new Set<string>(); const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    if (visited.size >= 128) throw new Error("csharp_project_limit");
    visited.add(file); io.check(file);
    const text = io.read(file); if (text === undefined) throw new Error("csharp_project_missing");
    conditional ||= /\bCondition\s*=|<(?:Import|Choose|Target)\b/.test(text);
    const directory = path.dirname(file);
    const include = xmlAttributes(text, "Compile", "Include");
    const remove = xmlAttributes(text, "Compile", "Remove");
    const defaults = !/<EnableDefaultCompileItems>\s*false\s*<\//.test(text);
    const searchRoots = [directory, ...include.flatMap(pattern => pattern.split(";").map(part => {
      const firstGlob = part.search(/[?*]/);
      return path.dirname(path.resolve(directory, firstGlob < 0 ? part : part.slice(0, firstGlob) + "placeholder"));
    }))];
    for (const sourceFile of [...new Set(searchRoots.flatMap(search => walkFiles(io, search, candidate => candidate.endsWith(".cs"))))]) {
      const rel = path.relative(directory, sourceFile).replace(/\\/g, "/");
      if ((defaults || include.some(pattern => pattern.split(";").some(p => glob(p, rel)))) && !remove.some(pattern => pattern.split(";").some(p => glob(p, rel)))) files.add(sourceFile);
    }
    for (const reference of xmlAttributes(text, "ProjectReference", "Include")) visit(path.resolve(directory, reference));
  };
  if (project) visit(project); else for (const file of walkFiles(io, io.root, file => file.endsWith(".cs"))) files.add(file);
  const matches: string[] = [];
  let namespaceMatch = false;
  const matchedTypes: { file: string; partial: boolean }[] = [];
  for (const file of files) {
    const mask = blankCommentsAndStrings(io.read(file)!);
    conditional ||= /^\s*#\s*(?:if|elif)\b/m.test(mask);
    const namespaces = declarationScopes(mask, /\bnamespace\s+([\w.]+)/g, true);
    const types = declarationScopes(mask, /\b(?:class|interface|struct|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/g);
    const inNamespace = namespaces.some(namespace => namespace.name === requested);
    namespaceMatch ||= inNamespace;
    const declaredType = types.find(type => {
      const owner = namespaces.filter(namespace => namespace.start < type.start && namespace.end > type.start).at(-1);
      return [owner?.name, type.name].filter(Boolean).join(".") === requested;
    });
    if (declaredType) matchedTypes.push({ file, partial: /\bpartial\s*$/.test(mask.slice(Math.max(0, declaredType.start - 32), declaredType.start)) });
    if (inNamespace || declaredType)
      matches.push(path.relative(io.root, file).replace(/\\/g, "/"));
  }
  if (matchedTypes.length > 1 && !matchedTypes.every(type => type.partial) || namespaceMatch && matchedTypes.length)
    return io.finish("ambiguous", "csharp_type_or_namespace_ambiguous");
  if (!matches.length && (requested === "System" || requested.startsWith("System."))) return io.finish("external", "csharp_platform_namespace");
  const result = packageResult(io, matches, matches.length ? "csharp_source_namespace_or_type" : "csharp_namespace_not_established");
  if (conditional) result.coverage = "conditional";
  return result;
}
