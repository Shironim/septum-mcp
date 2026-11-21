import * as fs from "node:fs";
import * as path from "node:path";

export type DetectedLanguage = "typescript" | "javascript" | "php" | "python" | "go" | "generic";

function warnIfUnexpectedError(context: string, err: unknown): void {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "ENOENT" || errno === "ENOTDIR") return;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[Septum Topology] ${context}: ${msg}`);
}

/**
 * Reads compilerOptions.paths from tsconfig.json or jsconfig.json.
 */
export function readTsConfigPaths(projectRoot: string): Record<string, string[]> {
  for (const file of ["tsconfig.json", "jsconfig.json"]) {
    const fullPath = path.join(projectRoot, file);
    if (fs.existsSync(fullPath)) {
      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const stripped = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
        const parsed = JSON.parse(stripped);
        if (parsed.compilerOptions?.paths) {
          return parsed.compilerOptions.paths;
        }
      } catch (err: unknown) {
        warnIfUnexpectedError(`Failed to parse ${fullPath}`, err);
      }
    }
  }
  return {};
}

export function detectProjectLanguage(projectRoot: string): DetectedLanguage {
  if (
    fs.existsSync(path.join(projectRoot, "composer.json")) ||
    fs.existsSync(path.join(projectRoot, "artisan"))
  ) {
    return "php";
  }
  if (fs.existsSync(path.join(projectRoot, "go.mod"))) return "go";
  if (
    fs.existsSync(path.join(projectRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(projectRoot, "requirements.txt"))
  ) {
    return "python";
  }
  if (
    fs.existsSync(path.join(projectRoot, "tsconfig.json")) ||
    fs.existsSync(path.join(projectRoot, "package.json"))
  ) {
    return "typescript";
  }
  return "generic";
}

export function detectProjectFramework(
  projectRoot: string,
  language: DetectedLanguage
): string {
  if (language === "php") {
    if (fs.existsSync(path.join(projectRoot, "artisan"))) return "laravel";
    if (
      fs.existsSync(path.join(projectRoot, "bin/console")) ||
      fs.existsSync(path.join(projectRoot, "symfony.lock"))
    ) {
      return "symfony";
    }
    const composerJson = path.join(projectRoot, "composer.json");
    if (fs.existsSync(composerJson)) {
      try {
        const composer = JSON.parse(fs.readFileSync(composerJson, "utf-8"));
        const reqs = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
        if (reqs["symfony/framework-bundle"] || reqs["symfony/symfony"]) {
          return "symfony";
        }
      } catch (err: unknown) {
        warnIfUnexpectedError(`Failed to parse ${composerJson}`, err);
      }
    }
    return "generic-php";
  }
  if (language === "typescript" || language === "javascript") {
    const pkgJson = path.join(projectRoot, "package.json");
    try {
      if (fs.existsSync(pkgJson)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.next) return "nextjs";
        if (allDeps.nuxt) return "nuxt";
        if (allDeps.astro) return "astro";
        if (allDeps.vue) return "vue";
        if (allDeps["@nestjs/core"]) return "nestjs";
        if (allDeps.express) return "express";
        if (allDeps.fastify) return "fastify";
        if (allDeps.hono) return "hono";
        if (allDeps.elysia) return "elysia";
        if (allDeps["@modelcontextprotocol/sdk"]) return "mcp-server";
      }
    } catch (err: unknown) {
      warnIfUnexpectedError(`Failed to inspect dependencies in ${pkgJson}`, err);
    }
    return "generic-node";
  }
  if (language === "python") {
    if (
      fs.existsSync(path.join(projectRoot, "manage.py")) ||
      fs.existsSync(path.join(projectRoot, "wsgi.py")) ||
      fs.existsSync(path.join(projectRoot, "asgi.py"))
    ) {
      return "django";
    }
    const readSafe = (p: string) => {
      try {
        return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").toLowerCase() : "";
      } catch (err: unknown) {
        warnIfUnexpectedError(`Failed to read ${p}`, err);
        return "";
      }
    };
    const deps =
      readSafe(path.join(projectRoot, "requirements.txt")) +
      " " +
      readSafe(path.join(projectRoot, "pyproject.toml")) +
      " " +
      readSafe(path.join(projectRoot, "Pipfile"));
    if (deps.includes("fastapi")) return "fastapi";
    if (deps.includes("django")) return "django";
    if (deps.includes("flask")) return "flask";
    return "generic-python";
  }
  if (language === "go") {
    const goModPath = path.join(projectRoot, "go.mod");
    if (fs.existsSync(goModPath)) {
      try {
        const modContent = fs.readFileSync(goModPath, "utf-8").toLowerCase();
        if (modContent.includes("github.com/gin-gonic/gin")) return "gin";
        if (modContent.includes("github.com/labstack/echo")) return "echo";
        if (modContent.includes("github.com/go-chi/chi")) return "chi";
        if (modContent.includes("github.com/gofiber/fiber")) return "fiber";
      } catch (err: unknown) {
        warnIfUnexpectedError(`Failed to inspect ${goModPath}`, err);
      }
    }
    return "generic-go";
  }
  return "generic";
}
