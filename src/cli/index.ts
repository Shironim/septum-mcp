import { parseArgs } from "node:util";
import { SEPTUM_VERSION, checkRuntimeVersion, formatUpdateNotice, type RuntimeVersionMeta } from "../utils/version-check.ts";

export async function runCLI(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(2),
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        force: { type: "boolean", short: "f" },
        json: { type: "boolean" },
        strict: { type: "boolean" },
        staged: { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[Septum Error]\x1b[0m ${message}`);
    process.exit(1);
  }

  const { values: flags, positionals } = parsed;
  const command = positionals[0];

  if (flags.version || command === "version") {
    console.log(`Septum v${SEPTUM_VERSION}`);
    const meta = await checkRuntimeVersion({ timeoutMs: 1200 });
    const notice = formatUpdateNotice(meta);
    if (notice) {
      console.log(notice);
    }
    return;
  }

  if (flags.help || !command || command === "help") {
    const meta = await checkRuntimeVersion({ timeoutMs: 1000 });
    printHelp(meta);
    return;
  }

  try {
    switch (command) {
      case "init": {
        const { handleInitCommand } = await import("./commands/init.ts");
        const force = Boolean(flags.force);
        await handleInitCommand(force);
        break;
      }

      case "sync": {
        const { handleSyncCommand } = await import("./commands/sync.ts");
        const json = Boolean(flags.json);
        await handleSyncCommand({ json });
        break;
      }

      case "check": {
        const { handleCheckCommand } = await import("./commands/check.ts");
        const strict = Boolean(flags.strict);
        const staged = Boolean(flags.staged);
        const json = Boolean(flags.json);
        await handleCheckCommand({ strict, staged, json });
        break;
      }

      case "stats": {
        const { handleStatsCommand } = await import("./commands/stats.ts");
        handleStatsCommand(positionals[1] ?? process.cwd(), Boolean(flags.json));
        break;
      }

      case "serve": {
        const { handleServeCommand } = await import("./commands/serve.ts");
        await handleServeCommand();
        break;
      }

      case "hook": {
        const { handleHookCommand } = await import("./commands/hook.ts");
        await handleHookCommand(argv.slice(2));
        break;
      }

      default: {
        console.error(`[Septum] Unknown command: '${command}'`);
        console.error("Run 'septum --help' for available commands.");
        process.exit(1);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[Septum Error]\x1b[0m ${message}`);
    process.exit(1);
  }
}

function printHelp(versionMeta?: RuntimeVersionMeta): void {
  const notice = versionMeta ? formatUpdateNotice(versionMeta) : null;
  console.log(`
Septum — Deterministic Bounded-Context & Architecture Guard
Version: v${SEPTUM_VERSION}${notice ? `\n\n${notice}` : ""}

USAGE:
  septum <command> [options]
  septum [flags]

COMMANDS:
  Core Lifecycle & Indexing:
    init                  Initialize configuration, gitignore, pre-commit hook, and catalog
                          Flags: -f, --force (regenerate Septum-owned hooks & harness artifacts)
    sync                  Codebase AST synchronization and catalog update (full or incremental)
                          Flags: --json

  Boundary & Enforcement:
    check                 Audit codebase for cross-domain boundary violations
                          Flags: --strict, --staged, --json
    hook [subhook]        Internal pre-tool guardrail hook (e.g. pre-write)

  Daemon & Protocol:
    serve                 Start Model Context Protocol (MCP) server over stdio
    stats [workspace]     Summarize recent MCP tool logs (supports --json)

GLOBAL FLAGS:
  -h, --help              Show this help message
  -v, --version           Show current version
`);
}
