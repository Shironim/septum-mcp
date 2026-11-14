import * as path from "node:path";
import { blankCommentsAndStrings } from "../../parser/boundary-tracker.ts";
import { ancestors, existingFiles, fileResult, type ResolutionIO } from "./shared.ts";

const STDLIB = new Set("abbrev base64 benchmark bigdecimal bundler cgi csv date delegate digest drb english erb etc fcntl fiddle fileutils find forwardable io ipaddr irb json logger monitor mutex_m net objspace observer open-uri openssl optparse ostruct pathname pp prettyprint pstore psych racc rdoc readline resolv rexml ripper securerandom set shellwords singleton socket stringio strscan tempfile time timeout tmpdir tsort uri weakref yaml zlib".split(" "));
const GEM_IMPORTS: Record<string, string[]> = { activerecord: ["active_record"], activesupport: ["active_support"], actionpack: ["action_controller", "action_dispatch"], railties: ["rails"], nokogiri: ["nokogiri"], concurrent_ruby: ["concurrent"] };

export function resolveRuby(io: ResolutionIO, target: string, source: string, statement?: string) {
  const syntax = /^(require_relative|require)\s*(?:\(\s*)?["']([^"']+)["']/.exec(statement ?? target);
  const value = syntax?.[2] ?? target;
  const relative = syntax?.[1] === "require_relative" || !syntax && value.startsWith(".");
  if (relative) return fileResult(io, existingFiles(io, [path.resolve(io.root, path.dirname(source), value), path.resolve(io.root, path.dirname(source), value + ".rb")]), "ruby_require_relative");
  const dirs = ancestors(io, source);
  let owner = io.root; let gemfile: string | undefined; let lock: string | undefined;
  for (const dir of dirs) {
    const manifest = io.read(path.join(dir, "Gemfile"));
    const locked = io.read(path.join(dir, "Gemfile.lock"));
    if (manifest !== undefined || locked !== undefined) { owner = dir; gemfile = manifest; lock = locked; break; }
  }
  const files = existingFiles(io, [path.resolve(owner, "lib", value), path.resolve(owner, "lib", value + ".rb")]);
  if (files.length) return fileResult(io, files, "ruby_local_load_path");
  const top = value.split("/")[0]!;
  if (STDLIB.has(top)) return io.finish("external", "ruby_standard_library");
  const gems = new Set<string>();
  const mask = blankCommentsAndStrings(gemfile ?? "", { hashComments: true });
  if (/^\s*(?:path|gemspec|eval_gemfile)\b/m.test(mask) || /<<[-~]?\s*["']?[A-Za-z_]\w*/.test(gemfile ?? ""))
    return io.finish("unsupported", "ruby_dynamic_gem_configuration");
  for (const match of (gemfile ?? "").matchAll(/^\s*gem\s*(?:\(\s*)?["']([^"']+)["']([^\n]*)/gm)) {
    if (!/^\s*gem\b/.test(mask.slice(match.index!, match.index! + match[0].length))) continue;
    const name = match[1]!; gems.add(name.replace(/-/g, "_"));
    const local = /\bpath:\s*["']([^"']+)["']/.exec(match[2]!);
    if (local && (top === name.replace(/-/g, "_") || GEM_IMPORTS[name.replace(/-/g, "_")]?.includes(top))) {
      const base = path.resolve(owner, local[1]!, "lib", value);
      return fileResult(io, existingFiles(io, [base, base + ".rb"]), "ruby_path_gem");
    }
  }
  for (const match of (lock ?? "").matchAll(/^ {4}([A-Za-z0-9_-]+)\s+\([^\n]+\)/gm)) gems.add(match[1]!.replace(/-/g, "_"));
  if (gems.has(top) || [...gems].some(gem => GEM_IMPORTS[gem]?.includes(top))) return io.finish("external", "ruby_manifest_dependency");
  return io.finish("unresolved", "ruby_load_path_not_established");
}
