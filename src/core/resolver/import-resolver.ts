import * as fs from "node:fs";
import { resolvePython } from "./languages/python.ts";
import { resolveGo } from "./languages/go.ts";
import { resolveRuby } from "./languages/ruby.ts";
import { resolveRust } from "./languages/rust.ts";
import { resolveJava, resolveCSharp } from "./languages/managed.ts";
import type { ResolutionIO } from "./languages/shared.ts";
import * as path from "node:path";
import { builtinModules } from "node:module";
import { computeContentHash } from "../ingestion/hasher.ts";
import { readSourceFile, probeSourcePath, readSourceDirectory } from "../resources/source-files.ts";
import type { ImportResolution, ResolutionTarget } from "../../types/index.ts";

export const RESOLVER_REVISION = "5";
const GO_STDLIB = new Set("archive bufio builtin bytes cmp compress container context crypto database debug embed encoding errors expvar flag fmt go hash html image index io iter log maps math mime net os path plugin reflect regexp runtime slices sort strconv strings structs sync syscall testing text time unicode unique unsafe".split(" "));

const PYTHON_STDLIB = new Set("abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nntplib numbers operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 ssl stat statistics string stringprep struct subprocess sunau symbol symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios test textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo".split(" "));


const PHP_STDLIB = new Set([
  "stdClass", "Exception", "ErrorException", "Error", "TypeError", "ValueError", "ArgumentCountError",
  "ArithmeticError", "DivisionByZeroError", "ParseError", "AssertionError", "DateTime", "DateTimeImmutable",
  "DateTimeZone", "DateInterval", "DatePeriod", "PDO", "PDOStatement", "PDOException", "Closure", "Generator",
  "Fiber", "Throwable", "Stringable", "Countable", "Iterator", "IteratorAggregate", "Traversable", "ArrayAccess",
  "Serializable", "SplFileInfo", "SplFileObject", "SplFixedArray", "SplDoublyLinkedList", "SplQueue", "SplStack",
  "SplHeap", "SplMinHeap", "SplMaxHeap", "SplPriorityQueue", "SplObserver", "SplSubject", "Reflection",
  "ReflectionClass", "ReflectionMethod", "ReflectionFunction", "ReflectionProperty", "ReflectionParameter",
  "ReflectionType", "ReflectionNamedType", "ReflectionUnionType", "ReflectionIntersectionType", "ReflectionAttribute",
  "ReflectionEnum", "ReflectionEnumUnitCase", "ReflectionEnumBackedCase", "JsonException", "DomainException",
  "InvalidArgumentException", "LengthException", "LogicException", "OutOfBoundsException", "OutOfRangeException",
  "OverflowException", "RangeException", "RuntimeException", "UnderflowException", "UnexpectedValueException",
  "BadFunctionCallException", "BadMethodCallException", "Attribute"
]);

/** Static, workspace-contained resolution. No manifest scripts, downloads or retained cache. */
export class ImportResolver {
  private root: string;
  constructor(root: string, private packageRoots: string[] = []) { this.root = path.resolve(root); }

  public resolve(target: string, sourceFile: string, statement?: string): ImportResolution {
    const manifests: Record<string, string> = {};
    const contents = new Map<string, string | undefined>();
    let bytesRead = 0;
    const result: ImportResolution = {
      status: "unresolved", targets: [], reason: "target_not_found", coverage: "partial",
      resolver_revision: RESOLVER_REVISION, config_revision: "", source: { file: sourceFile, target },
    };
    const finish = (status: ImportResolution["status"], reason: string, targets: ResolutionTarget[] = []) => ({
      ...result, status, reason, targets,
      config_revision: computeContentHash(JSON.stringify({ root: this.root, revision: RESOLVER_REVISION, manifests })),
    });
    const read = (file: string): string | undefined => {
      this.assertContained(file);
      if (contents.has(file)) return contents.get(file);
      if (probeSourcePath(file) === "missing") { manifests[path.relative(this.root, file)] = "missing"; return undefined; }
      const text = readSourceFile(file);
      bytesRead += Buffer.byteLength(text, "utf8");
      if (bytesRead > 16 * 1024 * 1024) throw new Error("resolution_source_byte_limit");
      contents.set(file, text);
      manifests[path.relative(this.root, file)] = computeContentHash(text); return text;
    };
    const json = (file: string): any => {
      const raw = read(file); if (raw === undefined) return {};
      const clean = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : " ")
        .replace(/"(?:\\.|[^"\\])*"|,\s*[}\]]/g, token => token.startsWith('"') ? token : token.slice(1));
      const parsed = JSON.parse(clean);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed_manifest");
      return parsed;
    };
    const filesAt = (base: string, extensions: string[]): string[] => {
      this.assertContained(base);
      const extraCandidates: string[] = [];
      if (base.endsWith(".js")) {
        const stripped = base.slice(0, -3);
        extraCandidates.push(stripped + ".ts", stripped + ".tsx", stripped + ".d.ts", path.join(stripped, "index.ts"));
      } else if (base.endsWith(".mjs")) {
        const stripped = base.slice(0, -4);
        extraCandidates.push(stripped + ".mts", stripped + ".d.mts");
      } else if (base.endsWith(".cjs")) {
        const stripped = base.slice(0, -4);
        extraCandidates.push(stripped + ".cts", stripped + ".d.cts");
      } else if (base.endsWith(".jsx")) {
        const stripped = base.slice(0, -4);
        extraCandidates.push(stripped + ".tsx");
      }
      const candidates = [base, ...extraCandidates, ...extensions.map(ext => base + ext), ...extensions.map(ext => path.join(base, "index" + ext))];
      return [...new Set(candidates.filter(file => {
        this.assertContained(file);
        return probeSourcePath(file) === "file";
      }).map(file => path.relative(this.root, file).replace(/\\/g, "/")))];
    };
    const resolvedFiles = (files: string[], reason: string) => {
      const unique = [...new Set(files)].sort();
      return finish(unique.length === 1 ? "resolved" : unique.length > 1 ? "ambiguous" : "unresolved", reason,
        unique.map(file => ({ kind: "file", files: [file] })));
    };
    try {
      if (target.startsWith("dynamic:")) return finish("unresolved", "dynamic_target");
      const source = path.resolve(this.root, sourceFile); this.assertContained(source);
      const ext = path.extname(source).toLowerCase();
      const io: ResolutionIO = { root: this.root, read, check: file => this.assertContained(file), finish };
      if (ext === ".go") return resolveGo(io, target, sourceFile, GO_STDLIB);
      if (ext === ".py") return resolvePython(io, target, sourceFile, this.packageRoots, PYTHON_STDLIB);
      if (ext === ".rb") return resolveRuby(io, target, sourceFile, statement);
      if (ext === ".rs") return resolveRust(io, target, sourceFile);
      if (ext === ".java") return resolveJava(io, target, sourceFile, statement);
      if (ext === ".cs") return resolveCSharp(io, target, sourceFile, statement);
      if (ext === ".php") {
        let rawTarget = target.trim();
        const useMatch = rawTarget.match(/^use\s+(?:function\s+|const\s+)?([^;\s]+)(?:\s+as\s+[^;\s]+)?\s*;?$/i);
        if (useMatch) {
          rawTarget = useMatch[1]!;
        } else {
          rawTarget = rawTarget.replace(/;+$/, "").trim();
        }
        if (rawTarget.endsWith(".php")) {
          const absPhp = path.resolve(this.root, rawTarget.replace(/^\.\//, ""));
          this.assertContained(absPhp);
          if (probeSourcePath(absPhp) === "file") {
            return resolvedFiles([path.relative(this.root, absPhp).replace(/\\/g, "/")], "php_file_path");
          }
          return finish("unresolved", "file_not_found");
        }
        const normTarget = rawTarget.replace(/^\\/, "");
        if (
          PHP_STDLIB.has(normTarget) ||
          normTarget.startsWith("Attribute") ||
          normTarget.startsWith("ReturnTypeWillChange")
        ) {
          return finish("external", "php_standard_library");
        }

        let composerDir = this.root;
        for (let dir = path.dirname(source); dir === this.root || dir.startsWith(this.root + path.sep); dir = path.dirname(dir)) {
          if (probeSourcePath(path.join(dir, "composer.json")) !== "missing") {
            composerDir = dir;
            break;
          }
          if (dir === this.root) break;
        }
        const composer = json(path.join(composerDir, "composer.json"));
        const rules = { ...(composer.autoload?.["psr-4"] ?? {}), ...(composer["autoload-dev"]?.["psr-4"] ?? {}) };
        const matches = Object.keys(rules)
          .filter((prefix) => normTarget.startsWith(prefix.replace(/^\\/, "")))
          .sort((a, b) => b.length - a.length);

        if (matches.length > 0) {
          const prefix = matches[0]!;
          const cleanPrefix = prefix.replace(/^\\/, "");
          const dirs = Array.isArray(rules[prefix]) ? rules[prefix] : [rules[prefix]];
          if (!dirs.every((d: unknown) => typeof d === "string")) return finish("unsupported", "malformed_psr4");

          const relativePath = normTarget.slice(cleanPrefix.length).replace(/\\/g, "/");
          const candidateFiles: string[] = [];
          for (const dir of dirs) {
            const absBase = path.resolve(composerDir, dir, relativePath);
            this.assertContained(absBase);
            candidateFiles.push(...filesAt(absBase, [".php"]));
          }

          if (candidateFiles.length === 0) {
            return finish("unresolved", "file_not_found");
          }
          return resolvedFiles(candidateFiles, "composer_psr4");
        }

        // Check installed Composer vendor PSR-4 autoload map (covers transitive & non-matching package names like Carbon\*, Inertia\*)
        const autoloadPsr4 = read(path.join(composerDir, "vendor", "composer", "autoload_psr4.php"));
        if (autoloadPsr4) {
          for (const m of autoloadPsr4.matchAll(/['"]([^'"]+)['"]\s*=>/g)) {
            const prefix = m[1]!.replace(/\\\\/g, "\\").replace(/^\\/, "");
            if (prefix && normTarget.startsWith(prefix)) {
              return finish("external", "composer_vendor_psr4");
            }
          }
        }

        // Fallback: check composer.lock PSR-4 declarations when vendor/ is absent
        const composerLockRaw = read(path.join(composerDir, "composer.lock"));
        if (composerLockRaw) {
          const lock = JSON.parse(composerLockRaw);
          const lockPackages = [
            ...(Array.isArray(lock?.packages) ? lock.packages : []),
            ...(Array.isArray(lock?.["packages-dev"]) ? lock["packages-dev"] : []),
          ];
          for (const pkgEntry of lockPackages) {
            const psr4 = pkgEntry?.autoload?.["psr-4"];
            if (psr4 && typeof psr4 === "object") {
              for (const prefix of Object.keys(psr4)) {
                const cleanPrefix = prefix.replace(/^\\/, "");
                if (cleanPrefix && normTarget.startsWith(cleanPrefix)) {
                  return finish("external", "composer_lock_package");
                }
              }
            }
          }
        }

        // Check declared composer dependencies
        const requirements = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
        const topNamespace = normTarget.split("\\")[0]!.toLowerCase();
        for (const reqPackage of Object.keys(requirements)) {
          const [vendor, pkg] = reqPackage.toLowerCase().split("/");
          if (
            vendor === topNamespace ||
            pkg === topNamespace ||
            (vendor === "laravel" && topNamespace === "illuminate") ||
            (vendor === "symfony" && topNamespace === "symfony") ||
            (vendor === "guzzlehttp" && topNamespace === "guzzlehttp")
          ) {
            return finish("external", "composer_required_package");
          }
        }

        if (
          normTarget.startsWith("Illuminate\\") ||
          normTarget.startsWith("Symfony\\") ||
          normTarget.startsWith("Psr\\") ||
          normTarget.startsWith("Composer\\")
        ) {
          return finish("external", "php_framework_namespace");
        }

        return finish("unresolved", "php_namespace_not_mapped");
      }
      if (!/\.(?:[cm]?[jt]sx?|vue|astro|svelte)$/.test(ext)) return finish("unsupported", "language_resolver_unavailable");
      const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json"];
      if (target.startsWith(".") || path.isAbsolute(target)) return resolvedFiles(filesAt(path.resolve(path.dirname(source), target), extensions), "relative_path");
      if (builtinModules.includes(target) || target.startsWith("node:") && builtinModules.includes(target.slice(5)) || target === "bun" || target.startsWith("bun:")) return finish("external", "runtime_builtin");
      let nearestTsConfig = path.join(this.root, "tsconfig.json");
      let nearestPkgDir = this.root;
      let foundTsConfig = false;
      let foundPkg = false;
      for (let dir = path.dirname(source); dir === this.root || dir.startsWith(this.root + path.sep); dir = path.dirname(dir)) {
        if (!foundTsConfig && probeSourcePath(path.join(dir, "tsconfig.json")) !== "missing") {
          nearestTsConfig = path.join(dir, "tsconfig.json");
          foundTsConfig = true;
        }
        if (!foundPkg && probeSourcePath(path.join(dir, "package.json")) !== "missing") {
          nearestPkgDir = dir;
          foundPkg = true;
        }
        if (foundTsConfig && foundPkg) break;
        if (dir === this.root) break;
      }
      const loadTsConfig = (configPath: string, visited = new Set<string>()): any => {
        if (visited.has(configPath)) throw new Error("circular_tsconfig_extends");
        visited.add(configPath);
        const cfg = json(configPath);
        let options: any = {};
        const extendsList = cfg.extends === undefined ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
        for (const extRef of extendsList) {
          if (typeof extRef !== "string") throw new Error("malformed_tsconfig_extends");
          const base = extRef.startsWith(".") || path.isAbsolute(extRef)
            ? path.resolve(path.dirname(configPath), extRef)
            : path.resolve(this.root, "node_modules", extRef);
          this.assertContained(base);
          let parentPath = base.endsWith(".json") ? base : base + ".json";
          if (probeSourcePath(parentPath) === "missing" && probeSourcePath(base) === "directory") {
            const pkg = json(path.join(base, "package.json"));
            parentPath = path.resolve(base, typeof pkg.tsconfig === "string" ? pkg.tsconfig : "tsconfig.json");
          }
          this.assertContained(parentPath);
          if (probeSourcePath(parentPath) === "missing") throw new Error("tsconfig_extends_not_found");
          options = { ...options, ...loadTsConfig(parentPath, visited) };
        }
        const own = cfg.compilerOptions ?? {};
        if (typeof own !== "object" || Array.isArray(own)) throw new Error("malformed_tsconfig_options");
        options = { ...options, ...own };
        if (Object.hasOwn(own, "baseUrl")) {
          if (typeof own.baseUrl !== "string") throw new Error("malformed_tsconfig_baseurl");
          options.baseUrl = path.resolve(path.dirname(configPath), own.baseUrl);
        }
        if (Object.hasOwn(own, "paths")) options.pathsBase = path.dirname(configPath);
        visited.delete(configPath);
        return options;
      };

      const options = loadTsConfig(nearestTsConfig);
      const aliases = options.paths ?? {};
      if (typeof aliases !== "object" || Array.isArray(aliases)) return finish("unsupported", "malformed_ts_paths");
      const matching = Object.keys(aliases).filter(key => {
        const star = key.indexOf("*");
        return star < 0 ? target === key : key.indexOf("*", star + 1) < 0 && target.startsWith(key.slice(0, star)) && target.endsWith(key.slice(star + 1)) && target.length >= key.length - 1;
      }).sort((a,b) => (b.includes("*") ? b.indexOf("*") : Number.MAX_SAFE_INTEGER) - (a.includes("*") ? a.indexOf("*") : Number.MAX_SAFE_INTEGER));
      if (matching.length) {
        const key = matching[0]!; const values = aliases[key];
        if (!Array.isArray(values) || !values.every(v=>typeof v === "string")) return finish("unsupported", "malformed_ts_paths");
        for (const value of values as string[]) {
          const star = key.indexOf("*");
          const matched = star < 0 ? "" : target.slice(star, target.length - (key.length - star - 1));
          const files = filesAt(path.resolve(options.baseUrl ?? options.pathsBase ?? this.root, value.replace("*", matched)), extensions);
          if (files.length) return resolvedFiles(files, "tsconfig_paths");
        }
      }
      if (options.baseUrl && !matching.length) {
        const baseFiles = filesAt(path.resolve(options.baseUrl, target), extensions);
        if (baseFiles.length) return resolvedFiles(baseFiles, "tsconfig_baseurl");
      }
      if (!options.baseUrl && !matching.length) {
        const local = target.startsWith("@/") ? target.replace(/^@\//,"src/") : target;
        const localFiles = filesAt(path.resolve(this.root,local),extensions);
        if (localFiles.length) return resolvedFiles(localFiles,"workspace_path");
      }
      const pkg = json(path.join(this.root,"package.json"));
      const localPkg = nearestPkgDir !== this.root ? json(path.join(nearestPkgDir, "package.json")) : {};
      const workspacePatterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
      const roots = [...this.packageRoots];
      for (const pattern of workspacePatterns) {
        if (typeof pattern !== "string") return finish("unsupported","malformed_workspace_pattern");
        if (pattern.endsWith("/*")) {
          const parent = path.resolve(this.root,pattern.slice(0,-2)); this.assertContained(parent);
          if (probeSourcePath(parent) !== "missing") roots.push(...readSourceDirectory(parent).filter(entry=>entry.isDirectory()).map(entry=>path.relative(this.root,path.join(parent,entry.name))));
        } else if (!pattern.includes("*")) roots.push(pattern);
        else return finish("unsupported","workspace_glob_not_supported");
      }
      const workspaceFiles: string[] = [];
      for (const directory of [...new Set(roots)]) {
        const workspace = json(path.resolve(this.root,directory,"package.json"));
        if (typeof workspace.name !== "string" || !(target === workspace.name || target.startsWith(workspace.name + "/"))) continue;
        const subpath = target.slice(workspace.name.length).replace(/^\//, "");
        let resolvedEntry: string | undefined;

        if (!subpath) {
          const exported = typeof workspace.exports === "string" ? workspace.exports : workspace.exports?.["."];
          if (typeof exported === "string") {
            resolvedEntry = exported;
          } else if (exported && typeof exported === "object") {
            resolvedEntry = exported.import || exported.default || exported.require || exported.types;
            if (typeof resolvedEntry !== "string") return finish("unsupported", "conditional_package_exports");
          }
        } else if (workspace.exports && typeof workspace.exports === "object") {
          const subExport = workspace.exports["./" + subpath] ?? workspace.exports["./" + subpath + ".js"];
          if (typeof subExport === "string") {
            resolvedEntry = subExport;
          } else if (subExport && typeof subExport === "object") {
            resolvedEntry = subExport.import || subExport.default || subExport.require || subExport.types;
          }
        }

        const entry = resolvedEntry || subpath || workspace.module || workspace.main || "index";
        if (typeof entry !== "string") return finish("unsupported","package_entry_not_literal");
        workspaceFiles.push(...filesAt(path.resolve(this.root,directory,entry),extensions));
      }
      if (workspaceFiles.length) return resolvedFiles(workspaceFiles,"workspace_package");
      const name = target.startsWith("@") ? target.split("/").slice(0,2).join("/") : target.split("/")[0]!;
      const depMaps = [
        localPkg.dependencies, localPkg.devDependencies, localPkg.peerDependencies, localPkg.optionalDependencies,
        pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies,
      ];
      if (depMaps.some(deps => deps && Object.hasOwn(deps, name))) return finish("external", "package_manifest_dependency");
      return finish("unresolved", "package_not_declared");
    } catch (error) {
      return finish("unsupported", error instanceof Error && error.message.includes("outside_workspace") ? "outside_workspace" : `manifest_or_source_error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private assertContained(file: string): void {
    const contained = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + path.sep);
    if (!contained(path.resolve(file), this.root)) throw new Error("outside_workspace");
    let existing = file;
    while (!fs.existsSync(existing) && existing !== this.root) existing = path.dirname(existing);
    if (fs.existsSync(existing) && !contained(fs.realpathSync(existing), fs.realpathSync(this.root))) throw new Error("outside_workspace");
  }
}
