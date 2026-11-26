import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { SeptumError } from "../../src/core/errors.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { listSeptumResources, readSeptumResource } from "../../src/mcp/resources-and-prompts.ts";
import { TOOL_CATALOG } from "../../src/mcp/tool-catalog.ts";
import { WorkspaceManager } from "../../src/mcp/workspace-manager.ts";
import { handleMapTool } from "../../src/mcp/tools/map.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/slice.ts";
import { handleBoundaryTool } from "../../src/mcp/tools/boundary.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";

describe("MCP Server Audit Fixes & MCP App UI (SEP-1865)", () => {
  it("exposes ui://septum/app.html resource with text/html;profile=mcp-app and serves bundled HTML under 10 MiB", async () => {
    const listed = listSeptumResources();
    const uiRes = listed.resources.find((r) => r.uri === "ui://septum/app.html");
    expect(uiRes).toBeDefined();
    expect(uiRes?.mimeType).toBe("text/html;profile=mcp-app");
    expect((uiRes as any)?._meta?.ui?.prefersBorder).toBe(true);

    const manager = new WorkspaceManager();
    try {
      const read = await readSeptumResource(manager, "ui://septum/app.html");
      expect(read.contents.length).toBe(1);
      const item = read.contents[0]!;
      expect(item.mimeType).toBe("text/html;profile=mcp-app");
      expect(item.text.length).toBeGreaterThan(1000);
      expect(Buffer.byteLength(item.text)).toBeLessThan(10 * 1024 * 1024);
      expect(item.text).toContain("Septum Architecture");
      expect(item.text).toContain("workspace-select");
      expect(item.text).toContain("btn-ask-ai");
      expect(item.text).toContain("ai-prompt-input");
      expect(item.text).toContain("data-preset");
      expect(item.text).toContain("sel-domain");
      expect(item.text).toContain("sel-violation");
      expect(item.text).toContain("btn-fix-coverage");
      expect(item.text).toContain("status-bar");
    } finally {
      await manager.close();
    }
  });

  it("declares _meta.ui.resourceUri and Antigravity aux_pane/global entrypoints only on septum_app, keeping analysis tools inline-free", () => {
    const mapTool = TOOL_CATALOG.find((t) => t.name === "septum_map");
    const sliceTool = TOOL_CATALOG.find((t) => t.name === "septum_slice");
    const boundaryTool = TOOL_CATALOG.find((t) => t.name === "septum_boundary");
    const symbolTool = TOOL_CATALOG.find((t) => t.name === "septum_symbol");
    const appTool = TOOL_CATALOG.find((t) => t.name === "septum_app");

    expect((mapTool?._meta as any)?.ui).toBeUndefined();
    expect((sliceTool?._meta as any)?.ui).toBeUndefined();
    expect((boundaryTool?._meta as any)?.ui).toBeUndefined();
    expect((symbolTool?._meta as any)?.ui).toBeUndefined();

    expect((appTool?._meta as any)?.ui?.resourceUri).toBe("ui://septum/app.html");
    expect((appTool?._meta as any)?.ui?.visibility).toEqual(["app"]);
    expect((appTool?._meta as any)?.["com.google.antigravity/ui"]?.entrypoints).toEqual([
      { type: "aux_pane", title: "Septum Architecture" },
      { type: "global", title: "Septum" },
    ]);
  });

  it("throws typed SeptumError(INVALID_QUERY) when septum_slice query is empty", () => {
    const db = new SeptumDatabase(":memory:");
    const repo = new SeptumRepository(db.raw);
    const config = ConfigLoader.getDefaultConfig();
    try {
      let caught: unknown;
      try {
        handleTraceVerticalSlice(repo, config, { query: "   " });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SeptumError);
      expect((caught as SeptumError).code).toBe("INVALID_QUERY");
    } finally {
      db.close();
    }
  });

  it("returns structuredContent alongside text content across all 4 MCP tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-structured-content-"));
    const db = new SeptumDatabase(":memory:");
    const repo = new SeptumRepository(db.raw);
    const config = ConfigLoader.getDefaultConfig();
    config.domains = {
      app: { root: "src", allowed_dependencies: ["app"], forbidden_dependencies: [], archetypes: {} },
    };

    try {
      mkdirSync(dirname(join(root, "src/index.ts")), { recursive: true });
      writeFileSync(join(root, "src/index.ts"), "export function ping() { return 1; }\n");
      await new IngestionPipeline(repo, root).run(config);

      const mapRes = await handleMapTool(repo, config, { action: "catalog", format: "text", workspace_path: root }, root);
      expect((mapRes as any).structuredContent?.schema).toBe("navigation/v1");
      expect((mapRes as any).structuredContent?.workspace_root).toBe(root);

      const symRes = await handleSymbolTool(repo, config, { action: "locate", query: "ping", format: "text", workspace_path: root }, undefined, root);
      expect((symRes as any).structuredContent?.status).toBe("success");

      const sliceRes = await handleTraceVerticalSlice(repo, config, { query: "ping", format: "text", workspace_path: root }, root);
      expect((sliceRes as any).structuredContent?.query).toBe("ping");
      expect((sliceRes as any).structuredContent?.workspace_root).toBe(root);

      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
      const boundaryRes = await handleBoundaryTool(evaluator, config, { scope: "all", format: "text", workspace_path: root }, repo, root);
      expect((boundaryRes as any).structuredContent?.status).toBe("approved");
      expect((boundaryRes as any).structuredContent?.workspace_root).toBe(root);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports multi-workspace resolution in readSeptumResource via lastRoot and ?workspace= query", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "septum-res-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "septum-res-b-"));
    const manager = new WorkspaceManager();
    try {
      const dbA = new SeptumDatabase(join(rootA, ".septum/septum.db"));
      dbA.close();
      const dbB = new SeptumDatabase(join(rootB, ".septum/septum.db"));
      dbB.close();

      manager.initialRoot = rootA;
      manager.lastRoot = rootB;

      const healthLast = await readSeptumResource(manager, "septum://health");
      expect(JSON.parse(healthLast.contents[0]!.text).workspace_root).toBe(rootB);

      const healthExplicitA = await readSeptumResource(
        manager,
        `septum://health?workspace=${encodeURIComponent(rootA)}`
      );
      expect(JSON.parse(healthExplicitA.contents[0]!.text).workspace_root).toBe(rootA);

      const appsGuide = await readSeptumResource(
        manager,
        `septum://apps?workspace=${encodeURIComponent(rootA)}`
      );
      const parsedApps = JSON.parse(appsGuide.contents[0]!.text);
      expect(parsedApps.ui_resource).toBe("ui://septum/app.html");
      expect(parsedApps.workspace_root).toBe(rootA);
      expect(parsedApps.coverage_status).toBe("partial");
      expect(parsedApps.actionable_actions.length).toBeGreaterThan(0);
    } finally {
      await manager.close();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("strips structuredContent for headless septum_symbol on text format while preserving workspace_root on UI-bound tools", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../../src/mcp/server.ts");

    const root = mkdtempSync(join(tmpdir(), "septum-transport-shaping-"));
    const manager = new WorkspaceManager();
    manager.initialRoot = root;
    const server = createMcpServer(manager);
    const client = new Client({ name: "test-client", version: "1.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      mkdirSync(join(root, ".septum"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "src", allowed_dependencies: ["app"], forbidden_dependencies: [], archetypes: {} },
      };
      writeFileSync(join(root, "septum.config.json"), JSON.stringify(config));
      writeFileSync(join(root, "src/index.ts"), "export function ping() { return 1; }\n");

      const db = new SeptumDatabase(join(root, ".septum/septum.db"));
      const repo = new SeptumRepository(db.raw);
      await new IngestionPipeline(repo, root).run(config);
      db.close();

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const symText = await client.callTool({
        name: "septum_symbol",
        arguments: { action: "locate", query: "ping", format: "text", workspace_path: root },
      });
      expect(symText.structuredContent).toBeUndefined();

      const symJson = await client.callTool({
        name: "septum_symbol",
        arguments: { action: "locate", query: "ping", format: "json", workspace_path: root },
      });
      expect((symJson.structuredContent as any)?.workspace_root).toBe(root);

      const mapText = await client.callTool({
        name: "septum_map",
        arguments: { action: "catalog", format: "text", workspace_path: root },
      });
      expect(mapText.structuredContent).toBeUndefined();

      const appResult = await client.callTool({
        name: "septum_app",
        arguments: { workspace_path: root },
      });
      expect((appResult.structuredContent as any)?.workspace_root).toBe(root);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates unresolved_imports from incomplete_imports and avoids empty-graph message when targets are unindexed", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-partial-coverage-"));
    try {
      mkdirSync(join(root, "src/factories"), { recursive: true });
      mkdirSync(join(root, "src/models"), { recursive: true });
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        factories: { root: "src/factories", allowed_dependencies: ["models"], forbidden_dependencies: [], archetypes: {} },
      };
      writeFileSync(join(root, "septum.config.json"), JSON.stringify(config));
      writeFileSync(join(root, "src/models/user.ts"), "export class User {}\n");
      writeFileSync(join(root, "src/factories/user-factory.ts"), 'import { User } from "../models/user";\nexport const makeUser = () => new User();\n');

      const db = new SeptumDatabase(join(root, ".septum/septum.db"));
      try {
        const repo = new SeptumRepository(db.raw);
        await new IngestionPipeline(repo, root).run(config);

        const nav = await handleMapTool(repo, config, { action: "catalog", domain: "factories", format: "json" }, root);
        const navJson = JSON.parse(nav.content[0]!.text);
        expect(navJson.health.coverage).toBe("partial");
        expect(navJson.health.unresolved_imports).toBe(0);
        expect(navJson.health.incomplete_imports).toBe(1);
        expect(navJson.health.reasons).toContain("target_not_fully_indexed");

        const navText = await handleMapTool(repo, config, { action: "catalog", domain: "factories", format: "text" }, root);
        expect(navText.content[0]!.text).toContain("unresolved=0 incomplete=1");

        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const boundary = await handleBoundaryTool(evaluator, config, { scope: "domain", domain: "factories", format: "json" }, repo, root);
        const boundaryJson = JSON.parse(boundary.content[0]!.text);
        expect(boundaryJson.status).toBe("unknown");
        expect(boundaryJson.incomplete_reasons.target_not_fully_indexed).toBe(1);
        expect(boundaryJson.message).not.toContain("empty graph");
        expect(boundaryJson.message).toContain("1 target(s) not fully indexed");
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads existing SQLite index health in septum://health when workspace context is not loaded in memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "septum-health-readonly-"));
    const manager = new WorkspaceManager();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "src", allowed_dependencies: ["app"], forbidden_dependencies: [], archetypes: {} },
      };
      writeFileSync(join(root, "septum.config.json"), JSON.stringify(config));
      writeFileSync(join(root, "src/index.ts"), "export const ok = true;\n");

      const db = new SeptumDatabase(join(root, ".septum/septum.db"));
      const repo = new SeptumRepository(db.raw);
      await new IngestionPipeline(repo, root).run(config);
      db.close();

      manager.initialRoot = root;
      manager.lastRoot = root;
      const health = JSON.parse((await readSeptumResource(manager, "septum://health")).contents[0]!.text);
      expect(manager.size).toBe(0);
      expect(health.workspace_root).toBe(root);
      expect(health.status).toBe("complete");
      expect(health.sync_state).toBe("complete");
      expect(health.domains_count).toBe(1);
      expect(health.files_count).toBe(1);
      expect(health.context_active).toBe(false);
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses MCP client roots/list (filtering unsafe $HOME) and updates on notifications/roots/list_changed", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const { homedir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const { createMcpServer } = await import("../../src/mcp/server.ts");

    const rootA = mkdtempSync(join(tmpdir(), "septum-roots-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "septum-roots-b-"));
    const manager = new WorkspaceManager();
    const server = createMcpServer(manager);
    const client = new Client(
      { name: "roots-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let advertisedRoots = [
      { uri: pathToFileURL(homedir()).href, name: "home" },
      { uri: pathToFileURL(rootA).href, name: "repoA" },
    ];
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: advertisedRoots }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      for (const root of [rootA, rootB]) {
        mkdirSync(join(root, "src"), { recursive: true });
        const config = ConfigLoader.getDefaultConfig();
        config.domains = {
          app: { root: "src", allowed_dependencies: ["app"], forbidden_dependencies: [], archetypes: {} },
        };
        writeFileSync(join(root, "septum.config.json"), JSON.stringify(config));
        writeFileSync(join(root, "src/index.ts"), "export const ok = true;\n");
        const db = new SeptumDatabase(join(root, ".septum/septum.db"));
        const repo = new SeptumRepository(db.raw);
        await new IngestionPipeline(repo, root).run(config);
        db.close();
      }

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const mapA = await client.callTool({
        name: "septum_map",
        arguments: { action: "catalog", format: "json" },
      });
      expect(manager.clientRoots).toEqual([rootA]);
      expect((mapA.structuredContent as any)?.workspace_root).toBe(rootA);

      const healthA = await client.readResource({ uri: "septum://health" });
      expect(JSON.parse((healthA.contents[0] as { text: string }).text).workspace_root).toBe(rootA);

      advertisedRoots = [{ uri: pathToFileURL(rootB).href, name: "repoB" }];
      await client.sendRootsListChanged();

      const mapB = await client.callTool({
        name: "septum_map",
        arguments: { action: "catalog", format: "json" },
      });
      expect(manager.clientRoots).toEqual([rootB]);
      expect((mapB.structuredContent as any)?.workspace_root).toBe(rootB);

      const explicitA = await client.callTool({
        name: "septum_map",
        arguments: { action: "catalog", format: "json", workspace_path: rootA },
      });
      expect((explicitA.structuredContent as any)?.workspace_root).toBe(rootA);

      const prompt = await client.getPrompt({ name: "open-apps" });
      const promptText = (prompt.messages[0]?.content as { text: string }).text;
      expect(promptText).toContain("workspace_path");
      expect(promptText).toContain("?workspace=<path>");
    } finally {
      await client.close();
      await server.close();
      await manager.close();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
