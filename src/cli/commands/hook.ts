import { normalizeHookEdit } from "../hook-payload.ts";
import { assertPathContained } from "../../core/resolver/path-resolver.ts";
import { readSourceFile } from "../../core/resources/source-files.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import { ConfigLoader, resolveDatabasePath } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { ASTParserEngine } from "../../core/parser/tree-sitter.ts";
import { ModuleResolver } from "../../core/resolver/module-resolver.ts";
import { SeptumTelemetry } from "../../core/telemetry/telemetry.ts";

interface ToolCallInfo {
  name?: string;
  args?: Record<string, unknown>;
}

export interface ToolPayload {
  tool_name?: string;
  toolCall?: ToolCallInfo;
  tool_input?: {
    TargetFile?: string;
    file_path?: string;
    filePath?: string;
    path?: string;
    Path?: string;
    ReplacementContent?: string;
    CodeContent?: string;
    new_string?: string;
    content?: string;
    Content?: string;
    Replacement?: string;
    ReplacementChunks?: Array<{ ReplacementContent?: string }>;
  };
  arguments?: Record<string, unknown>;
  TargetFile?: string;
  file_path?: string;
  filePath?: string;
  path?: string;
  Path?: string;
  ReplacementContent?: string;
  CodeContent?: string;
  new_string?: string;
  content?: string;
  Content?: string;
  Replacement?: string;
}

let configuredExitCode = 1;

export async function handleHookCommand(args: string[]): Promise<void> {
  const subHook = args[1] || "pre-write";
  if (args.includes("--exit-code-2") || args.includes("--claude") || args.includes("--cursor")) {
    configuredExitCode = 2;
  }

  if (subHook === "pre-write") {
    await runPreWriteHook();
  } else {
    process.exit(0);
  }
}

function blockHook(db: SeptumDatabase | null, reason: string): never {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  // Print readable error to stderr for humans and Claude/Cursor/Codex
  console.error(reason);

  // Print JSON contract to stdout for Antigravity hook engine
  try {
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: reason.trim(),
      }) + "\n"
    );
  } catch {
    // ignore
  }

  // Exit code: 1 by default (Unix standard), or 2 if specified for Claude Code / Cursor hooks
  process.exit(configuredExitCode);
}

async function runPreWriteHook(): Promise<void> {
  const callerRoot = process.cwd();
  const workspaceRoot = path.resolve(process.env.SEPTUM_HOOK_ROOT || callerRoot);
  const config = ConfigLoader.load(undefined, workspaceRoot);
  const dbPath = resolveDatabasePath(workspaceRoot, config.settings.db_path);
  if (!fs.existsSync(dbPath)) {
    process.exit(0);
  }

  // Read JSON payload from stdin
  const stdinData = await readStdin();
  if (!stdinData.trim()) {
    process.exit(0);
  }

  let payload: ToolPayload;
  try {
    payload = JSON.parse(stdinData);
  } catch {
    // Non-JSON stdin, pass through
    process.exit(0);
  }

  let edit;
  try {
    edit = normalizeHookEdit(payload, target => {
      const file = path.resolve(callerRoot, target);
      assertPathContained(file, workspaceRoot, "Hook source");
      return readSourceFile(file);
    });
    if (edit) assertPathContained(path.resolve(callerRoot, edit.target), workspaceRoot, "Hook target");
  } catch (error) { blockHook(null, error instanceof Error ? error.message : String(error)); }
  if (!edit) {
    process.stdout.write(JSON.stringify({ decision: "allow", coverage: "unknown", reason: "Unsupported hook payload; no source candidate was evaluated." }) + "\n");
    process.exit(0);
  }
  const targetFile = path.relative(workspaceRoot, path.resolve(callerRoot, edit.target)).replace(/\\/g, "/");
  const content = edit.content;

  const db = new SeptumDatabase(dbPath);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(workspaceRoot, repo));

  try {
    const sourceDomain = evaluator.resolveSourceDomain(targetFile, config);

    // Real-time AST Import Interception:
    // Extract imports from proposed content and check for boundary leaks
    if (content && sourceDomain) {
      const astEngine = new ASTParserEngine();
      const parsed = await astEngine.parseFile(targetFile, content);
      if (ASTParserEngine.isSourceFile(targetFile) && (parsed.status === "unsupported" || parsed.status === "degraded")) {
        throw new Error(`Cannot reliably check imports in '${targetFile}': parser status is ${parsed.status}.`);
      }

      const proposedImports = parsed.dependencies.map((d) => d.target);
      const boundaryViolations = evaluator.checkProposedChanges(
        targetFile,
        proposedImports,
        config,
        parsed.dependencies.map(d => d.statement)
      );

      if (boundaryViolations.length > 0) {
        const v = boundaryViolations[0];
        SeptumTelemetry.recordSystemEvent({
          level: "WARN",
          component: "hook",
          event: "hook_decision",
          fields: {
            decision: "deny",
            rule: v.rule,
            source_domain: v.source_domain,
            target_domain: v.target_domain,
            zero_sqlite: false,
          },
          workspaceRoot,
          emitStderr: false,
        });
        blockHook(
          db,
          `\n[SEPTUM BOUNDARY VIOLATION - Forbidden Cross-Domain Import]\n` +
            `✕ Operation blocked: Proposed code imports forbidden domain '${v.target_domain}' from '${v.source_domain}'.\n` +
            `▶ OFFENDING IMPORT: ${v.imported_target}\n` +
            `▶ RULE: ${v.rule}\n` +
            `▶ MESSAGE: ${v.message}\n` +
            `▶ REQUIRED ACTION: Decouple this dependency. Use an authorized Interface, Event, or Shared Kernel.\n`
        );
      }
    }

    db?.close();

    SeptumTelemetry.recordSystemEvent({
      level: "INFO",
      component: "hook",
      event: "hook_decision",
      fields: {
        decision: "allow",
        coverage: edit.coverage,
        evaluated: sourceDomain ? "proposed_imports" : "unmapped_domain",
        zero_sqlite: false,
      },
      workspaceRoot,
      emitStderr: false,
    });

    // If running in Antigravity or standard JSON IPC mode, emit allow decision
    try {
      process.stdout.write(JSON.stringify({ decision: "allow", coverage: edit.coverage, evaluated: sourceDomain ? "proposed_imports" : "unmapped_domain" }) + "\n");
    } catch {
      // ignore
    }
    process.exit(0);
  } catch (err) {
    db?.close();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[Septum Hook Error]\x1b[0m ${message}`);
    process.exit(configuredExitCode);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}
