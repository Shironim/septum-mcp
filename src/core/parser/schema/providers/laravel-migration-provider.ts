import { blankCommentsAndStrings } from "../../boundary-tracker.ts";
import { readOptionalSourceFile } from "../../../resources/source-files.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { warnIfUnexpectedParserError } from "../../extractors/manifest-helpers.ts";
import type {
  SchemaFieldSummary,
  SchemaMetadata,
  StackSchemaProvider,
} from "../schema-provider.interface.ts";

export class LaravelMigrationSchemaProvider implements StackSchemaProvider {
  public readonly id = "laravel-migration";
  public readonly name = "Laravel Migration Schema Provider";

  public canHandle(projectRoot: string): boolean {
    const migrationsDir = path.join(projectRoot, "database", "migrations");
    return fs.existsSync(migrationsDir) || fs.existsSync(path.join(projectRoot, "artisan"));
  }

  public resolveEntitySchema(
    projectRoot: string,
    entitySymbol: string,
    entityFilePath?: string
  ): SchemaMetadata | null {
    const migrationsDir = path.join(projectRoot, "database", "migrations");
    if (!fs.existsSync(migrationsDir)) return null;

    const tableName = this.resolveTableName(projectRoot, entitySymbol, entityFilePath);
    if (!tableName) return null;

    const migrationFiles = this.findMigrationFiles(migrationsDir);
    if (migrationFiles.length === 0) return null;

    const fieldsMap = new Map<string, SchemaFieldSummary>();
    let primarySourceFile: string | undefined;

    for (const migFile of migrationFiles) {
      const fullPath = path.join(migrationsDir, migFile);
      try {
        const content = readOptionalSourceFile(fullPath, "utf-8");
        const before = JSON.stringify([...fieldsMap]);
        if (!this.extractColumnsFromMigration(content, tableName, fieldsMap)) return null;
        if (JSON.stringify([...fieldsMap]) !== before) primarySourceFile = migFile;
      } catch {
        // An unreadable migration can change the summary; do not certify older fields.
        return null;
      }
    }

    if (fieldsMap.size === 0 || !primarySourceFile) return null;

    const relSourceFile = path.relative(projectRoot, path.join(migrationsDir, primarySourceFile));

    return {
      entityName: entitySymbol,
      tableName,
      schemaSourceFile: relSourceFile,
      fields: Array.from(fieldsMap.values()),
      interpretation: "static_migration_summary",
    };
  }

  private resolveTableName(
    projectRoot: string,
    entitySymbol: string,
    entityFilePath?: string
  ): string {
    // 1. Check if model file defines explicit protected $table = '...';
    if (entityFilePath) {
      const fullEntityPath = path.isAbsolute(entityFilePath)
        ? entityFilePath
        : path.join(projectRoot, entityFilePath);
      if (fs.existsSync(fullEntityPath)) {
        try {
          const content = readOptionalSourceFile(fullEntityPath, "utf-8");
          const mask = blankCommentsAndStrings(content);
          for (const tableMatch of content.matchAll(/protected\s+\$table\s*=\s*['"]([^'"]+)['"]/g)) {
            if (/protected\s+\$table\s*=/.test(mask.slice(tableMatch.index, tableMatch.index + tableMatch[0].length))) return tableMatch[1]!;
          }
          if (/protected\s+\$table\s*=/.test(mask)) return "";
        } catch (err: unknown) {
          warnIfUnexpectedParserError(`Failed to read entity file ${fullEntityPath}`, err);
        }
      }
    }

    // 2. Derive snake_case plural from entity name (e.g. OrderItem -> order_items)
    return this.pluralize(this.toSnakeCase(entitySymbol));
  }

  private toSnakeCase(str: string): string {
    return str
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
  }

  private pluralize(snake: string): string {
    if (snake.endsWith("y") && !/[aeiou]y$/i.test(snake)) {
      return `${snake.slice(0, -1)}ies`;
    }
    if (/(?:s|x|z|ch|sh)$/i.test(snake)) {
      return `${snake}es`;
    }
    return `${snake}s`;
  }

  private findMigrationFiles(migrationsDir: string): string[] {
    return fs.readdirSync(migrationsDir).filter(file => file.endsWith(".php")).sort();
  }

  private extractColumnsFromMigration(
    content: string,
    tableName: string,
    fieldsMap: Map<string, SchemaFieldSummary>
  ): boolean {
    const mask = blankCommentsAndStrings(content, { hashComments: true });
    const blockEnd = (start: number) => {
      let depth = 0;
      for (let i = start; i < mask.length; i++) {
        if (mask[i] === "{") depth++;
        if (mask[i] === "}" && --depth === 0) return i;
      }
      return mask.length;
    };
    const up = /function\s+up\s*\([^)]*\)[^{]*\{/.exec(mask);
    if (!up && /function\s+down\s*\(/.test(mask)) return true;
    const start = up ? up.index + up[0].length : 0;
    const end = up ? blockEnd(start - 1) : mask.length;
    const operations = /Schema::(create|table|dropIfExists|drop|rename)\s*\(/g;
    operations.lastIndex = start;
    let operation: RegExpExecArray | null;
    const bodies: string[] = [];
    while ((operation = operations.exec(mask)) && operation.index < end) {
      const argsStart = operations.lastIndex;
      const literal = /^\s*['"]([^'"]+)['"]/.exec(content.slice(argsStart));
      if (!literal) return false; // Dynamic table names cannot yield a reliable static summary.
      if (operation[1] === "rename") {
        const names = /^\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/.exec(content.slice(argsStart));
        if (!names || names[1] === tableName || names[2] === tableName) return false;
      }
      if (literal[1] !== tableName) continue;
      const kind = operation[1];
      if (["drop", "dropIfExists", "rename"].includes(kind!)) {
        bodies.push("__reset__");
        continue;
      }
      const open = mask.indexOf("{", argsStart);
      const close = open >= 0 ? blockEnd(open) : -1;
      if (open < 0 || close >= end) return false;
      if (kind === "create") bodies.push("__reset__");
      const bodyMask = mask.slice(open + 1, close);
      const body = content.slice(open + 1, close);
      // Copy executable statements only; quoted/comment decoys cannot provide a table call.
      for (const statement of bodyMask.matchAll(/\$table->[^;]+;/g)) {
        bodies.push(body.slice(statement.index!, statement.index! + statement[0].length));
      }
      operations.lastIndex = close + 1;
    }
    for (const rawLine of bodies) {
      const line = rawLine.trim();
      if (line === "__reset__") { fieldsMap.clear(); continue; }
      const drop = /\$table->dropColumn\s*\(\s*['"]([^'"]+)['"]/.exec(line);
      if (drop) { fieldsMap.delete(drop[1]!); continue; }
      const rename = /\$table->renameColumn\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/.exec(line);
      if (rename) {
        const field = fieldsMap.get(rename[1]!);
        fieldsMap.delete(rename[1]!);
        if (field) fieldsMap.set(rename[2]!, { ...field, name: rename[2]! });
        continue;
      }
      if (/\$table->(?:dropColumn|renameColumn)\s*\(/.test(line)) return false;
      if (!line.includes("$table->")) continue;

      // Special shorthand: $table->id();
      if (/\$table->id\s*\(\s*\)/.test(line)) {
        fieldsMap.set("id", { name: "id", type: "id", isPrimary: true });
        continue;
      }

      // Special shorthand: $table->id('custom_id');
      const customIdMatch = /\$table->id\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
      if (customIdMatch) {
        fieldsMap.set(customIdMatch[1], { name: customIdMatch[1], type: "id", isPrimary: true });
        continue;
      }

      // Special shorthand: $table->timestamps();
      if (/\$table->timestamps\s*\(/.test(line)) {
        if (!fieldsMap.has("created_at")) {
          fieldsMap.set("created_at", { name: "created_at", type: "timestamp", nullable: true });
        }
        if (!fieldsMap.has("updated_at")) {
          fieldsMap.set("updated_at", { name: "updated_at", type: "timestamp", nullable: true });
        }
        continue;
      }

      // Special shorthand: $table->softDeletes();
      if (/\$table->softDeletes\s*\(/.test(line)) {
        if (!fieldsMap.has("deleted_at")) {
          fieldsMap.set("deleted_at", { name: "deleted_at", type: "timestamp", nullable: true });
        }
        continue;
      }

      // Special shorthand: $table->rememberToken();
      if (/\$table->rememberToken\s*\(/.test(line)) {
        if (!fieldsMap.has("remember_token")) {
          fieldsMap.set("remember_token", { name: "remember_token", type: "string", nullable: true });
        }
        continue;
      }

      // Standard column definitions: $table->type('column_name', ...)
      const colMatch = /\$table->([a-zA-Z0-9_]+)\s*\(\s*['"]([^'"]+)['"]/.exec(line);
      if (colMatch) {
        const type = colMatch[1];
        const name = colMatch[2];

        // Skip non-column fluent methods like foreign, dropColumn, index, primary
        if (["index", "unique", "primary", "foreign", "dropColumn", "dropForeign"].includes(type)) {
          continue;
        }

        const nullable = line.includes("->nullable()");
        const isPrimary = type === "increments" || type === "bigIncrements" || line.includes("->primary()");
        const isForeign = type.startsWith("foreign") || name.endsWith("_id");

        fieldsMap.set(name, {
          name,
          type,
          nullable: nullable || undefined,
          isPrimary: isPrimary || undefined,
          isForeign: isForeign || undefined,
        });
      }
    }
    return true;
  }
}
