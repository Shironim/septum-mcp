import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { LaravelSemanticExtractor } from "../../src/core/parser/extractors/laravel-semantic.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("Laravel resource route declarations exclude comments, strings and heredoc decoys", () => {
  const content = `<?php
// Route::resource('ghost', GhostController::class);
/* Route::apiResource('comment', CommentController::class); */
$sample = "Route::resource('literal', LiteralController::class);";
$doc = <<<'TXT'
Route::apiResource('heredoc', TextController::class);
TXT;
Route::RESOURCE('orders', OrderController::class);
Route::apiResource('invoices', InvoiceController::class);
`;
  const routes = new LaravelSemanticExtractor().parseRoutesContent(content);
  expect([...new Set(routes.map(route => route.controllerClass))].sort()).toEqual(["InvoiceController", "OrderController"]);
  expect(routes.filter(route => route.controllerClass === "OrderController")).toHaveLength(7);
  expect(routes.filter(route => route.controllerClass === "InvoiceController")).toHaveLength(5);
});

test("registry-style explicit workspace roots resolve controllers without using constructor cwd", () => {
  const first = mkdtempSync("/tmp/septum-laravel-first-"); roots.push(first);
  const second = mkdtempSync("/tmp/septum-laravel-second-"); roots.push(second);
  const put = (root: string, file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  for (const root of [first, second]) {
    put(root, "routes/web.php", "<?php\nRoute::get('/orders', [OrderController::class, 'index']);\n");
    put(root, "app/Http/Controllers/OrderController.php", "<?php\nclass OrderController {\n public function index() { return 1; }\n}\n");
  }
  put(second, "app/Http/Controllers/OrderController.php", "<?php\nclass OrderController {\n\n\n public function index() { return 2; }\n}\n");
  const extractor = new LaravelSemanticExtractor(first);
  const slices = extractor.extractSlices(second);
  expect(slices).toHaveLength(1);
  expect(slices[0].controller_file).toBe("app/Http/Controllers/OrderController.php");
  expect(slices[0].controller_line).toBe(5);
});

test("Laravel route aliases resolve the explicit imported controller, excluding commented imports", () => {
  const root = mkdtempSync("/tmp/septum-laravel-alias-"); roots.push(root);
  const put = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  put("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }));
  put("routes/web.php", "<?php\n// use App\\Http\\Controllers\\GhostController as Checkout;\nuse App\\Http\\Controllers\\OrderController as Checkout;\nRoute::post('/orders', [Checkout::class, 'store']);\n");
  put("app/Http/Controllers/OrderController.php", "<?php\nnamespace App\\Http\\Controllers;\nclass OrderController { public function store() { return 1; } }\n");
  const result = new LaravelSemanticExtractor(root).extractSlices();
  expect(result).toHaveLength(1);
  expect(result[0].controller_file).toBe("app/Http/Controllers/OrderController.php");
  expect(result[0].controller_line).toBe(3);
  rmSync(join(root, "app/Http/Controllers/OrderController.php"));
  put("app/Http/Controllers/Checkout.php", "<?php class Checkout { public function store() {} }");
  expect(new LaravelSemanticExtractor(root).extractSlices()[0].controller_file).toBeNull();
});
