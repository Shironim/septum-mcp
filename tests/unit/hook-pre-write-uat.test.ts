import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";

const BIN_PATH = path.resolve(import.meta.dir, "../../bin/septum.ts");

function createHookWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-uat-"));
  fs.mkdirSync(path.join(root, "src/billing"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/orders"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/shared"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/orders/order.ts"), "export const order = 1;\n");
  fs.writeFileSync(path.join(root, "src/shared/money.ts"), "export const money = 1;\n");
  const db = new SeptumDatabase(path.join(root, ".septum/septum.db"));
  try {
    const repo = new SeptumRepository(db.raw);
    repo.setMeta("settings_json", JSON.stringify({ enforcement: "strict", db_path: ".septum/septum.db", ignore_patterns: [] }));
    repo.upsertDomain("billing", { root: "src/billing", allowed_dependencies: ["shared"], forbidden_dependencies: ["orders"] }, root);
    repo.upsertDomain("orders", { root: "src/orders", allowed_dependencies: ["shared"], forbidden_dependencies: [] }, root);
    repo.upsertDomain("shared", { root: "src/shared", allowed_dependencies: [], forbidden_dependencies: ["billing", "orders"] }, root);
  } finally {
    db.close();
  }
  return root;
}

function runPreWriteCli(cwd: string, payload: string, extraArgs: string[] = []) {
  return spawnSync("bun", ["run", BIN_PATH, "hook", "pre-write", ...extraArgs], {
    cwd,
    input: payload,
    encoding: "utf-8",
    env: { ...process.env, SEPTUM_HOOK_ROOT: cwd },
  });
}

describe("UAT: septum hook pre-write (Real CLI Seam & SQLite SSOT)", () => {
  it("allows valid import using SQLite SSOT", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(
        root,
        JSON.stringify({
          tool_input: {
            file_path: "src/billing/invoice.ts",
            content: 'import { money } from "../shared/money";\nexport const ok = money;\n',
          },
        })
      );

      expect(res.status).toBe(0);
      const decision = JSON.parse(res.stdout.trim());
      expect(decision.decision).toBe("allow");
      expect(decision.coverage).toBe("complete_candidate");
      expect(decision.evaluated).toBe("proposed_imports");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks forbidden cross-domain import with exit code 1 (default) and 2 (--claude)", () => {
    const root = createHookWorkspace();
    try {
      const payload = JSON.stringify({
        tool_input: {
          file_path: "src/billing/invoice.ts",
          content: 'import { order } from "../orders/order";\nexport const bad = order;\n',
        },
      });

      const defaultRes = runPreWriteCli(root, payload);
      expect(defaultRes.status).toBe(1);
      expect(JSON.parse(defaultRes.stdout.trim()).decision).toBe("deny");
      expect(defaultRes.stderr).toContain("OFFENDING IMPORT");

      const claudeRes = runPreWriteCli(root, payload, ["--claude"]);
      expect(claudeRes.status).toBe(2);
      expect(JSON.parse(claudeRes.stdout.trim()).decision).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks path traversal outside workspace root before reading or evaluating", () => {
    const root = createHookWorkspace();
    try {
      const res = runPreWriteCli(
        root,
        JSON.stringify({
          tool_input: {
            file_path: "../../etc/passwd",
            content: "root:x:0:0",
          },
        })
      );

      expect(res.status).toBe(1);
      expect(JSON.parse(res.stdout.trim()).decision).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes through malformed JSON or unsupported payloads safely without crashing", () => {
    const root = createHookWorkspace();
    try {
      const malformed = runPreWriteCli(root, "{not-valid-json");
      expect(malformed.status).toBe(0);

      const unsupported = runPreWriteCli(root, JSON.stringify({ tool_name: "read_file", tool_input: { query: "x" } }));
      expect(unsupported.status).toBe(0);
      const decision = JSON.parse(unsupported.stdout.trim());
      expect(decision.decision).toBe("allow");
      expect(decision.coverage).toBe("unknown");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
