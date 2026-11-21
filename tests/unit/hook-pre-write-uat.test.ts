import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN_PATH = path.resolve(import.meta.dir, "../../bin/septum.ts");

function createHookWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-uat-"));
  fs.mkdirSync(path.join(root, "src/billing"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/orders"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/shared"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/orders/order.ts"), "export const order = 1;\n");
  fs.writeFileSync(path.join(root, "src/shared/money.ts"), "export const money = 1;\n");
  fs.writeFileSync(
    path.join(root, "septum.config.json"),
    JSON.stringify(
      {
        version: "1.0",
        settings: { enforcement: "strict", db_path: ".septum/septum.db", ignore_patterns: [] },
        domains: {
          billing: {
            root: "src/billing",
            allowed_dependencies: ["shared"],
            forbidden_dependencies: ["orders"],
          },
          orders: {
            root: "src/orders",
            allowed_dependencies: ["shared"],
            forbidden_dependencies: [],
          },
          shared: {
            root: "src/shared",
            allowed_dependencies: [],
            forbidden_dependencies: ["billing", "orders"],
          },
        },
      },
      null,
      2
    )
  );
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

describe("UAT: septum hook pre-write (Real CLI Seam & Zero-SQLite Fast Path)", () => {
  it("allows valid import using septum.config.json without creating or opening SQLite", () => {
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
      // Dual-boundary check: SQLite DB must not be created on Zero-SQLite fast path
      expect(fs.existsSync(path.join(root, ".septum/septum.db"))).toBe(false);
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
      expect(fs.existsSync(path.join(root, ".septum/septum.db"))).toBe(false);

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
