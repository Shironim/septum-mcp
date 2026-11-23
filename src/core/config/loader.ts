import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { SeptumConfigSchema, type ValidatedSeptumConfig } from "./schema.ts";
import { SeptumDatabase } from "../database/client.ts";
import { SeptumRepository } from "../database/repository.ts";
import { resolveWorkspaceRoot } from "../resolver/path-resolver.ts";

export function resolveDatabasePath(root: string, dbPath = ".septum/septum.db"): string {
  return dbPath === ":memory:" || isAbsolute(dbPath) ? dbPath : resolve(root, dbPath);
}

export class ConfigLoader {
  /** Read configuration from SQLite SSOT (or defaults) without initializing workspace state. */
  public static load(
    dbPath?: string,
    projectRoot?: string
  ): ValidatedSeptumConfig {
    const root = resolveWorkspaceRoot(projectRoot);
    return ConfigLoader.loadFromDatabaseOrDefaults(resolveDatabasePath(root, dbPath));
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
