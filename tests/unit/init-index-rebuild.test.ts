import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";

it("repeat init rebuilds derived index with the same implementation while preserving user configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "septum-init-rebuild-"));
  const dbPath = join(root, ".septum/septum.db");
  const cli = resolve(import.meta.dir, "../../bin/septum.ts");
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), '{"name":"init-rebuild-fixture"}');
    writeFileSync(join(root, "src/Order.ts"), "export class Order { save() {} }\n");
    let db = new SeptumDatabase(dbPath);
    let repo = new SeptumRepository(db.raw);
    repo.upsertDomain("orders", { root: "src", allowed_dependencies: ["shared"], forbidden_dependencies: ["billing"] });
    repo.setMeta("settings_json", '{"enforcement":"warn"}');
    repo.setMeta("user_marker", "keep-me");
    db.close();
    const first = spawnSync("bun", ["run", cli, "init"], { cwd: root, input: "\n", encoding: "utf8", timeout: 15000 });
    expect(first.status).toBe(0);
    db = new SeptumDatabase(dbPath); repo = new SeptumRepository(db.raw);
    const fingerprint = repo.getMeta("parser_revision");
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const file = repo.getFileByPath("src/Order.ts")!;
    repo.replaceFileSymbols(file.id, []);
    repo.upsertVerticalSlice({
      domain_id: file.domain_id, feature_key: null, http_method: "GET", route_uri: "/poison",
      route_name: null, controller_class: "Order", action_name: "save", controller_file: file.path,
      controller_line: 1, architecture_style: "mvc", entry_kind: "http_route", execution_chain_json: "[]",
    });
    const domains = repo.getAllDomains().map(({ updated_at, ...domain }) => domain);
    const settings = repo.getMeta("settings_json");
    db.close();
    const second = spawnSync("bun", ["run", cli, "init"], { cwd: root, input: "\n", encoding: "utf8", timeout: 15000 });
    expect(second.status).toBe(0);
    db = new SeptumDatabase(dbPath); repo = new SeptumRepository(db.raw);
    try {
      expect(repo.getMeta("parser_revision")).toBe(fingerprint);
      expect(repo.getAllDomains().map(({ updated_at, ...domain }) => domain)).toEqual(domains);
      expect(repo.getMeta("settings_json")).toBe(settings);
      expect(repo.getMeta("user_marker")).toBe("keep-me");
      expect(repo.getSymbolsByFileId(file.id).map(s => s.name)).toContain("Order::save");
      expect(repo.getAllVerticalSlices().some(s => s.route_uri === "/poison")).toBe(false);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
