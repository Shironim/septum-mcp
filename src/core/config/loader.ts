import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { SeptumConfigSchema, type ValidatedSeptumConfig } from "./schema.ts";
import { SeptumDatabase } from "../database/client.ts";
import { SeptumRepository } from "../database/repository.ts";
import { resolveWorkspaceRoot } from "../resolver/path-resolver.ts";
import type { DomainConfig } from "../../types/index.ts";

export function resolveDatabasePath(root: string, dbPath = ".septum/septum.db"): string {
  return dbPath === ":memory:" || isAbsolute(dbPath) ? dbPath : resolve(root, dbPath);
}

export class ConfigLoader {
  /** Read configuration without initializing or modifying workspace state. */
  public static load(
    dbPath?: string,
    projectRoot?: string
  ): ValidatedSeptumConfig {
    const root = resolveWorkspaceRoot(projectRoot);
    const configFilePath = join(root, "septum.config.json");
    if (existsSync(configFilePath)) {
      const diskConfig = ConfigLoader.loadFromDisk(configFilePath);
      if (dbPath) diskConfig.settings.db_path = dbPath;
      return diskConfig;
    }
    return ConfigLoader.loadFromDatabaseOrDefaults(resolveDatabasePath(root, dbPath));
  }

  /** The file owns policy when present; retain unknown user fields on updates. */
  public static writeDomain(root: string, name: string, domain: DomainConfig, expected: string): void {
    const file = join(root, "septum.config.json");
    const lock = `${file}.lock`;
    const fd = openSync(lock, "wx");
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Policy file must be a regular file.");
      if (readFileSync(file, "utf8") !== expected) throw new Error("Policy changed during registration; reload and retry.");
      const raw = JSON.parse(expected);
      const domains = { ...raw.domains };
      const key = Object.keys(domains).find(key => key.toLowerCase() === name.toLowerCase()) ?? name;
      domains[key] = { ...domains[key], ...domain };
      const updated = { ...raw, domains };
      SeptumConfigSchema.parse(updated);
      writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode: lstatSync(file).mode & 0o777 });
      if (readFileSync(file, "utf8") !== expected) throw new Error("Policy changed during registration; reload and retry.");
      renameSync(temporary, file);
    } finally {
      closeSync(fd);
      rmSync(temporary, { force: true });
      rmSync(lock, { force: true });
    }
  }

  public static loadFromDisk(filePath: string): ValidatedSeptumConfig {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const defaults = ConfigLoader.getDefaultConfig();
      const merged = {
        ...defaults,
        ...parsed,
        settings: {
          ...defaults.settings,
          ...(parsed.settings || {}),
        },
        domains: parsed.domains || {},
      };
      return SeptumConfigSchema.parse(merged);
    } catch (err: any) {
      throw new Error(`Failed to load configuration from '${filePath}': ${err.message || err}`);
    }
  }

  public static syncDiskConfigToDatabase(
    dbPath: string,
    diskConfig: ValidatedSeptumConfig,
    workspaceRoot?: string
  ): void {
    if (!existsSync(dbPath)) return;
    const septumDb = new SeptumDatabase(dbPath);
    const repo = new SeptumRepository(septumDb.raw);
    try {
      repo.runInTransaction(() => {
        repo.setMeta("settings_json", JSON.stringify(diskConfig.settings));
        if (diskConfig.domains && Object.keys(diskConfig.domains).length > 0) {
          const domainNames = Object.keys(diskConfig.domains);
          for (const [name, domain] of Object.entries(diskConfig.domains)) {
            repo.upsertDomain(name, domain, workspaceRoot);
          }
          repo.pruneDomainsNotIn(domainNames);
        }
      });
    } finally {
      septumDb.close();
    }
  }

  public static getDefaultConfig(): ValidatedSeptumConfig {
    return SeptumConfigSchema.parse({});
  }

  public static loadFromRepository(repo: SeptumRepository): ValidatedSeptumConfig {
    const config = ConfigLoader.getDefaultConfig();
    if (repo && typeof repo.getAllDomains === "function") {
      const rows = repo.getAllDomains();
      for (const row of rows) {
        config.domains[row.name] = {
          root: row.root_path,
          allowed_dependencies: JSON.parse(row.allowed_deps_json || "[]"),
          forbidden_dependencies: JSON.parse(row.forbidden_deps_json || "[]"),
          archetypes: JSON.parse(row.archetypes_json || "{}"),
        };
      }
    }

    if (typeof repo?.getMeta === "function") {
      const settings = repo.getMeta("settings_json");
      if (settings) Object.assign(config.settings, JSON.parse(settings));
    }
    return config;
  }

  public static loadFromDatabaseOrDefaults(dbPath: string = ".septum/septum.db"): ValidatedSeptumConfig {
    const config = ConfigLoader.getDefaultConfig();
    config.settings.db_path = dbPath;

    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const tables = db
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
          )
          .get("domains");

        try {
          if (tables) Object.assign(config, ConfigLoader.loadFromRepository(new SeptumRepository(db)));
          config.settings.db_path = dbPath;
        } finally {
          db.close();
        }
      } catch {
        throw new Error(`Cannot load Septum configuration from '${dbPath}'.`);
      }
    }

    return config;
  }
}
