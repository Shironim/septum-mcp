// Static source patterns only. A competing catalog record is injected below to test
// the common persistence/selection boundary independently of adapter discovery.
export const sliceIntegrityCases: Array<{ framework: string; adapter: string; files: Record<string, string> }> = [
  { framework: "laravel", adapter: "laravel", files: {
    "routes/web.php": "<?php\nRoute::get('/orders', [OrderController::class, 'run']);\n",
    "app/Http/Controllers/OrderController.php": "<?php namespace App\\Http\\Controllers; class OrderController { public function run() { return []; } }",
  } },
  { framework: "symfony", adapter: "symfony", files: {
    "src/Controller/OrderController.php": "<?php namespace App\\Controller; use Symfony\\Component\\Routing\\Attribute\\Route; class OrderController { #[Route('/orders', methods: ['GET'])] public function run() { return []; } }",
  } },
  { framework: "nestjs", adapter: "nestjs", files: {
    "src/orders.controller.ts": "@Controller('orders')\nexport class OrderController {\n @Get()\n run() { return []; }\n}",
  } },
  { framework: "express", adapter: "express", files: { "src/app.ts": 'import express from "express";\nconst app = express();\napp.get("/orders", (req, res) => res.json([]));' } },
  { framework: "fastify", adapter: "fastify", files: { "src/app.ts": 'import Fastify from "fastify";\nconst app = Fastify();\napp.get("/orders", async () => []);' } },
  { framework: "hono", adapter: "hono", files: { "src/app.ts": 'import { Hono } from "hono";\nconst app = new Hono();\napp.get("/orders", (c) => c.json([]));' } },
  { framework: "elysia", adapter: "elysia", files: { "src/app.ts": 'import { Elysia } from "elysia";\nconst app = new Elysia();\napp.get("/orders", () => []);' } },
  { framework: "fastapi", adapter: "fastapi", files: { "app.py": 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/orders")\ndef run():\n    return []\n' } },
  { framework: "django", adapter: "django", files: {
    "views.py": "class OrderView(APIView):\n    def get(self, request):\n        return []\n", "urls.py": 'from django.urls import path\nfrom views import OrderView\nurlpatterns = [path("orders", OrderView.as_view())]\n',
  } },
  { framework: "flask", adapter: "flask", files: { "app.py": 'from flask import Flask\napp = Flask(__name__)\n@app.route("/orders")\ndef run():\n    return []\n' } },
  ...[
    ["net/http", 'http.HandleFunc("GET /orders", run)'],
    ["gin", 'r := gin.Default()\n r.GET("/orders", run)'],
    ["echo", 'r := echo.New()\n r.GET("/orders", run)'],
    ["chi", 'r := chi.NewRouter()\n r.Get("/orders", run)'],
    ["fiber", 'r := fiber.New()\n r.Get("/orders", run)'],
  ].map(([framework, registration]) => ({ framework, adapter: "golang", files: {
    "main.go": `package main\nimport "net/http"\nfunc run(w http.ResponseWriter, r *http.Request) {}\nfunc routes() {\n ${registration}\n}\n`,
  } })),
  { framework: "cli", adapter: "mcp-cli", files: {
    "package.json": '{"name":"fixture","bin":{"fixture":"bin/cli.ts"}}',
    "src/cli/commands/orders.ts": 'export async function ordersCommand() { return []; }',
  } },
  { framework: "mcp-server", adapter: "mcp-cli", files: {
    "package.json": '{"name":"fixture","dependencies":{"@modelcontextprotocol/sdk":"*"}}',
    "src/mcp/server.ts": 'export const TOOL_SCHEMAS = { fixture_orders: {} };',
    "src/mcp/tools/orders.ts": 'export function handleOrders() { return []; }',
  } },
];

