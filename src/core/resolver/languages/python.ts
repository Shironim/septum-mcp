import * as path from "node:path";
import { ancestors, existingFiles, fileResult, toml, type ResolutionIO } from "./shared.ts";

const DIST_MODULES: Record<string, string[]> = {
  pillow: ["pil"], pyyaml: ["yaml"], python_dotenv: ["dotenv"], scikit_learn: ["sklearn"],
  beautifulsoup4: ["bs4"], opencv_python: ["cv2"], protobuf: ["google"], typing_extensions: ["typing_extensions"],
  pyjwt: ["jwt"], python_jose: ["jose"], python_dateutil: ["dateutil"], django_rest_framework: ["rest_framework"],
  djangorestframework: ["rest_framework"], psycopg2_binary: ["psycopg2"], opencv_python_headless: ["cv2"],
  graphql_core: ["graphql"], graphql: ["graphql"], graphene: ["graphene"], strawberry_graphql: ["strawberry"],
};
const manifests = ["requirements.txt", "pyproject.toml", "Pipfile", "poetry.lock", "uv.lock", "Pipfile.lock"];
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "_");

function distribution(value: string): string | undefined {
  return /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(value)?.[1];
}

function declaredDependencies(io: ResolutionIO, owner: string): { packages: Set<string>; local: Map<string, string> } {
  const cacheKey = `py_deps:${owner}`;
  const cached = io.cache?.get(cacheKey) as { packages: Set<string>; local: Map<string, string>; files: string[] } | undefined;
  if (cached) {
    // Still touch manifests via io.read so config_revision reflects all observed manifests
    for (const file of cached.files) io.read(file);
    return cached;
  }
  const observedFiles: string[] = [];
  const readManifest = (file: string): string | undefined => {
    observedFiles.push(file);
    return io.read(file);
  };
  const packages = new Set<string>();
  const local = new Map<string, string>();
  const add = (name: string) => { packages.add(normalize(name)); };
  const requirementFile = (file: string, visited = new Set<string>()): void => {
    if (visited.has(file) || visited.size >= 64) throw new Error("python_requirements_cycle_or_limit");
    visited.add(file);
    const text = readManifest(file);
    if (text === undefined) throw new Error("python_requirements_include_missing");
    for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const include = /^(?:-r\s*|--requirement(?:=|\s+))(.+)$/.exec(line);
      if (include) { requirementFile(path.resolve(path.dirname(file), include[1]!.trim()), new Set(visited)); continue; }
      // Constraints restrict versions but do not declare installed distributions.
      if (line.startsWith("-")) continue;
      const name = distribution(line); if (name) add(name);
    }
  };
  if (readManifest(path.join(owner, "requirements.txt")) !== undefined) requirementFile(path.join(owner, "requirements.txt"));
  const projectText = readManifest(path.join(owner, "pyproject.toml"));
  if (projectText !== undefined) {
    const project = toml(projectText);
    const arrays = [project.project?.dependencies, ...Object.values(project.project?.["optional-dependencies"] ?? {}),
      ...Object.values(project["dependency-groups"] ?? {})];
    for (const values of arrays) {
      if (values === undefined) continue;
      if (!Array.isArray(values)) throw new Error("malformed_python_dependencies");
      for (const value of values) if (typeof value === "string") { const name = distribution(value); if (name) add(name); }
    }
    const poetry = project.tool?.poetry;
    for (const group of [poetry?.dependencies, poetry?.["dev-dependencies"],
      ...Object.values(poetry?.group ?? {}).map((group: any) => group.dependencies)]) {
      for (const [name, value] of Object.entries(group ?? {})) if (name !== "python") {
        add(name);
        if (typeof (value as any)?.path === "string") local.set(normalize(name), path.resolve(owner, (value as any).path));
      }
    }
  }
  const pipfile = readManifest(path.join(owner, "Pipfile"));
  if (pipfile !== undefined) {
    const parsed = toml(pipfile);
    for (const group of [parsed.packages, parsed["dev-packages"]]) for (const [name, value] of Object.entries(group ?? {})) {
      add(name); if (typeof (value as any)?.path === "string") local.set(normalize(name), path.resolve(owner, (value as any).path));
    }
  }
  for (const name of ["poetry.lock", "uv.lock"]) {
    const text = readManifest(path.join(owner, name));
    if (text === undefined) continue;
    const locked = toml(text).package;
    if (!Array.isArray(locked)) throw new Error("malformed_python_lockfile");
    for (const pkg of locked) if (typeof pkg.name === "string") {
      add(pkg.name);
      const location = pkg.source?.editable ?? pkg.source?.directory ?? pkg.source?.virtual ??
        (pkg.source?.type === "directory" ? pkg.source.url : undefined);
      if (typeof location === "string") local.set(normalize(pkg.name), path.resolve(owner, location));
    }
  }
  const piplock = readManifest(path.join(owner, "Pipfile.lock"));
  if (piplock !== undefined) {
    const parsed = JSON.parse(piplock);
    for (const group of [parsed.default, parsed.develop]) for (const [name, value] of Object.entries(group ?? {})) {
      add(name); if (typeof (value as any)?.path === "string") local.set(normalize(name), path.resolve(owner, (value as any).path));
    }
  }
  const result = { packages, local, files: [...new Set(observedFiles)] };
  io.cache?.set(cacheKey, result);
  return result;
}

export function resolvePython(io: ResolutionIO, target: string, source: string, roots: string[], stdlib: ReadonlySet<string>) {
  const dirs = ancestors(io, source);
  if (target.startsWith(".")) {
    const dots = /^\.+/.exec(target)![0].length;
    const rest = target.slice(dots).replace(/\./g, path.sep);
    const base = path.resolve(dirs[0]!, "../".repeat(dots - 1), rest);
    return fileResult(io, existingFiles(io, [...(rest ? [base + ".py"] : []), path.join(base, "__init__.py")]), "python_relative_module");
  }
  let owner = io.root;
  for (const dir of dirs) {
    // Observe absent manifests too, so later creation invalidates the selection.
    const present = manifests.map(file => io.read(path.join(dir, file)) !== undefined);
    if (present.some(Boolean)) { owner = dir; break; }
  }
  const top = target.split(".")[0]!;
  if (stdlib.has(top)) return io.finish("external", "python_standard_library");
  const { packages, local: dependencyPaths } = declaredDependencies(io, owner);
  const normalized = normalize(top);
  for (const [name, directory] of dependencyPaths) {
    if (name !== normalized && !DIST_MODULES[name]?.includes(normalized)) continue;
    const subpath = target.replace(/\./g, path.sep);
    return fileResult(io, existingFiles(io, [directory, path.join(directory, "src")].flatMap(base =>
      [path.join(base, subpath + ".py"), path.join(base, subpath, "__init__.py")])), "python_local_path_dependency");
  }
  const isManifestDep = packages.has(normalized) || Object.entries(DIST_MODULES).some(([dist, modules]) => packages.has(dist) && modules.includes(normalized));
  if (isManifestDep) return io.finish("external", "python_manifest_dependency");

  const search = [...new Set([path.join(owner, "src"), owner, dirs[0]!, ...roots.map(root => path.resolve(io.root, root))])];
  const subpath = target.replace(/\./g, path.sep);
  const local = existingFiles(io, search.flatMap(root => [path.join(root, subpath + ".py"), path.join(root, subpath, "__init__.py")]));
  if (local.length) return fileResult(io, local, local.length === 1 ? "python_local_module" : "multiple_python_candidates");

  return io.finish("unresolved", "python_module_not_declared");
}
