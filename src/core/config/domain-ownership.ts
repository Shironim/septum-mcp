import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SeptumError } from "../errors.ts";

// SQLite's built-in NOCASE/LOWER folds ASCII, not all Unicode case pairs.
export function domainNameKey(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

export class DomainRootConflictError extends SeptumError {
  constructor(readonly owner: string, readonly contender: string, readonly root: string) {
    super(
      "DOMAIN_ROOT_CONFLICT",
      `Domain root conflict: '${owner}' and '${contender}' both own '${root}'. Update the existing domain by name, or move one domain to a distinct root. Nested roots are allowed; no domains were merged or deleted.`
    );
  }
}

/** Resolve existing ancestors too, so symlink aliases of future directories collide. */
export function domainRootIdentity(root: string, workspaceRoot: string): string {
  let current = resolve(workspaceRoot, root);
  const missing: string[] = [];
  while (true) {
    try { return join(realpathSync(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error(`Cannot resolve domain root '${root}': broken symbolic link '${current}'. Repair the link before assigning ownership.`);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current)); current = parent;
    }
  }
}

export function assertUniqueDomainRoots(domains: Record<string, { root: string }>, workspaceRoot: string): void {
  const owners = new Map<string, string>();
  for (const [name, config] of Object.entries(domains).sort(([a], [b]) => a.localeCompare(b))) {
    const identity = domainRootIdentity(config.root, workspaceRoot);
    const owner = owners.get(identity);
    if (owner && domainNameKey(owner) !== domainNameKey(name)) throw new DomainRootConflictError(owner, name, identity);
    owners.set(identity, name);
  }
}
