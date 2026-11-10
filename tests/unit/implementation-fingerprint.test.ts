import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintImplementation, ANALYSIS_FINGERPRINT } from "../../src/core/parser/implementation-fingerprint.ts";
import { PARSER_FINGERPRINT } from "../../src/core/parser/language-capabilities.ts";
import { SEMANTIC_FINGERPRINT } from "../../src/core/parser/semantic-revision.ts";

describe("automatic implementation identity", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "septum-fingerprint-"));
    mkdirSync(join(root, "src")); mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "src/parser.ts"), "export const value = 1;");
    writeFileSync(join(root, "bin/cli.ts"), "import '../src/parser.ts';");
    writeFileSync(join(root, "package.json"), '{"dependencies":{}}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses content identities for parser and semantics without a manual counter", () => {
    expect(ANALYSIS_FINGERPRINT).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(PARSER_FINGERPRINT).toBe(ANALYSIS_FINGERPRINT);
    expect(SEMANTIC_FINGERPRINT).toBe(ANALYSIS_FINGERPRINT);
  });

  it("changes on same-size, same-mtime implementation edits and newly added source files", () => {
    const file = join(root, "src/parser.ts");
    const first = fingerprintImplementation({ sourceRoot: root });
    utimesSync(file, 1700000000, 1700000000);
    expect(fingerprintImplementation({ sourceRoot: root })).toBe(first);
    writeFileSync(file, "export const value = 2;");
    utimesSync(file, 1700000000, 1700000000);
    const second = fingerprintImplementation({ sourceRoot: root });
    expect(second).not.toBe(first);
    writeFileSync(join(root, "src/helper.ts"), "export const helper = 1;");
    expect(fingerprintImplementation({ sourceRoot: root })).not.toBe(second);
  });

  it("is independent of checkout location and ignores docs outside the implementation", () => {
    const first = fingerprintImplementation({ sourceRoot: root });
    writeFileSync(join(root, "README.md"), "documentation");
    expect(fingerprintImplementation({ sourceRoot: root })).toBe(first);
    const copy = join(root, "copy");
    mkdirSync(copy);
    for (const file of ["src", "bin", "package.json"]) cpSync(join(root, file), join(copy, file), { recursive: true });
    expect(fingerprintImplementation({ sourceRoot: copy })).toBe(first);
  });

  it("tracks installed modules, manifests, grammar bytes and lockfiles", () => {
    const dependency = join(root, "node_modules/example");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"dependencies":{"example":"1.0.0"}}');
    writeFileSync(join(dependency, "package.json"), '{"name":"example"}');
    writeFileSync(join(dependency, "internal.js"), "module.exports = 1;");
    const asset = join(root, "grammar.wasm"); writeFileSync(asset, "grammar-one");
    const options = { sourceRoot: root, assets: { "grammar.wasm": asset } };
    const first = fingerprintImplementation(options);
    writeFileSync(join(dependency, "internal.js"), "module.exports = 2;");
    const patched = fingerprintImplementation(options); expect(patched).not.toBe(first);
    writeFileSync(join(dependency, "package.json"), '{"name":"example","version":"2.0.0"}');
    const second = fingerprintImplementation(options); expect(second).not.toBe(patched);
    writeFileSync(asset, "grammar-two");
    const third = fingerprintImplementation(options); expect(third).not.toBe(second);
    writeFileSync(join(root, "bun.lock"), "changed dependency resolution");
    expect(fingerprintImplementation(options)).not.toBe(third);
  });

  it("identifies compiled executable bytes without requiring the source checkout", () => {
    const executable = join(root, "septum"); writeFileSync(executable, "binary-one");
    const first = fingerprintImplementation({ executablePath: executable });
    writeFileSync(join(root, "src/parser.ts"), "unrelated to embedded binary");
    expect(fingerprintImplementation({ executablePath: executable })).toBe(first);
    writeFileSync(executable, "binary-two");
    expect(fingerprintImplementation({ executablePath: executable })).not.toBe(first);
  });
});
