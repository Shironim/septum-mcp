import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { ImportResolver } from "../../src/core/resolver/import-resolver.ts";
import { collectSourceSkips } from "../../src/core/resources/source-files.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { auditStagedFiles } from "../../src/core/boundary/staged-auditor.ts";
import { execFileSync } from "node:child_process";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { buildNavigation } from "../../src/core/discovery/navigation.ts";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";
import { WorkspaceWatcher, WatchBudget } from "../../src/mcp/workspace-watcher.ts";
import { SerialWorkQueue } from "../../src/core/resources/work-queue.ts";
let root: string;
beforeEach(() => { root = mkdtempSync("/tmp/septum-multiresolver-"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(file: string, text: string) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
function resolve(target: string, source: string, statement?: string) { return new ImportResolver(root).resolve(target, source, statement); }
function files(target: string, source: string, statement?: string) { return resolve(target, source, statement).targets.flatMap(target => target.files); }

test("Python uses the nearest manifest and does not leak sibling/root dependencies", () => {
  put("requirements.txt", "root_only\n"); put("services/billing/requirements.txt", "fastapi\n");
  expect(resolve("fastapi", "services/billing/main.py").status).toBe("external");
  expect(resolve("root_only", "services/billing/main.py").status).toBe("unresolved");
  expect(resolve("fastapi", "services/payments/main.py").status).toBe("unresolved");
});
test("Python reads dependency sections, aliases, include files and lock transitive packages", () => {
  put("pyproject.toml", '[project]\nname="example"\ndependencies = ["PyJWT>=2", "python-jose"]\n[tool.unrelated]\nphantom="1"\n');
  expect(resolve("jwt", "main.py").status).toBe("external"); expect(resolve("jose", "main.py").status).toBe("external");
  expect(resolve("phantom", "main.py").status).toBe("unresolved");
  put("requirements.txt", "-r requirements/base.txt\n"); put("requirements/base.txt", "requests\n");
  expect(resolve("requests", "main.py").status).toBe("external");
  put("poetry.lock", '[[package]]\nname="urllib3"\nversion="2.0"\n'); expect(resolve("urllib3", "main.py").status).toBe("external");
  put("uv.lock", 'version=1\n[[package]]\nname="PyYAML"\nversion="6.0"\n'); expect(resolve("yaml", "main.py").status).toBe("external");
  put("Pipfile.lock", '{"default":{"pydantic":{"version":"==2"}}}'); expect(resolve("pydantic", "main.py").status).toBe("external");
});
test("Python metadata errors, includes escaping and unknown module aliases remain explicit", () => {
  put("requirements.txt", "some-distribution\n"); expect(resolve("different_module", "main.py").status).toBe("unresolved");
  put("requirements.txt", "-r ../escape.txt\n"); expect(resolve("requests", "main.py").reason).toContain("outside_workspace");
  put("requirements.txt", "-r requirements.txt\n"); expect(resolve("requests", "main.py").reason).toContain("cycle");
});

test("Python lockfile path distributions resolve local source rather than hide it as external", () => {
  put("app/pyproject.toml", '[project]\nname="app"\n');
  put("app/uv.lock", 'version=1\n[[package]]\nname="shared"\nsource={editable="../shared"}\n');
  put("shared/src/shared/__init__.py", "class Thing: pass\n");
  expect(files("shared", "app/main.py")).toEqual(["shared/src/shared/__init__.py"]);
  rmSync(join(root, "shared/src/shared/__init__.py"));
  expect(resolve("shared", "app/main.py").status).toBe("unresolved");
});
test("Python nested manifest creation and edits change observed resolution identity", async () => {
  put("requirements.txt", "requests\n"); put("app/main.py", "import requests\n");
  await expect(collectSourceSkips(root, async () => {
    expect(resolve("requests", "app/main.py").status).toBe("external");
    put("app/requirements.txt", "other\n"); return true;
  })).rejects.toThrow("Source changed during synchronization");
  const before = resolve("requests", "app/main.py"); put("app/requirements.txt", "requests\n");
  expect(resolve("requests", "app/main.py").config_revision).not.toBe(before.config_revision);
});

test("Go resolves a workspace sibling module and a local replacement", () => {
  put("go.work", "go 1.22\nuse (\n ./apps/api\n ./libs/common\n)\n");
  put("apps/api/go.mod", "module example/api\nrequire example/common v1.0.0\n");
  put("libs/common/go.mod", "module example/common\n"); put("libs/common/lib.go", "package common\n");
  expect(files("example/common", "apps/api/main.go")).toEqual(["libs/common/lib.go"]);
  expect(resolve("fmt", "apps/api/main.go").status).toBe("external");
  rmSync(join(root, "go.work"));
  put("apps/api/go.mod", "module example/api\nrequire example/common v1.0.0\nreplace (\nexample/common => ../../libs/common\n)\n");
  expect(files("example/common", "apps/api/main.go")).toEqual(["libs/common/lib.go"]);
});
test("Go replacement precedence, version constraints and module prefix boundaries", () => {
  put("go.mod", "module example/app\nrequire example/shared v1.0.0\nreplace example/shared v1.0.0 => ./old\n");
  put("old/go.mod", "module example/shared\n"); put("old/a.go", "package shared\n");
  put("new/go.mod", "module example/shared\n"); put("new/a.go", "package shared\n");
  put("go.work", "use .\nreplace example/shared => ./new\n");
  expect(files("example/shared", "main.go")).toEqual(["new/a.go"]);
  expect(resolve("example/shared2", "main.go").status).toBe("unresolved");
  put("go.work", "use .\nreplace example/shared => ../escape\n"); expect(resolve("example/shared", "main.go").reason).toContain("outside_workspace");
});
test("Go keeps conditional packages uncertain and rejects ambiguous workspace modules", () => {
  put("go.mod", "module example/app\n"); put("pkg/lib_linux.go", "package pkg\n");
  expect(resolve("example/app/pkg", "main.go").coverage).toBe("conditional");
  put("go.work", "use (\n.\n./duplicate\n)\n"); put("duplicate/go.mod", "module example/app\n");
  expect(resolve("example/app/pkg", "main.go").status).toBe("ambiguous");
});

test("Go does not resolve a source module omitted from the active workspace", () => {
  put("go.mod", "module example/app\n"); put("pkg/lib.go", "package pkg\n");
  put("go.work", "use ./other\n"); put("other/go.mod", "module example/other\n");
  expect(resolve("example/app/pkg", "main.go").reason).toBe("go_source_module_not_in_workspace");
});

test("Ruby preserves require_relative semantics separately from load-path require", () => {
  put("app/helper.rb", "class Helper; end\n"); put("lib/helper.rb", "class Other; end\n");
  expect(files("helper", "app/main.rb", "require_relative 'helper'")).toEqual(["app/helper.rb"]);
  expect(files("helper", "app/main.rb", "require 'helper'")).toEqual(["lib/helper.rb"]);
  expect(resolve("json", "app/main.rb", "require 'json'").status).toBe("external");
  expect(resolve("dynamic:require name", "app/main.rb").status).toBe("unresolved");
});
test("Ruby reads literal Gemfile declarations and lockfile transitive gems", () => {
  put("Gemfile", "source 'https://rubygems.org'\ngem 'activerecord'\n");
  expect(resolve("active_record", "app/main.rb").status).toBe("external");
  put("Gemfile.lock", "GEM\n  specs:\n    rack (3.0.0)\n"); expect(resolve("rack", "app/main.rb").status).toBe("external");
  expect(resolve("zeitwerk_invented", "app/main.rb").reason).toBe("ruby_load_path_not_established");
});

test("Ruby path blocks and gemspec evaluation do not masquerade as external gems", () => {
  put("Gemfile", "path 'shared' do\n  gem 'shared'\nend\n");
  expect(resolve("shared", "app/main.rb").reason).toBe("ruby_dynamic_gem_configuration");
});

test("Rust resolves module declarations, crate/self/super imports and missing items", () => {
  put("Cargo.toml", '[package]\nname="demo"\nversion="0.1.0"\n');
  put("src/lib.rs", "mod orders;\npub struct Root;\n"); put("src/orders.rs", "pub struct Order;\n");
  expect(files("mod:orders", "src/lib.rs")).toEqual(["src/orders.rs"]);
  expect(files("crate::orders::Order", "src/lib.rs")).toEqual(["src/orders.rs"]);
  expect(files("self::Order", "src/orders.rs")).toEqual(["src/orders.rs"]);
  expect(files("super::Root", "src/orders.rs")).toEqual(["src/lib.rs"]);
  expect(resolve("crate::orders::Absent", "src/lib.rs").status).toBe("unresolved");
});
test("Rust Cargo aliases, path dependencies and conditional imports", () => {
  put("Cargo.toml", '[package]\nname="demo"\nversion="0.1.0"\n[dependencies]\nserde_alias={package="serde",version="1"}\nshared={path="shared"}\n');
  put("src/lib.rs", "pub fn run() {}\n"); put("shared/Cargo.toml", '[package]\nname="shared"\nversion="0.1.0"\n'); put("shared/src/lib.rs", "pub struct Thing;\n");
  expect(resolve("serde_alias::Serialize", "src/lib.rs").status).toBe("external");
  expect(files("shared::Thing", "src/lib.rs")).toEqual(["shared/src/lib.rs"]);
  put("shared/src/lib.rs", "#[cfg(feature=\"a\")]\npub struct Thing;\n"); expect(resolve("shared::Thing", "src/lib.rs").coverage).toBe("conditional");
  expect(resolve("std::collections::HashMap", "src/lib.rs").status).toBe("external");
});
test("Rust workspace dependency inheritance and escaping module paths", () => {
  put("Cargo.toml", '[workspace]\nmembers=["app"]\n[workspace.dependencies]\nserde="1"\n');
  put("app/Cargo.toml", '[package]\nname="app"\nversion="0.1.0"\n[dependencies]\nserde={workspace=true}\n'); put("app/src/lib.rs", "pub fn run() {}\n");
  expect(resolve("serde::Serialize", "app/src/lib.rs").status).toBe("external");
  put("app/src/lib.rs", '#[path="../../../escape.rs"]\nmod bad;\n'); expect(resolve("mod:bad", "app/src/lib.rs").reason).toContain("outside_workspace");
});

test("Rust retains optional flags on inherited workspace dependencies", () => {
  put("Cargo.toml", '[workspace]\nmembers=["app"]\n[workspace.dependencies]\nserde="1"\n');
  put("app/Cargo.toml", '[package]\nname="app"\nversion="0.1.0"\n[dependencies]\nserde={workspace=true,optional=true}\n');
  put("app/src/lib.rs", "pub fn run() {}\n");
  expect(resolve("serde::Serialize", "app/src/lib.rs").coverage).toBe("conditional");
});

test("Java resolves source packages, nested types, static imports and wildcards", () => {
  put("pom.xml", "<project><groupId>test</groupId><artifactId>app</artifactId></project>");
  put("src/main/java/acme/Helper.java", "package acme; public class Helper { public static int value; public class Nested {} }\n");
  expect(files("acme.Helper", "src/main/java/app/Main.java")).toEqual(["src/main/java/acme/Helper.java"]);
  expect(files("acme.Helper.Nested", "src/main/java/app/Main.java")).toEqual(["src/main/java/acme/Helper.java"]);
  expect(files("acme.Helper.value", "src/main/java/app/Main.java", "import static acme.Helper.value")).toEqual(["src/main/java/acme/Helper.java"]);
  expect(files("acme.*", "src/main/java/app/Main.java")).toEqual(["src/main/java/acme/Helper.java"]);
  expect(resolve("java.util.List", "src/main/java/app/Main.java").status).toBe("external");
  expect(resolve("org.example.External", "src/main/java/app/Main.java").reason).toBe("java_classpath_not_established");
});
test("Java Maven reactor dependencies and Gradle literal project references", () => {
  put("pom.xml", "<project><modules><module>api</module><module>shared</module></modules></project>");
  put("api/pom.xml", "<project><groupId>acme</groupId><artifactId>api</artifactId><dependencies><dependency><groupId>acme</groupId><artifactId>shared</artifactId></dependency></dependencies></project>");
  put("shared/pom.xml", "<project><groupId>acme</groupId><artifactId>shared</artifactId></project>");
  put("shared/src/main/java/acme/Helper.java", "package acme; public class Helper {}\n");
  expect(files("acme.Helper", "api/src/main/java/Main.java")).toEqual(["shared/src/main/java/acme/Helper.java"]);
  rmSync(join(root, "pom.xml")); rmSync(join(root, "api/pom.xml")); rmSync(join(root, "shared/pom.xml"));
  put("settings.gradle", "include ':api', ':shared'\n"); put("api/build.gradle", "dependencies { implementation project(':shared') }\n"); put("shared/build.gradle", "plugins { id 'java' }\n");
  expect(files("acme.Helper", "api/src/main/java/Main.java")).toEqual(["shared/src/main/java/acme/Helper.java"]);
});

test("C# resolves namespace file sets, aliases and project references", () => {
  put("app/app.csproj", '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../shared/shared.csproj" /></ItemGroup></Project>');
  put("shared/shared.csproj", '<Project Sdk="Microsoft.NET.Sdk"/>');
  put("shared/A.cs", "namespace Acme.Shared; public class A {}\n"); put("shared/B.cs", "namespace Acme.Shared { public class B {} }\n");
  expect(files("Acme.Shared", "app/Main.cs")).toEqual(["shared/A.cs", "shared/B.cs"]);
  expect(files("Alias", "app/Main.cs", "using Alias = Acme.Shared.A;")).toEqual(["shared/A.cs"]);
  expect(resolve("System.Collections.Generic", "app/Main.cs").status).toBe("external");
  expect(resolve("Unknown.Namespace", "app/Main.cs").reason).toBe("csharp_namespace_not_established");
});
test("C# respects explicit compile items and marks conditional references", () => {
  put("app.csproj", '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="src/**/*.cs" /><Compile Remove="src/Ignored.cs" /></ItemGroup></Project>');
  put("src/Live.cs", "namespace Acme; class Live {}\n"); put("src/Ignored.cs", "namespace Acme; class Ignored {}\n"); put("Other.cs", "namespace Acme; class Other {}\n");
  expect(files("Acme", "src/Main.cs")).toEqual(["src/Live.cs"]);
  put("app.csproj", '<Project><ItemGroup Condition="something"><Compile Include="src/**/*.cs" /></ItemGroup></Project>');
  expect(resolve("Acme", "src/Main.cs").coverage).toBe("conditional");
});

test("C# includes linked source and retains preprocessor uncertainty", () => {
  put("app/app.csproj", '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="../linked/Thing.cs" /></ItemGroup></Project>');
  put("linked/Thing.cs", "#if FEATURE\nnamespace Shared; class Thing {}\n#endif\n");
  const result = resolve("Shared.Thing", "app/Main.cs");
  expect(result.targets.flatMap(target => target.files)).toEqual(["linked/Thing.cs"]);
  expect(result.coverage).toBe("conditional");
});

test("Java main-source lookup excludes test classes and commented project dependencies", () => {
  put("pom.xml", "<project><modules><module>api</module><module>shared</module></modules></project>");
  put("api/pom.xml", "<project><groupId>acme</groupId><artifactId>api</artifactId><!-- <dependencies><dependency><groupId>acme</groupId><artifactId>shared</artifactId></dependency></dependencies> --></project>");
  put("shared/pom.xml", "<project><groupId>acme</groupId><artifactId>shared</artifactId></project>");
  put("shared/src/main/java/acme/Thing.java", "package acme; class Thing {}\n");
  put("api/src/test/java/acme/OnlyTest.java", "package acme; class OnlyTest {}\n");
  expect(resolve("acme.Thing", "api/src/main/java/Main.java").status).toBe("unresolved");
  expect(resolve("acme.OnlyTest", "api/src/main/java/Main.java").status).toBe("unresolved");
  expect(files("acme.OnlyTest", "api/src/test/java/MainTest.java")).toEqual(["api/src/test/java/acme/OnlyTest.java"]);
});

test("Java profile-dependent source interpretation stays conditional", () => {
  put("pom.xml", "<project><groupId>acme</groupId><artifactId>app</artifactId><profiles><profile><id>optional</id></profile></profiles></project>");
  put("src/main/java/acme/Thing.java", "package acme; class Thing {}\n");
  expect(resolve("acme.Thing", "src/main/java/Main.java").coverage).toBe("conditional");
});

test("new language resolvers enforce symlink containment", () => {
  put("Gemfile", ""); symlinkSync("/etc", join(root, "lib"));
  expect(resolve("passwd", "main.rb").reason).toContain("outside_workspace");
});

test("managed-language resolution does not invent types or static members", () => {
  put("src/Types.java", "package acme; class Other { static int actual; class Nested {} }\n");
  expect(resolve("acme.Types", "src/Main.java").status).toBe("unresolved");
  expect(files("acme.Other", "src/Main.java")).toEqual(["src/Types.java"]);
  expect(resolve("acme.Other.absent", "src/Main.java", "import static acme.Other.absent").status).toBe("unresolved");
  put("App.cs", "namespace First { class A {} } namespace Second { class B {} }\n");
  expect(resolve("First.B", "App.cs").status).toBe("unresolved");
  expect(files("Second.B", "App.cs")).toEqual(["App.cs"]);
  put("App.cs", "namespace Outer { namespace Inner { class C {} } }\n");
  expect(files("Outer.Inner.C", "App.cs")).toEqual(["App.cs"]);
});

test("Rust supports lifetimes and inline modules without inventing absent declarations", () => {
  put("Cargo.toml", '[package]\nname="demo"\nversion="0.1.0"\n');
  put("src/lib.rs", "pub struct Ref<'a> { pub value: &'a str }\nmod nested { pub struct Thing; }\n");
  expect(files("crate::Ref", "src/lib.rs")).toEqual(["src/lib.rs"]);
  expect(files("crate::nested::Thing", "src/lib.rs")).toEqual(["src/lib.rs"]);
  expect(resolve("crate::nested::Absent", "src/lib.rs").status).toBe("unresolved");
  expect(resolve("crate::Thing", "src/lib.rs").status).toBe("unresolved");
  expect(resolve("crate::Ref::Absent", "src/lib.rs").status).toBe("unsupported");
});

test("C# duplicate types remain ambiguous while partial declarations form one file set", () => {
  put("A.cs", "namespace Shared; class Thing {}\n"); put("B.cs", "namespace Shared; class Thing {}\n");
  expect(resolve("Shared.Thing", "A.cs").status).toBe("ambiguous");
  put("A.cs", "namespace Shared; partial class Thing {}\n"); put("B.cs", "namespace Shared; partial class Thing {}\n");
  expect(files("Shared.Thing", "A.cs")).toEqual(["A.cs", "B.cs"]);
});

for (const language of ["rust", "java", "csharp"] as const) {
  test(`${language} source resolution reaches map, call graph and workspace/staged boundary`, async () => {
    let source: string, target: string;
    if (language === "rust") {
      put("Cargo.toml", '[package]\nname="app"\nversion="0.1.0"\n');
      put("src/lib.rs", "mod shared;\nuse crate::shared::Thing;\npub fn run() {}\n"); put("src/shared/mod.rs", "pub struct Thing;\n");
      source = "src/lib.rs"; target = "crate::shared::Thing";
    } else if (language === "java") {
      put("app/Main.java", "package app;\nimport shared.Thing;\npublic class Main {}\n"); put("shared/Thing.java", "package shared; public class Thing {}\n");
      source = "app/Main.java"; target = "shared.Thing";
    } else {
      put("app/app.csproj", '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../shared/shared.csproj" /></ItemGroup></Project>');
      put("shared/shared.csproj", '<Project Sdk="Microsoft.NET.Sdk"/>');
      put("app/Main.cs", "using Shared;\nnamespace App; public class Main {}\n"); put("shared/Thing.cs", "namespace Shared; public class Thing {}\n");
      source = "app/Main.cs"; target = "Shared";
    }
    const config = ConfigLoader.getDefaultConfig(); config.domains = {
      app: { root: language === "rust" ? "src" : "app", allowed_dependencies: [], forbidden_dependencies: ["shared"], archetypes: {} },
      shared: { root: language === "rust" ? "src/shared" : "shared", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };
    const db = new SeptumDatabase(":memory:");
    try {
      const repo = new SeptumRepository(db.raw); await new IngestionPipeline(repo, root).run(config);
      const edge = repo.getImportRelationships(root).find(edge => edge.resolution.source.target === target)!;
      expect(edge.resolution.status).toBe("resolved"); expect(edge.target_domains).toEqual(["shared"]);
      expect(buildNavigation(repo, {}, root).dependencies.some(edge => edge.from === "app" && edge.to === "shared")).toBe(true);
      const tracer = new CallGraphTracer(repo, root); tracer.initMaps();
      expect(tracer.resolveImportTargets(source, target).map(file => file.path)).toEqual(edge.resolution.targets.flatMap(target => target.files));
      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
      expect(JSON.parse((await handleCheckBoundary(evaluator, config, { scope: "all" }, repo, root)).content[0].text).status).toBe("rejected");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "-q"); git("add", ".");
      const staged = await auditStagedFiles(evaluator, config, root, repo);
      expect(staged.violations.some(violation => violation.rule === "forbidden_dependency")).toBe(true);
      expect(staged.resolution_issues).toEqual([]);
    } finally { db.close(); }
  });
}

test("staged Python manifest-only changes use frozen bytes and invalidate unchanged imports", async () => {
  put("src/main.py", "import requests\n"); put("requirements.txt", "requests\n");
  const config = ConfigLoader.getDefaultConfig(); config.domains = { app: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const db = new SeptumDatabase(":memory:");
  try {
    const repo = new SeptumRepository(db.raw); await new IngestionPipeline(repo, root).run(config);
    put("requirements.txt", "other\n"); git("add", "requirements.txt"); put("requirements.txt", "requests\n");
    const staged = await auditStagedFiles(new BoundaryEvaluator(repo, new ModuleResolver(root, repo)), config, root, repo);
    expect(staged.resolution_issues.some(issue => issue.reason === "python_module_not_declared")).toBe(true);
  } finally { db.close(); }
});

test("manifest watcher events reconcile without waiting for periodic verification", async () => {
  put("src/main.py", "import requests\n"); put("requirements.txt", "requests\n");
  const config = ConfigLoader.getDefaultConfig(); config.domains = { app: { root: "src", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} } };
  const db = new SeptumDatabase(":memory:");
  let watcher: WorkspaceWatcher | undefined;
  try {
    const repo = new SeptumRepository(db.raw); const pipeline = new IngestionPipeline(repo, root); await pipeline.run(config);
    watcher = new WorkspaceWatcher(root, repo, pipeline, Promise.resolve(), new SerialWorkQueue(), new WatchBudget(), () => config);
    await watcher.flush(true);
    const before = repo.getMeta("semantic_inputs");
    put("requirements.txt", "requests\nfastapi\n"); watcher.notify("requirements.txt"); await watcher.flush(false);
    expect(repo.getMeta("semantic_inputs")).not.toBe(before);
    expect(repo.getMeta("sync_state")).toBe("complete");
  } finally { await watcher?.close(); db.close(); }
});

test("resolver implementation source remains indexable by the shipped TypeScript grammar", async () => {
  const parser = new ASTParserEngine();
  for (const file of ["shared.ts", "python.ts", "go.ts", "ruby.ts", "rust.ts", "managed.ts"]) {
    const source = await Bun.file(join(import.meta.dir, "../../src/core/resolver/languages", file)).text();
    expect((await parser.parseFile(file, source)).status).toBe("parsed");
  }
});

test("Ruby dependency statements reach workspace and staged boundary audits", async () => {
  put("app/main.rb", "require_relative '../shared/helper'\n"); put("shared/helper.rb", "class Helper; end\n"); put("Gemfile", "");
  const config = ConfigLoader.getDefaultConfig(); config.domains = {
    app: { root: "app", allowed_dependencies: [], forbidden_dependencies: ["shared"], archetypes: {} },
    shared: { root: "shared", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
  };
  const db = new SeptumDatabase(":memory:");
  try {
    const repo = new SeptumRepository(db.raw); await new IngestionPipeline(repo, root).run(config);
    expect(repo.getImportRelationships(root)[0]!.target_domains).toEqual(["shared"]);
    const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
    expect(JSON.parse((await handleCheckBoundary(evaluator, config, { scope: "all" }, repo, root)).content[0].text).status).toBe("rejected");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q"); git("add", ".");
    const staged = await auditStagedFiles(evaluator, config, root, repo);
    expect(staged.violations.some(v => v.rule === "forbidden_dependency")).toBe(true);
    expect(staged.resolution_issues).toEqual([]);
  } finally { db.close(); }
});
