import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { formatSourceContextAsText, formatDeepContextAsText } from "../../src/mcp/formatters/compact-text.ts";
import { detectArchetype } from "../../src/core/parser/extractors/base.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { auditStagedFiles } from "../../src/core/boundary/staged-auditor.ts";
import { registerDomainPolicy } from "../../src/core/config/domain-registration.ts";
import { buildNavigation } from "../../src/core/discovery/navigation.ts";
import { retrieveContext } from "../../src/core/retrieval/context.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { isResolutionInput } from "../../src/core/resolver/interpretation-inputs.ts";
import { createSyncProgressReporter } from "../../src/cli/commands/sync-progress.ts";
import { evaluateBoundary } from "../../src/core/boundary/audit.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { rebuildSliceCatalog } from "../../src/core/resolver/slice-catalog.ts";

describe("Evaluation Report Remediation Suite", () => {
  describe("Fase 1: Quick Wins", () => {
    it("formatSourceContextAsText renders source_slice.text when format=text", () => {
      const payload = {
        symbol: "execute_graphql_request",
        kind: "method",
        file_path: "saleor/graphql/views.py",
        exact_range: { start_line: 364, end_line: 383, total_lines: 20 },
        retrieval: { freshness: "current" },
        source_slice: {
          status: "current",
          start_line: 364,
          end_line: 383,
          truncated: true,
          next_start_line: 384,
          text: "    def execute_graphql_request(self, request):\n        return self.parse_query()",
        },
      };

      const text = formatSourceContextAsText(payload);
      expect(text).toContain("## Source (L364-383, next_start_line=384)");
      expect(text).toContain("def execute_graphql_request(self, request):");
      expect(text).toContain("return self.parse_query()");
    });

    it("detectArchetype correctly identifies Django models.py and ASGI middleware", () => {
      expect(detectArchetype("saleor/order/models.py", {})).toBe("model");
      expect(detectArchetype("saleor/product/models.py", {})).toBe("model");
      expect(detectArchetype("saleor/order/model.py", {})).toBe("model");
      expect(detectArchetype("saleor/asgi/cors_handler.py", {})).toBe("middleware");
      expect(detectArchetype("saleor/asgi/asgi_handler.py", {})).toBe("middleware");
      expect(detectArchetype("saleor/graphql/views.py", {})).toBe("controller");
    });
  });

  describe("Fase 2: Git & Boundary Hardening", () => {
    it("auditStagedFiles ignores non-source symlinks like documentation files", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-staged-symlink-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      try {
        execFileSync("git", ["init", "-q"], { cwd: root });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root });

        // Add a regular source file
        writeFileSync(join(root, "main.ts"), "export const x = 1;\n");
        // Add a doc file and a symlink pointing to it
        writeFileSync(join(root, "README.md"), "# Hello\n");
        symlinkSync("README.md", join(root, "CLAUDE.md"));

        execFileSync("git", ["add", "main.ts", "README.md", "CLAUDE.md"], { cwd: root });

        const config = ConfigLoader.getDefaultConfig();
        config.domains = { root: { root: ".", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };

        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const result = await auditStagedFiles(evaluator, config, root, repo);

        expect(result.files).toContain("main.ts");
        expect(result.violations).toEqual([]);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("registerDomainPolicy rebinds indexed files so navigation finds them without full reingestion", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-domain-rebind-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = { root: { root: ".", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put("saleor/order/models.py", "class Order: pass\n");
        put("saleor/core/utils.py", "def helper(): pass\n");

        await new IngestionPipeline(repo, root).run(config);

        // Register domain 'order_test' with root 'saleor/order' (ingest_now: false)
        await registerDomainPolicy(repo, config, {
          domain: "order_test",
          root: "saleor/order",
          ingest_now: false,
        }, root);

        const nav = buildNavigation(repo, { domain: "order_test" }, root);
        expect(nav.status).toBe("success");
        expect(nav.files.length).toBe(1);
        expect(nav.files[0]!.path).toBe("saleor/order/models.py");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Fase 3 & 4: Python Semantics & Deep Context", () => {
    it("retrieveContext on Python symbol returns universal context with implementation and callees", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-python-context-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = { saleor: { root: "saleor", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put("requirements.txt", "graphql-core>=3.2.0\n");
        put(
          "saleor/graphql/views.py",
          `from graphql import GraphQLBackend

class GraphQLView:
    def get_graphql_params(self, request):
        return {"params": True}

    def execute_graphql_request(self, request):
        params = self.get_graphql_params(request)
        return params
`
        );

        await new IngestionPipeline(repo, root).run(config);

        // Test deep context on GraphQLView::execute_graphql_request
        const res = await retrieveContext(repo, config, {
          symbol: "GraphQLView::execute_graphql_request",
          file_path: "saleor/graphql/views.py",
        }, root);

        const text = res.content[0]!.text;
        const parsed = JSON.parse(text);

        expect(parsed.status).toBe("success");
        expect(parsed.policy).toBe("referenced-universal-declarations/v1");
        expect(parsed.items.some((i: any) => i.name === "GraphQLView::execute_graphql_request")).toBe(true);

        // Formatted as text should include Python code fence
        const formatted = formatDeepContextAsText(parsed);
        expect(formatted).toContain("# Septum Deep Context");
        expect(formatted).toContain("```python");
        expect(formatted).toContain("def execute_graphql_request");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("evaluator correctly tags pre-existing circular dependencies and does not blame clean proposed imports", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-cycle-noise-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        core: { root: "core", allowed_dependencies: ["core"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        // Create an existing circular dependency: a -> b -> a
        put("core/a.ts", "import './b.ts';\nexport const a = 1;\n");
        put("core/b.ts", "import './a.ts';\nexport const b = 2;\n");

        await new IngestionPipeline(repo, root).run(config);

        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        // Proposed import to a non-cyclical new file
        // Propose import './b.ts' which keeps the existing cycle between a and b
        const violations = evaluator.evaluate("core/a.ts", ["./b.ts"], config);

        // The pre-existing cycle between a and b should be marked pre_existing: true
        const preExisting = violations.filter(v => v.pre_existing);
        expect(preExisting.length).toBeGreaterThan(0);
        expect(preExisting[0]!.rule).toBe("circular_dependency");
        expect(preExisting[0]!.pre_existing).toBe(true);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Fase 5: Retest Report Fundamental Fixes", () => {
    it("auditStagedFiles ignores oversized non-manifest YAML/JSON cassettes and fast-paths empty staged diffs", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-staged-cassette-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        saleor: { root: "saleor", allowed_dependencies: ["saleor"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        expect(isResolutionInput("saleor/plugins/avatax/tests/cassettes/test_avatax.yaml")).toBe(false);
        expect(isResolutionInput("pyproject.toml")).toBe(true);
        expect(isResolutionInput("requirements/base.txt")).toBe(true);

        execFileSync("git", ["init", "-q"], { cwd: root });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root });

        put("saleor/app.py", "def run():\n    return 1\n");
        // >2MB YAML cassette in git tree (matches real Saleor failure mode)
        put("saleor/tests/cassettes/big.yaml", "body: " + "x".repeat(2_300_000) + "\n");
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

        await new IngestionPipeline(repo, root).run(config);
        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));

        // 1. Empty staged diff fast-paths cleanly
        const emptyResult = await auditStagedFiles(evaluator, config, root, repo);
        expect(emptyResult.files).toEqual([]);
        expect(emptyResult.violations).toEqual([]);

        // 2. Staging a Python file still succeeds despite >2MB YAML cassette in tree
        put("saleor/app.py", "def run():\n    return 2\n");
        execFileSync("git", ["add", "saleor/app.py"], { cwd: root });
        const stagedResult = await auditStagedFiles(evaluator, config, root, repo);
        expect(stagedResult.files).toEqual(["saleor/app.py"]);
        expect(stagedResult.violations).toEqual([]);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("DjangoSemanticExtractor discovers management commands as CLI slices searchable by snake_case and PascalCase", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-django-cli-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        saleor: { root: "saleor", allowed_dependencies: ["saleor"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put("manage.py", "#!/usr/bin/env python\n");
        put(
          "saleor/app/management/commands/app_set_active.py",
          [
            "from django.core.management.base import BaseCommand",
            "",
            "class Command(BaseCommand):",
            "    def handle(self, *args, **options):",
            "        return True",
          ].join("\n")
        );

        await new IngestionPipeline(repo, root).run(config);

        const bySnake = repo.findVerticalSlices("app_set_active");
        expect(bySnake.length).toBe(1);
        expect(bySnake[0]!.http_method).toBe("CLI");
        expect(bySnake[0]!.route_uri).toBe("command:app_set_active");
        expect(bySnake[0]!.controller_class).toBe("Command");
        expect(bySnake[0]!.action_name).toBe("handle");
        expect(bySnake[0]!.controller_file).toBe("saleor/app/management/commands/app_set_active.py");

        const byPascal = repo.findVerticalSlices("AppSetActive");
        expect(byPascal.length).toBe(1);
        expect(byPascal[0]!.route_uri).toBe("command:app_set_active");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("impact does not attribute cls.call_event() method calls to standalone function call_event", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-impact-cls-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        saleor: { root: "saleor", allowed_dependencies: ["saleor"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put(
          "saleor/core/utils/events.py",
          "def call_event(func_obj, *args):\n    return func_obj(*args)\n"
        );
        put(
          "saleor/graphql/warehouse/mutations/warehouse_delete.py",
          [
            "from ....core.utils.events import call_event",
            "",
            "class WarehouseDelete:",
            "    @classmethod",
            "    def perform_mutation(cls):",
            "        call_event(lambda: None)",
            "",
            "    @classmethod",
            "    def post_save_action(cls):",
            "        cls.call_event(lambda: None)",
          ].join("\n")
        );

        await new IngestionPipeline(repo, root).run(config);

        const res = await handleSymbolTool(
          repo,
          config,
          {
            action: "impact",
            query: "call_event",
            file_path: "saleor/core/utils/events.py",
            format: "json",
            workspace_path: root,
          },
          undefined,
          root
        );
        const payload = JSON.parse(res.content[0]!.text);
        const callSites = payload.call_sites as Array<{ caller: string; line: number }>;
        expect(callSites.some((c) => c.caller === "WarehouseDelete::perform_mutation" && c.line === 6)).toBe(true);
        expect(callSites.some((c) => c.caller === "WarehouseDelete::post_save_action" && c.line === 10)).toBe(false);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("context mode rejects empty target with invalid_query instead of matching unrelated symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-empty-target-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        saleor: { root: "saleor", allowed_dependencies: ["saleor"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put("saleor/models.py", "class EditorJSEmbedDataModel:\n    source = None\n");
        await new IngestionPipeline(repo, root).run(config);

        expect(repo.findSymbolsByName("")).toEqual([]);

        const res = await handleSymbolTool(
          repo,
          config,
          {
            action: "context",
            context_mode: "source",
            source_line_limit: 4,
            source_start_line: 23,
            format: "json",
            workspace_path: root,
          },
          undefined,
          root
        );
        const payload = JSON.parse(res.content[0]!.text);
        expect(payload.status).toBe("invalid_query");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("createSyncProgressReporter renders shared TTY phase progress and cleans up inline lines", () => {
      const writes: string[] = [];
      const logs: string[] = [];
      const reporter = createSyncProgressReporter({
        prefix: "| ",
        isTty: true,
        write: (s) => writes.push(s),
        log: (s) => logs.push(s),
      });

      reporter.onProgress({ phase: "scanning", status: "start", total: 0 });
      reporter.onProgress({ phase: "scanning", status: "done", total: 12 });
      reporter.onProgress({ phase: "parsing", status: "progress", processed: 5, total: 12 });
      reporter.onProgress({ phase: "parsing", status: "done", processed: 12, total: 12 });
      reporter.onProgress({ phase: "resolving", status: "done", symbols: 20, dependencies: 4 });
      reporter.onProgress({ phase: "linking", status: "start", slices: 0 });
      reporter.onProgress({ phase: "linking", status: "done", slices: 3 });

      expect(writes.some((w) => w.includes("Scanning files..."))).toBe(true);
      expect(writes.some((w) => w.includes("Parsing code — 5/12"))).toBe(true);
      expect(logs.some((l) => l.includes("| ") && l.includes("Scanning files — 12 found"))).toBe(true);
      expect(logs.some((l) => l.includes("Linking entrypoints & slices — done (3 slices)"))).toBe(true);
    });
  });

  describe("Fase 6: Multi-Framework GraphQL, CBV Wrapper, Staged Scope & Method-Scoped Slice", () => {
    it("extracts decorated Django CBV GraphQL endpoint (csrf_exempt(GraphQLView.as_view(...))) and resolves ANY /graphql/ & GraphQLView", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-django-graphql-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        saleor: { root: "saleor", allowed_dependencies: ["saleor"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put("manage.py", "#!/usr/bin/env python\n");
        put("saleor/__init__.py", "");
        put("saleor/graphql/__init__.py", "");
        put("saleor/graphql/api.py", "schema = object()\n");
        put(
          "saleor/graphql/views.py",
          [
            "from django.views.generic import View",
            "",
            "class GraphQLView(View):",
            "    def dispatch(self, request, *args, **kwargs):",
            "        return None",
          ].join("\n")
        );
        put(
          "saleor/graphql/management/commands/get_graphql_schema.py",
          [
            "class Command:",
            "    def handle(self, *args, **options):",
            "        return 'schema'",
          ].join("\n")
        );
        put(
          "saleor/urls.py",
          [
            "from django.urls import re_path",
            "from django.views.decorators.csrf import csrf_exempt",
            "from .graphql.api import schema",
            "from .graphql.views import GraphQLView",
            "",
            "urlpatterns = [",
            '    re_path(r"^graphql/$", csrf_exempt(GraphQLView.as_view(schema=schema)), name="api"),',
            "]",
          ].join("\n")
        );

        await new IngestionPipeline(repo, root).run(config);
        await rebuildSliceCatalog(repo, root, { ignorePatterns: [] });

        const tracer = new VerticalSliceTracer(repo, root);
        const byUri = tracer.trace("ANY /graphql/");
        expect(byUri.found).toBe(true);
        expect(byUri.architecture_style).toBe("django-graphql");
        expect(byUri.entrypoint?.controller).toBe("GraphQLView");
        expect(byUri.entrypoint?.action).toBe("dispatch");
        expect(byUri.chain?.some((n) => n.stage === "validation" && n.symbol === "schema")).toBe(true);

        const byClass = tracer.trace("GraphQLView");
        expect(byClass.found).toBe(true);
        expect(byClass.confidence).toBe("exact");
        expect(byClass.entrypoint?.uri).toBe("/graphql");
        expect(byClass.entrypoint?.controller).toBe("GraphQLView");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("normalizes Express app.use('/graphql', graphqlHTTP(...)) through shared GraphQL entrypoint normalizer", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-express-graphql-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        app: { root: "src", allowed_dependencies: ["app"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put("package.json", JSON.stringify({ dependencies: { express: "^4.18.0", "express-graphql": "^0.12.0" } }));
        put(
          "src/server.ts",
          [
            'import express from "express";',
            'import { graphqlHTTP } from "express-graphql";',
            "const schema = {};",
            "const app = express();",
            'app.use("/graphql", graphqlHTTP({ schema }));',
          ].join("\n")
        );

        await new IngestionPipeline(repo, root).run(config);
        await rebuildSliceCatalog(repo, root, { ignorePatterns: [] });

        const tracer = new VerticalSliceTracer(repo, root);
        const res = tracer.trace("ANY /graphql");
        expect(res.found).toBe(true);
        expect(res.architecture_style).toBe("graphql");
        expect(res.entrypoint?.uri).toBe("/graphql");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("boundary(scope='staged') approves clean staged file even when unrelated workspace files have unresolved imports", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-staged-scope-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        saleor: { root: "saleor", allowed_dependencies: ["saleor"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        execFileSync("git", ["init", "-q"], { cwd: root });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root });

        put("pyproject.toml", '[project]\nname = "saleor"\n');
        put("saleor/account/forms.py", "import phonenumbers\n");
        put("saleor/core/events.py", "def call_event(fn):\n    return fn()\n");

        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });

        await new IngestionPipeline(repo, root).run(config);

        // Stage a comment-only edit in saleor/core/events.py
        put("saleor/core/events.py", "# clean comment\ndef call_event(fn):\n    return fn()\n");
        execFileSync("git", ["add", "saleor/core/events.py"], { cwd: root });

        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const verdict = await evaluateBoundary(evaluator, config, { scope: "staged" }, repo, root);

        expect(verdict.payload.status).toBe("approved");
        expect((verdict.payload as { total_checked?: number }).total_checked).toBe(1);
        expect((verdict.payload as { total_violations?: number }).total_violations).toBe(0);
        expect((verdict.payload as { resolution_issues?: unknown[] }).resolution_issues).toEqual([]);
        expect((verdict.payload as { background_resolution_issues_count?: number }).background_resolution_issues_count).toBe(1);

        // Now stage the file that actually has an unresolved import -> must report unknown
        execFileSync("git", ["add", "saleor/account/forms.py"], { cwd: root });
        put("saleor/account/forms.py", "# touched\nimport phonenumbers\n");
        execFileSync("git", ["add", "saleor/account/forms.py"], { cwd: root });

        const dirtyVerdict = await evaluateBoundary(evaluator, config, { scope: "staged" }, repo, root);
        expect(dirtyVerdict.payload.status).toBe("unknown");
        expect(((dirtyVerdict.payload as { resolution_issues?: unknown[] }).resolution_issues ?? []).length).toBe(1);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("CLI slice for Command::handle resolves parse_id and excludes parse_bool from combined import", async () => {
      const root = mkdtempSync(join(tmpdir(), "septum-cli-slice-"));
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.getDefaultConfig();
      config.domains = {
        saleor: { root: "saleor", allowed_dependencies: ["saleor"], forbidden_dependencies: [], archetypes: {} },
      };

      const put = (p: string, s: string) => {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), s);
      };

      try {
        put("manage.py", "#!/usr/bin/env python\n");
        put("saleor/__init__.py", "");
        put("saleor/app/__init__.py", "");
        put("saleor/app/management/__init__.py", "");
        put("saleor/app/management/commands/__init__.py", "");
        put(
          "saleor/app/management/commands/utils.py",
          [
            "class JSONLinesCommand:",
            "    pass",
            "",
            "def parse_bool(value):",
            "    return bool(value)",
            "",
            "def parse_id(value, expected_type):",
            "    return int(value)",
          ].join("\n")
        );
        put(
          "saleor/app/management/commands/app_set_active.py",
          [
            "from .utils import JSONLinesCommand, parse_bool, parse_id",
            "",
            "class Command(JSONLinesCommand):",
            "    def add_arguments(self, parser):",
            "        parse_bool('true')",
            "",
            "    def handle(self, *args, **options):",
            "        pk = parse_id(options['id'], 'App')",
            "        return pk",
          ].join("\n")
        );

        await new IngestionPipeline(repo, root).run(config);
        await rebuildSliceCatalog(repo, root, { ignorePatterns: [] });

        const tracer = new VerticalSliceTracer(repo, root);
        const slice = tracer.trace("app_set_active");
        expect(slice.found).toBe(true);
        expect(slice.entrypoint?.controller).toBe("Command");
        expect(slice.entrypoint?.action).toBe("handle");
        const symbols = (slice.chain ?? []).map((n) => n.symbol);
        expect(symbols).toContain("parse_id");
        expect(symbols).not.toContain("parse_bool");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
