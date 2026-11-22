import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entry = resolve(root, "src/mcp/ui/app-client.ts");
const outHtml = resolve(root, "src/mcp/ui/app.html");

const built = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "esm",
  minify: true,
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const js = (await built.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Septum Architecture</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      background: var(--color-background-primary, #ffffff);
      color: var(--color-text-primary, #1f1f1f);
      font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
      font-size: 13px;
      line-height: 1.45;
    }
    .shell { display: flex; flex-direction: column; gap: 12px; }
    .bar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; flex-wrap: wrap;
      border-bottom: 1px solid var(--color-border-primary, #e2e8f0);
      padding-bottom: 8px;
    }
    .tabs, .actions { display: flex; gap: 6px; }
    .tab, .btn {
      border: 1px solid var(--color-border-primary, #cbd5e1);
      background: var(--color-background-secondary, #f8fafc);
      color: var(--color-text-primary, #1f1f1f);
      border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
    }
    .tab.active {
      background: var(--color-background-inverse, #0f172a);
      color: var(--color-text-inverse, #ffffff);
      border-color: var(--color-border-inverse, #0f172a);
    }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; }
    .stat, .card {
      background: var(--color-background-secondary, #f8fafc);
      border: 1px solid var(--color-border-primary, #e2e8f0);
      border-radius: 8px; padding: 8px 10px;
    }
    .stat .label { display: block; font-size: 11px; color: var(--color-text-secondary, #64748b); }
    .stat .val { font-size: 15px; font-weight: 600; }
    .val.ok { color: var(--color-text-success, #15803d); }
    .val.danger, .danger { color: var(--color-text-danger, #b91c1c); }
    .val.warn { color: var(--color-text-warning, #b45309); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
    .card-title { font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      background: var(--color-background-secondary, #f8fafc);
      border: 1px solid var(--color-border-primary, #e2e8f0);
      border-radius: 6px; padding: 6px 10px;
    }
    .clickable { cursor: pointer; }
    .clickable:hover { border-color: var(--color-ring-primary, #3b82f6); }
    .badge {
      display: inline-block; font-size: 11px; font-weight: 600;
      padding: 1px 6px; border-radius: 4px;
      background: var(--color-background-tertiary, #e2e8f0);
      color: var(--color-text-primary, #1f1f1f);
    }
    .muted { color: var(--color-text-secondary, #64748b); font-size: 12px; }
    .meta { font-size: 11px; margin-top: 4px; color: var(--color-text-secondary, #475569); }
    .empty { padding: 16px; text-align: center; color: var(--color-text-secondary, #64748b); }
    .alert {
      padding: 8px 10px; border-radius: 6px;
      background: var(--color-background-danger, #fef2f2);
      color: var(--color-text-danger, #b91c1c);
      border: 1px solid var(--color-border-danger, #fecaca);
    }
    .warn-box {
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px; border-radius: 8px;
      background: var(--color-background-warning, #fffbeb);
      color: var(--color-text-warning, #92400e);
      border: 1px solid var(--color-border-warning, #fde68a);
    }
    .warn-box ul { margin: 0; padding-left: 18px; }
    .warn-box li { margin: 2px 0; }
    .brand { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .scope-pill, .scope-select {
      font-size: 11px; padding: 2px 6px; border-radius: 4px;
      background: var(--color-background-secondary, #f8fafc);
      border: 1px solid var(--color-border-primary, #cbd5e1);
      color: var(--color-text-secondary, #475569);
      max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .status-bar { font-size: 11px; color: var(--color-text-secondary, #64748b); min-height: 14px; }
    .primary-btn { font-weight: 600; }
    .ai-bar {
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px; border-radius: 8px;
      background: var(--color-background-secondary, #f8fafc);
      border: 1px solid var(--color-border-primary, #e2e8f0);
    }
    .preset-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .chip {
      border: 1px solid var(--color-border-primary, #cbd5e1);
      background: var(--color-background-primary, #ffffff);
      color: var(--color-text-primary, #1f1f1f);
      border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer;
    }
    .chip:hover { border-color: var(--color-ring-primary, #3b82f6); }
    .prompt-form { display: flex; gap: 6px; align-items: center; }
    .prompt-input {
      flex: 1; min-width: 0; padding: 5px 8px; border-radius: 6px; font-size: 12px;
      border: 1px solid var(--color-border-primary, #cbd5e1);
      background: var(--color-background-primary, #ffffff);
      color: var(--color-text-primary, #1f1f1f);
    }
    .card.selected, .row.selected { border-color: var(--color-ring-primary, #3b82f6); }
    .chk-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .chk { cursor: pointer; margin: 0; }
    .mini-btn {
      border: 1px solid var(--color-border-primary, #cbd5e1);
      background: var(--color-background-primary, #ffffff);
      color: var(--color-text-primary, #1f1f1f);
      border-radius: 5px; padding: 2px 7px; font-size: 11px; cursor: pointer;
    }
    h3 { margin: 10px 0 6px; font-size: 13px; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">${js}</script>
</body>
</html>
`;

writeFileSync(outHtml, html, "utf8");
console.log(`Built ${outHtml} (${Buffer.byteLength(html)} bytes)`);
