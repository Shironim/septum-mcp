import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { TopologyDetector } from "../../src/core/discovery/topology-detector.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { SEPTUM_POST_WRITE_SCRIPT, SEPTUM_PRE_WRITE_SCRIPT } from "../../src/cli/templates/hooks.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { WorkspaceManager } from "../../src/mcp/workspace-manager.ts";
import {
  getSeptumPrompt,
  listSeptumPrompts,
  listSeptumResources,
  readSeptumResource,
} from "../../src/mcp/resources-and-prompts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), "septum-audit-fixes-"));
  roots.push(root);
  const put = (file: string, content: string) => {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  return { root, put };
}

describe("Audit fixes verification", () => {
  it("rejects unmapped internal targets in strict mode", () => {
    const { root, put } = createTempProject();
    put("src/orders/service.ts", "export const order = 1;\n");
    put("src/legacy/helper.ts", "export const legacy = 1;\n");

    const config = ConfigLoader.getDefaultConfig();
    config.settings.enforcement = "strict";
    config.domains = {
      orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };

    const db = new SeptumDatabase(":memory:");
    try {
      const repo = new SeptumRepository(db.raw);
      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
      const violations = evaluator.checkProposedChanges(
        "src/orders/service.ts",
        ["../legacy/helper"],
        config
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe("unmapped_domain");
      expect(violations[0]?.target_domain).toBe("unmapped");
    } finally {
      db.close();
    }
  });

  it("generates matching Go domain names in forbidden_dependencies and allowed_dependencies", () => {
    const { root, put } = createTempProject();
    put("go.mod", "module example.com/app\ngo 1.22\n");
    put("pkg/util/util.go", "package util\n");
    put("internal/auth/auth.go", "package auth\n");
    put("internal/billing/billing.go", "package billing\n");
    put("cmd/server/main.go", "package main\n");

    const topology = TopologyDetector.detect(root);
    expect(topology.domains.pkg?.forbidden_dependencies).toEqual(["auth", "billing", "cmd-server"]);
    expect(topology.domains.auth?.forbidden_dependencies).toEqual(["cmd-server"]);
    expect(topology.domains["cmd-server"]?.allowed_dependencies).toEqual(["pkg", "auth", "billing"]);
  });

  it("guards hook wrapper scripts on .septum/septum.db existence", () => {
    expect(SEPTUM_PRE_WRITE_SCRIPT).toContain('[ ! -f "$ROOT_DIR/.septum/septum.db" ]');
    expect(SEPTUM_POST_WRITE_SCRIPT).toContain('[ ! -f "$ROOT_DIR/.septum/septum.db" ]');
    expect(SEPTUM_POST_WRITE_SCRIPT).toContain('mkdir -p "$ROOT_DIR/.septum"');
  });

  it("exposes start_line/end_line on locate results and honors budget_bytes for non-TS context", async () => {
    const { root, put } = createTempProject();
    put(
      "src/worker.py",
      "def process_items():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    return a + b + c + d\n"
    );

    const config = ConfigLoader.getDefaultConfig();
    config.domains = {
      app: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };

    const db = new SeptumDatabase(":memory:");
    try {
      const repo = new SeptumRepository(db.raw);
      await new IngestionPipeline(repo, root).run(config);

      const locateRes = JSON.parse(
        (await handleSymbolTool(repo, config, SymbolToolSchema.parse({ action: "locate", query: "process_items" , format: "json"}), undefined, root)).content[0]!.text
      );
      expect(locateRes.exact_symbol.start_line).toBe(1);
      expect(locateRes.exact_symbol.end_line).toBe(6);

      const ctxRes = JSON.parse(
        (
          await handleSymbolTool(
            repo,
            config,
            SymbolToolSchema.parse({ action: "context", query: "process_items", file_path: "src/worker.py", budget_bytes: 2048 , format: "json"}),
            undefined,
            root
          )
        ).content[0]!.text
      );
      expect(ctxRes.context_mode).toBe("source");
      expect(ctxRes.source_slice.status).toBe("current");
    } finally {
      db.close();
    }
  });

  it("supports .tsx files in deep context and resolves imported hooks/components", async () => {
    const { root, put } = createTempProject();
    put("src/hooks/useOrder.ts", "export function useOrder(id: string) { return { id, total: 100 }; }\n");
    put(
      "src/components/OrderView.tsx",
      "import { useOrder } from '../hooks/useOrder';\nexport function OrderView({ id }: { id: string }) {\n  const order = useOrder(id);\n  return <div className=\"order\">{order.total}</div>;\n}\n"
    );

    const config = ConfigLoader.getDefaultConfig();
    config.domains = {
      app: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };

    const db = new SeptumDatabase(":memory:");
    try {
      const repo = new SeptumRepository(db.raw);
      await new IngestionPipeline(repo, root).run(config);

      const res = JSON.parse(
        (
          await handleSymbolTool(
            repo,
            config,
            SymbolToolSchema.parse({ action: "context", query: "OrderView", file_path: "src/components/OrderView.tsx" , format: "json"}),
            undefined,
            root
          )
        ).content[0]!.text
      );
      expect(res.context_mode).toBe("deep");
      expect(res.items.some((item: any) => item.kind === "source" && item.name === "OrderView")).toBe(true);
      expect(res.items.some((item: any) => item.kind === "source" && item.name === "useOrder")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("exposes MCP resources and prompts for active workspaces", async () => {
    const { root, put } = createTempProject();
    put("src/orders/service.ts", "export function createOrder() { return 1; }\n");

    expect(listSeptumResources().resources.map((r) => r.uri)).toEqual([
      "septum://domains",
      "septum://health",
      "septum://boundaries",
      "septum://apps",
      "ui://septum/app.html",
    ]);
    expect(listSeptumPrompts().prompts.map((p) => p.name)).toEqual([
      "open-apps",
      "audit-coupling",
      "check-staged",
      "plan-refactor",
      "trace-feature",
    ]);

    const appsPrompt = getSeptumPrompt("open-apps");
    expect(appsPrompt.messages[0]?.content.text).toContain("septum_map");
    expect(appsPrompt.messages[0]?.content.text).toContain("septum://apps");

    const spaghetti = getSeptumPrompt("audit-coupling", { domain: "", workspace_path: "" });
    expect(spaghetti.messages[0]?.content.text).toContain("circular dependencies");

    const preCommit = getSeptumPrompt("check-staged");
    expect(preCommit.messages[0]?.content.text).toContain("staged");

    const refactorPlan = getSeptumPrompt("plan-refactor");
    expect(refactorPlan.messages[0]?.content.text).toContain("impact");

    const traceFeature = getSeptumPrompt("trace-feature");
    expect(traceFeature.messages[0]?.content.text).toContain("septum_slice");

    const prompt = getSeptumPrompt("plan-refactor", { target: "createOrder" });
    expect(prompt.messages[0]?.content.text).toContain("createOrder");

    const manager = new WorkspaceManager();
    manager.initialRoot = root;
    manager.lastRoot = root;
    try {
      const unindexed = JSON.parse((await readSeptumResource(manager, "septum://health")).contents[0]!.text);
      expect(unindexed).toEqual({ workspace_root: root, status: "not_indexed" });
      expect(manager.size).toBe(0);
      expect(existsSync(join(root, ".septum/septum.db"))).toBe(false);

      const lease = manager.acquire(root);
      try {
        await lease.context.ready;
      } finally {
        lease.release();
      }

      const domains = JSON.parse((await readSeptumResource(manager, "septum://domains")).contents[0]!.text);
      expect(domains.domains.some((d: any) => d.name === "orders")).toBe(true);

      const health = JSON.parse((await readSeptumResource(manager, "septum://health")).contents[0]!.text);
      expect(health.workspace_root).toBe(root);
      expect(health.status).toBe("complete");
      expect(health.domains_count).toBe(1);
      expect(health.files_count).toBe(1);
      expect(typeof health.last_sync).toBe("string");

      const boundaries = JSON.parse((await readSeptumResource(manager, "septum://boundaries")).contents[0]!.text);
      expect(boundaries.status).toBe("approved");
    } finally {
      await manager.close();
    }
  });
});
