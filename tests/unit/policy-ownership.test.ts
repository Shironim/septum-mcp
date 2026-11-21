import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  config.settings.db_path = "state/index.db";
  config.domains = {
    orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    billing: { root: "src/billing", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
  };
  writeFileSync(join(root, "septum.config.json"), JSON.stringify({ ...config, custom: { preserve: true } }));
  return { root, config };
}

test("loading disk policy does not create a default database", () => {
  const { root } = fixture();
  expect(ConfigLoader.load(undefined, root).settings.db_path).toBe("state/index.db");
  expect(existsSync(join(root, ".septum"))).toBe(false);
  expect(existsSync(join(root, "state"))).toBe(false);
});

test("file-owned registration survives reload and retains user fields", async () => {
  const { root, config } = fixture();
  const db = new SeptumDatabase(join(root, "state/index.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    const result = await handleRegisterDomain(repo, config, { name: "orders", root: "src/orders", forbidden_dependencies: ["billing"] }, root);
    expect(JSON.parse(result.content[0]!.text).policy_owner).toBe("file");
    expect(ConfigLoader.load(undefined, root).domains.orders.forbidden_dependencies).toEqual(["billing"]);
    expect(JSON.parse(readFileSync(join(root, "septum.config.json"), "utf8")).custom).toEqual({ preserve: true });
  } finally { db.close(); }
});

test("failed policy writes roll back database registration", async () => {
  const { root, config } = fixture();
  const db = new SeptumDatabase(join(root, "state/index.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    repo.upsertDomain("orders", config.domains.orders, root);
    writeFileSync(join(root, "septum.config.json.lock"), "another writer");
    await expect(handleRegisterDomain(repo, config, { name: "orders", root: "src/orders", forbidden_dependencies: ["billing"] }, root)).rejects.toThrow();
    expect(repo.getDomainByName("orders")?.forbidden_deps_json).toBe("[]");
  } finally { db.close(); }
});

test("omitted policy fields preserve the current file rather than stale database values", async () => {
  const { root, config } = fixture();
  const db = new SeptumDatabase(join(root, "state/index.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    repo.upsertDomain("orders", config.domains.orders, root);
    const latest = { ...config, domains: { ...config.domains, orders: { ...config.domains.orders, forbidden_dependencies: ["billing"] } } };
    writeFileSync(join(root, "septum.config.json"), JSON.stringify(latest));
    await handleRegisterDomain(repo, config, { name: "orders", root: "src/orders", description: "Updated description" }, root);
    expect(ConfigLoader.load(undefined, root).domains.orders.forbidden_dependencies).toEqual(["billing"]);
    expect(repo.getDomainByName("orders")?.forbidden_deps_json).toBe('["billing"]');
  } finally { db.close(); }
});

test("custom-database hook rejects a forbidden import through the real CLI", async () => {
  const { root, config } = fixture();
  config.domains.orders.forbidden_dependencies = ["billing"];
  writeFileSync(join(root, "septum.config.json"), JSON.stringify(config));
  writeFileSync(join(root, "src/billing/invoice.ts"), "export const invoice = 1;");
  const db = new SeptumDatabase(join(root, "state/index.db"));
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
  expect(existsSync(join(root, ".septum/septum.db"))).toBe(false);
});
