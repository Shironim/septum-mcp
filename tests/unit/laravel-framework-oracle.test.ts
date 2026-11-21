import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { LaravelSemanticExtractor } from "../../src/core/parser/extractors/laravel-semantic.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("Laravel route groups preserve literal prefixes, resource actions and controller scope", async () => {
  const content = String.raw`<?php
use Illuminate\Support\Facades\Route as Router;
use App\Http\Controllers\{OrderController as Orders, InvoiceController as Invoices};
Router::prefix('api')
  ->name('api.')
  ->group(function () {
    Router::group(['prefix' => 'v1', 'as' => 'v1.'], function () {
      Router::resource('orders', Orders::class)->only(['index', 'store']);
      Router::apiResource('invoices', Invoices::class)->except('destroy');
      Router::controller(Orders::class)->group(function () {
        Router::get('/orders/{id}', 'show')->name('orders.show');
      });
    });
  });
Router::get('/health', fn () => 1);
`;
  const routes = await new LaravelSemanticExtractor().parseRoutesContent(content);
  expect(routes.map(route => [route.httpMethod, route.uri, route.routeName, route.controllerClass, route.actionName]))
    .toEqual([
      ["GET", "/api/v1/orders", "api.v1.orders.index", "Orders", "index"],
      ["POST", "/api/v1/orders", "api.v1.orders.store", "Orders", "store"],
      ["GET", "/api/v1/invoices", "api.v1.invoices.index", "Invoices", "index"],
      ["POST", "/api/v1/invoices", "api.v1.invoices.store", "Invoices", "store"],
      ["GET", "/api/v1/invoices/{id}", "api.v1.invoices.show", "Invoices", "show"],
      ["PUT", "/api/v1/invoices/{id}", "api.v1.invoices.update", "Invoices", "update"],
      ["GET", "/api/v1/orders/{id}", "api.v1.orders.show", "Orders", "show"],
      ["GET", "/health", undefined, "Closure", "handle"],
    ]);
});
test("Laravel resource route declarations exclude comments, strings and heredoc decoys", async () => {
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
  const routes = await new LaravelSemanticExtractor().parseRoutesContent(content);
  expect([...new Set(routes.map(route => route.controllerClass))].sort()).toEqual(["InvoiceController", "OrderController"]);
  expect(routes.filter(route => route.controllerClass === "OrderController")).toHaveLength(7);
  expect(routes.filter(route => route.controllerClass === "InvoiceController")).toHaveLength(5);
});

test("Laravel AST excludes shadowed facades, dynamic groups, and route strings in unrelated closures", async () => {
  const content = String.raw`<?php
namespace Routes;
use App\Support\FakeRouter as Route;
use Illuminate\Support\Facades\Route as Router;
Route::get('/wrong-facade', [Controller::class, 'index']);
Router::prefix($prefix)->group(function () {
  Router::get('/dynamic', [Controller::class, 'index']);
});
$callback = function () { Router::get('/never-registered', [Controller::class, 'index']); };
Router::resource('hidden', Controller::class)->only($actions);
Router::resource('listed', Controller::class, ['only' => ['index']]);
Router::get('/actual', [Controller::class, 'index']);
`;
  const routes = await new LaravelSemanticExtractor().parseRoutesContent(content);
  expect(routes.map(route => [route.uri, route.controllerTarget])).toEqual([
    ["/listed", "Routes\\Controller"],
    ["/actual", "Routes\\Controller"],
  ]);
});

test("Laravel grouped imports bind the selected class method in a file with competing method names", async () => {
  const root = mkdtempSync("/tmp/septum-laravel-controller-ast-"); roots.push(root);
  const put = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  put("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }));
  put("routes/web.php", String.raw`<?php
use App\Http\Controllers\Admin\{OrdersController as Orders};
Route::get('/orders', [Orders::class, 'index']);
Route::get('/missing', [Orders::class, 'missing']);
`);
  put("app/Http/Controllers/OrdersController.php", "<?php class OrdersController { public function index() {} }");
  put("app/Http/Controllers/Admin/OrdersController.php", String.raw`<?php
namespace App\Http\Controllers\Admin;
class Decoy { public function index() {} public function missing() {} }
class OrdersController {
  public function index(): string { return 'actual'; }
}
`);
  const routes = await new LaravelSemanticExtractor(root).extractSlices();
  expect(routes.map(route => [route.route_uri, route.controller_file, route.controller_line])).toEqual([
    ["/orders", "app/Http/Controllers/Admin/OrdersController.php", 5],
    ["/missing", null, 0],
  ]);
});

test("registry-style explicit workspace roots resolve controllers without using constructor cwd", async () => {
  const first = mkdtempSync("/tmp/septum-laravel-first-"); roots.push(first);
  const second = mkdtempSync("/tmp/septum-laravel-second-"); roots.push(second);
  const put = (root: string, file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  for (const root of [first, second]) {
    put(root, "routes/web.php", "<?php\nRoute::get('/orders', [OrderController::class, 'index']);\n");
    put(root, "app/Http/Controllers/OrderController.php", "<?php\nclass OrderController {\n public function index() { return 1; }\n}\n");
  }
  put(second, "app/Http/Controllers/OrderController.php", "<?php\nclass OrderController {\n\n\n public function index() { return 2; }\n}\n");
  const extractor = new LaravelSemanticExtractor(first);
  const slices = await extractor.extractSlices(second);
  expect(slices).toHaveLength(1);
  expect(slices[0].controller_file).toBe("app/Http/Controllers/OrderController.php");
  expect(slices[0].controller_line).toBe(5);
});

test("Laravel route aliases resolve the explicit imported controller, excluding commented imports", async () => {
  const root = mkdtempSync("/tmp/septum-laravel-alias-"); roots.push(root);
  const put = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  put("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }));
  put("routes/web.php", "<?php\n// use App\\Http\\Controllers\\GhostController as Checkout;\nuse App\\Http\\Controllers\\OrderController as Checkout;\nRoute::post('/orders', [Checkout::class, 'store']);\n");
  put("app/Http/Controllers/OrderController.php", "<?php\nnamespace App\\Http\\Controllers;\nclass OrderController { public function store() { return 1; } }\n");
  const result = await new LaravelSemanticExtractor(root).extractSlices();
  expect(result).toHaveLength(1);
  expect(result[0].controller_file).toBe("app/Http/Controllers/OrderController.php");
  expect(result[0].controller_line).toBe(3);
  rmSync(join(root, "app/Http/Controllers/OrderController.php"));
  put("app/Http/Controllers/Checkout.php", "<?php class Checkout { public function store() {} }");
  expect((await new LaravelSemanticExtractor(root).extractSlices())[0].controller_file).toBeNull();
});
