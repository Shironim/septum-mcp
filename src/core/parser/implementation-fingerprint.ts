import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WASM_ASSETS } from "./wasm-assets.ts";

/** Content identity, independent of checkout paths, mtimes and release counters. */
export function fingerprintImplementation(options: {
  sourceRoot?: string;
  executablePath?: string;
  assets?: Record<string, string>;
}): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(256 * 1024);
  const addFile = (label: string, file: string): void => {
    const expectedSize = statSync(file).size;
    hash.update(JSON.stringify([label, expectedSize]));
    // Bound memory while hashing standalone executables, which include the Bun runtime.
    const fd = openSync(file, "r");
    try {
      let total = 0;
      for (;;) {
        const size = readSync(fd, chunk, 0, chunk.length, null);
        if (!size) break;
        hash.update(chunk.subarray(0, size));
        total += size;
      }
      if (total !== expectedSize) throw new Error(`Implementation changed while fingerprinting '${label}'. Restart Septum.`);
    } finally { closeSync(fd); }
    hash.update("\0");
  };
  if (options.executablePath) {
    addFile("executable", options.executablePath);
  } else if (options.sourceRoot) {
    const root = resolve(options.sourceRoot);
    const ancestors = new Set<string>();
    const visit = (directory: string, base = root, prefix = ""): void => {
      const identity = realpathSync(directory);
      if (ancestors.has(identity)) throw new Error(`Implementation directory cycle at '${directory}'.`);
      ancestors.add(identity);
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          const file = join(directory, entry.name);
          const info = entry.isSymbolicLink() ? statSync(file) : entry;
          if (info.isDirectory()) visit(file, base, prefix);
          else if (info.isFile()) addFile([prefix, relative(base, file).replace(/\\/g, "/")].filter(Boolean).join("/"), file);
        }
      } finally { ancestors.delete(identity); }
    };
    visit(join(root, "src"));
    visit(join(root, "bin"));
    for (const name of ["package.json", "bun.lock", "bun.lockb"]) {
      const file = join(root, name);
      if (existsSync(file)) addFile(name, file);
    }
    // Include installed bytes: local dependency patches can change analysis
    // without changing a package manifest or lockfile.
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
      let directory = root;
      while (!existsSync(join(directory, "node_modules", name, "package.json"))) {
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`Cannot fingerprint installed dependency '${name}'.`);
        directory = parent;
      }
      const packageRoot = join(directory, "node_modules", name);
      visit(packageRoot, packageRoot, `dependency:${name}`);
    }
  } else {
    throw new Error("Implementation fingerprint requires sourceRoot or executablePath.");
  }
  for (const [name, file] of Object.entries(options.assets ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    // Embedded WASM paths support readFileSync in compiled Bun executables.
    hash.update(JSON.stringify(["asset", name]));
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  hash.update(JSON.stringify(["runtime", Bun.version, process.platform, process.arch]));
  return `sha256:${hash.digest("hex")}`;
}

const standalone = typeof Bun.isStandaloneExecutable === "boolean"
  ? Bun.isStandaloneExecutable : Bun.embeddedFiles.length > 0;
const assets = Object.fromEntries(Object.entries(WASM_ASSETS).map(([name, embedded]) => {
  const override = process.env.SEPTUM_WASM_DIR;
  const candidates = override ? [join(override, name), join(override, "out", name), embedded] : [embedded];
  return [name, candidates.find(file => existsSync(file)) ?? embedded];
}));

// One identity per loaded process. A daemon must restart to load changed implementation code.
export const ANALYSIS_FINGERPRINT = fingerprintImplementation(standalone ? {
  executablePath: process.platform === "linux" ? "/proc/self/exe" : process.execPath,
  assets,
} : {
  sourceRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  assets,
});
