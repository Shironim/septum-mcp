import { basename } from "node:path";

/** Files whose staged bytes and watcher events can change import interpretation. */
export function isResolutionInput(file: string): boolean {
  return /\.(?:json|jsonc|toml|ya?ml|xml|csproj|props|targets|gradle|gradle\.kts|gemspec|lock|txt|in)$/i.test(file) ||
    /^(?:Gemfile|Pipfile|go\.mod|go\.work|artisan|nest-cli\.json)$/.test(basename(file));
}
