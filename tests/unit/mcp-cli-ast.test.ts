import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McpCliSemanticExtractor } from "../../src/core/parser/extractors/mcp-cli-semantic.ts";

function extract(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "septum-mcp-cli-ast-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    return new McpCliSemanticExtractor().extractSlices(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("MCP separates advertised names from handlers resolved in the matching server dispatch", () => {
  const slices = extract({
    "src/mcp/server.ts": `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema as List, CallToolRequestSchema as Call } from '@modelcontextprotocol/sdk/types.js';
import { run as selected } from './tools/real';
import { run as decoy } from './tools/public';
const server = new Server({ name: 'test', version: '1' });
const other = new Server({ name: 'other', version: '1' });
const help = "server.registerTool('string', {}, selected)";
// server.registerTool('comment', {}, selected);
server.setRequestHandler(List, () => ({tools: [{name: 'test_public'}, {name: 'test_dynamic'}]}));
server.setRequestHandler(Call, ({ params }) => {
  const name = params.name;
  const neverCalled = () => { switch (name) { case 'test_public': return decoy(); } };
  switch (name) {
    case 'test_public': return selected();
    case 'test_dynamic': return pickHandler()();
    case 'test_internal': return decoy();
  }
});
other.setRequestHandler(Call, request => {
  switch (request.params.name) { case 'test_public': return decoy(); }
});`,
    "src/mcp/tools/real.ts": "export function unrelated() {}\n\nexport function run() {}",
    "src/mcp/tools/public.ts": "export function run() {}",
  });
  expect(slices.map(({route_name, action_name, controller_file, controller_line}) =>
    [route_name, action_name, controller_file, controller_line])).toEqual([
    ["test_public", "run", "src/mcp/tools/real.ts", 3],
    ["test_dynamic", "unresolved_handler", null, 0],
  ]);
  expect(JSON.parse(slices[1]!.execution_chain_json).map((node: { stage: string }) => node.stage)).toEqual(["ingress"]);
});

test("MCP registerTool binds aliases while ignoring fake receivers and computed names", () => {
  const slices = extract({
    "src/mcp/server.ts": `import { McpServer as Server } from '@modelcontextprotocol/sdk/server/mcp.js';
import { selected as run } from './barrel';
const server = new Server({ name: 'test', version: '1' });
const alias = run;
server.registerTool('actual', {}, alias);
server.registerTool(computeName(), {}, run);
const fake = { registerTool() {} };
fake.registerTool('wrong-receiver', {}, run);
const TOOL_SCHEMAS = { unregistered: {} };`,
    "src/mcp/barrel.ts": "export { run as selected } from './tools/real';",
    "src/mcp/tools/real.ts": "export const run = () => 1;",
  });
  expect(slices).toHaveLength(1);
  expect(slices[0]).toMatchObject({route_name: "actual", controller_file: "src/mcp/tools/real.ts", action_name: "run"});
});

test("CLI follows the manifest bin to the argv dispatch and binds literal dynamic imports", () => {
  const slices = extract({
    "package.json": '{"bin":{"demo":"./bin/run.ts"}}',
    "bin/run.ts": "import { main } from '../src/cli/main';\nmain(process.argv);",
    "src/cli/main.ts": `import { parseArgs as parse } from 'node:util';
export async function main(args: string[]) {
  const { positionals } = parse({ args: args.slice(2), allowPositionals: true });
  const help = "case 'string': run()";
  switch (positionals[0]) {
    case 'actual': {
      const { run: handler } = await import('./commands/real');
      await handler();
      break;
    }
    case 'dynamic': {
      const { run } = await import(process.env.HANDLER);
      await run();
      break;
    }
  }
}`,
    "src/cli/commands/real.ts": "export function other() {}\nexport async function run() {}",
    "src/cli/commands/actual.ts": "export function run() {}",
    "src/cli/commands/unregistered.ts": "export function run() {}",
  });
  expect(slices.map(({route_name, action_name, controller_file, controller_line}) =>
    [route_name, action_name, controller_file, controller_line])).toEqual([
    ["demo actual", "run", "src/cli/commands/real.ts", 2],
    ["demo dynamic", "unresolved_handler", null, 0],
  ]);
});
