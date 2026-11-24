import { normalizeApplyPatchEdits, normalizeHookEdit, type HookEdit } from "../hook-payload.ts";
import { assertPathContained } from "../../core/resolver/path-resolver.ts";
import { readSourceFile } from "../../core/resources/source-files.ts";
import * as fs from "node:fs";
import * as os from "node:os";
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
  cwd?: string;
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
// Codex/OpenCode/Claude/Cursor contract: stdout must be empty on allow/skip; deny = exit 2 + stderr reason + empty stdout.
let quietStdout = false;

export async function handleHookCommand(args: string[]): Promise<void> {
  configuredExitCode = 1;
  quietStdout = false;
  const subHook = args[1] || "pre-write";
  if (args.includes("--codex") || args.includes("--opencode") || args.includes("--claude") || args.includes("--cursor")) {
    quietStdout = true;
    configuredExitCode = 2;
  }
  if (args.includes("--exit-code-2")) {
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

  // Print readable error to stderr for humans and Claude/Cursor/Codex/OpenCode
  console.error(reason);

  // Print JSON contract to stdout for Antigravity hook engine (quiet harnesses require empty stdout)
  if (!quietStdout) try {
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: reason.trim(),
      }) + "\n"
    );
  } catch {
    // ignore
  }

  // Exit code: 1 by default (Unix standard), or 2 for Claude Code / Cursor / Codex / OpenCode
  process.exit(configuredExitCode);
}

function isAntigravityArtifactPath(resolvedTarget: string): boolean {
  const homeDir = os.homedir();
  const allowedPrefixes = [
    path.resolve(homeDir, ".gemini", "antigravity", "brain") + path.sep,
    path.resolve(homeDir, ".gemini", "antigravity-cli", "brain") + path.sep,
  ];
  return allowedPrefixes.some((prefix) => resolvedTarget.startsWith(prefix));
}

function emitPassOrDefer(workspaceRoot: string, fields: Record<string, unknown>): never {
  SeptumTelemetry.recordSystemEvent({
    level: "INFO",
    component: "hook",
    event: "hook_decision",
    fields: {
      ...fields,
      response_decision: quietStdout ? "empty" : "ask",
      zero_sqlite: false,
    },
    workspaceRoot,
    emitStderr: false,
  });
  if (!quietStdout) {
    try {
      // Antigravity CLI unmarshals hook stdout via protojson; emit only schema-valid fields.
      process.stdout.write(JSON.stringify({ decision: "ask" }) + "\n");
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

function resolveTargetBaseDir(callerRoot: string, workspaceRoot: string, payloadCwd?: string): string {
  if (typeof payloadCwd === "string" && payloadCwd.trim()) {
    const candidate = path.resolve(workspaceRoot, payloadCwd);
    try {
      assertPathContained(candidate, workspaceRoot, "Hook cwd");
      return candidate;
    } catch {
      // Fall through to workspaceRoot
    }
  }
  const callerBase = path.basename(callerRoot);
  if (callerBase === ".agents" || callerBase === ".claude" || callerBase === ".codex" || callerBase === "opencode") {
    return workspaceRoot;
  }
  return callerRoot;
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

  const targetBaseDir = resolveTargetBaseDir(callerRoot, workspaceRoot, payload.cwd);
  let edits: HookEdit[] = [];
  try {
    const patchEdits = normalizeApplyPatchEdits(payload);
    const single = patchEdits.length ? undefined : normalizeHookEdit(payload, target => {
      const file = path.resolve(targetBaseDir, target);
      if (isAntigravityArtifactPath(file)) return "";
      assertPathContained(file, workspaceRoot, "Hook source");
      return readSourceFile(file);
    });
    edits = patchEdits.length ? patchEdits : single ? [single] : [];
    for (const e of edits) {
      const resolvedTarget = path.resolve(targetBaseDir, e.target);
      if (isAntigravityArtifactPath(resolvedTarget)) {
        emitPassOrDefer(workspaceRoot, {
          decision: "allow",
          coverage: "unknown",
          evaluated: "skipped_harness_artifact",
        });
      }
      assertPathContained(resolvedTarget, workspaceRoot, "Hook target");
    }
  } catch (error) { blockHook(null, error instanceof Error ? error.message : String(error)); }
  if (edits.length === 0) {
    emitPassOrDefer(workspaceRoot, {
      decision: "allow",
      coverage: "unknown",
      evaluated: "skipped_unsupported_payload",
    });
  }
  const db = new SeptumDatabase(dbPath);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(workspaceRoot, repo));

  try {
   const astEngine = new ASTParserEngine();
   let lastEvaluated = "unmapped_domain";
   let lastCoverage = edits[0].coverage;
   for (const edit of edits) {
    const targetFile = path.relative(workspaceRoot, path.resolve(targetBaseDir, edit.target)).replace(/\\/g, "/");
    const content = edit.content;
    const sourceDomain = evaluator.resolveSourceDomain(targetFile, config);

    // Real-time AST Import Interception:
    // Extract imports from proposed content and check for boundary leaks
    if (content && sourceDomain) {
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

    lastEvaluated = sourceDomain ? "proposed_imports" : "unmapped_domain";
    lastCoverage = edit.coverage;
   }
    db?.close();

    // Antigravity JSON mode: "allow" would auto-approve the tool and skip the user's permission prompt.
    // Septum only vetoes boundary violations, so defer to the normal flow with "ask".
    emitPassOrDefer(workspaceRoot, {
      decision: "allow",
      coverage: lastCoverage,
      evaluated: lastEvaluated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    blockHook(db, `[Septum Hook Error] ${message}`);
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
