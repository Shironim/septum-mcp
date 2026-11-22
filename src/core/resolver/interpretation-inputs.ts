import { basename } from "node:path";

const RESOLUTION_INPUT_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "nest-cli.json",
  "nx.json",
  "turbo.json",
  "lerna.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "mypy.ini",
  "pyrightconfig.json",
  "go.mod",
  "go.work",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "composer.json",
  "composer.lock",
  "artisan",
  "gemfile",
  "gemfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "directory.build.props",
  "directory.build.targets",
  "packages.config",
]);

/** Files whose staged bytes and watcher events can change import interpretation. */
export function isResolutionInput(file: string): boolean {
  const norm = file.replace(/\\/g, "/");
  const base = basename(norm).toLowerCase();
  if (RESOLUTION_INPUT_BASENAMES.has(base)) return true;
  if (/^(?:tsconfig|jsconfig)(?:\.[^/]+)?\.jsonc?$/i.test(base)) return true;
  if (/^requirements(?:[-_.][^/]*)?\.(?:txt|in)$/i.test(base) || /(?:^|\/)requirements\/[^/]+\.(?:txt|in)$/i.test(norm)) {
    return true;
  }
  if (/\.(?:csproj|fsproj|vbproj|props|targets|gemspec|gradle|gradle\.kts)$/i.test(base)) return true;
  // Inherited tsconfig/jsconfig or custom workspace JSON configs (e.g. configs/base.json),
  // while excluding test fixtures/cassettes/locales.
  if (
    /\.(?:json|jsonc)$/i.test(base) &&
    !/(?:^|\/)(?:tests?|__tests__|cassettes|fixtures?|__fixtures__|locales?|i18n|translations?)\//i.test(norm)
  ) {
    return true;
  }
  return false;
}
