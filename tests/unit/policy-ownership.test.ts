import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { handleRegisterDomain } from "../../src/mcp/tools/map.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "septum-policy-")); roots.push(root);
  mkdirSync(join(root, "src/orders"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  const config = ConfigLoader.getDefaultConfig();
  config.domains = {
    orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    billing: { root: "src/billing", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
  };
  return { root, config };
}

test("loading default config does not create a database on disk", () => {
  const { root } = fixture();
  expect(ConfigLoader.load(undefined, root).domains).toEqual({});
  expect(existsSync(join(root, ".septum"))).toBe(false);
});

test("SQLite-owned registration survives reload", async () => {
  const { root, config } = fixture();
  const db = new SeptumDatabase(join(root, ".septum/septum.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    const result = await handleRegisterDomain(repo, config, { name: "orders", root: "src/orders", forbidden_dependencies: ["billing"] }, root);
    expect(JSON.parse(result.content[0]!.text).policy_owner).toBe("database");
    expect(ConfigLoader.load(undefined, root).domains.orders.forbidden_dependencies).toEqual(["billing"]);
  } finally { db.close(); }
});

test("omitted policy fields preserve the current SQLite values", async () => {
  const { root, config } = fixture();
  const db = new SeptumDatabase(join(root, ".septum/septum.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    repo.upsertDomain("orders", { ...config.domains.orders, forbidden_dependencies: ["billing"] }, root);
    await handleRegisterDomain(repo, config, { name: "orders", root: "src/orders", description: "Updated description" }, root);
    expect(ConfigLoader.load(undefined, root).domains.orders.forbidden_dependencies).toEqual(["billing"]);
    expect(repo.getDomainByName("orders")?.forbidden_deps_json).toBe('["billing"]');
  } finally { db.close(); }
});

test("SQLite hook rejects a forbidden import through the real CLI", async () => {
  const { root, config } = fixture();
  config.domains.orders.forbidden_dependencies = ["billing"];
  writeFileSync(join(root, "src/billing/invoice.ts"), "export const invoice = 1;");
  const db = new SeptumDatabase(join(root, ".septum/septum.db"));
  const repo = new SeptumRepository(db.raw);
  for (const [name, domain] of Object.entries(config.domains)) repo.upsertDomain(name, domain, root);
  db.close();
  const proc = Bun.spawn(["bun", "run", resolve(import.meta.dir, "../../bin/septum.ts"), "hook", "pre-write"], {
    cwd: root, stdin: new Blob([JSON.stringify({ tool_input: { file_path: "src/orders/order.ts", content: "import {invoice} from '../billing/invoice';" } })]),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(1);
  expect(JSON.parse(stdout).decision).toBe("deny");
  expect(stderr).toContain("forbidden_dependency");
});
