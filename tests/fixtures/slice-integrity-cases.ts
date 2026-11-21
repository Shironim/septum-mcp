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
    "src/orders.controller.ts": "import { Controller, Get } from '@nestjs/common';\n@Controller('orders')\nexport class OrderController {\n @Get()\n run() { return []; }\n}",
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
    ["net/http", "net/http", "w http.ResponseWriter, r *http.Request", 'http.HandleFunc("GET /orders", run)'],
    ["gin", "github.com/gin-gonic/gin", "c *gin.Context", 'r := gin.Default()\n r.GET("/orders", run)'],
    ["echo", "github.com/labstack/echo/v4", "c echo.Context", 'r := echo.New()\n r.GET("/orders", run)'],
    ["chi", "github.com/go-chi/chi/v5", "w http.ResponseWriter, r *http.Request", 'r := chi.NewRouter()\n r.Get("/orders", run)'],
    ["fiber", "github.com/gofiber/fiber/v2", "c *fiber.Ctx", 'r := fiber.New()\n r.Get("/orders", run)'],
  ].map(([framework, dependency, parameters, registration]) => ({ framework, adapter: "golang", files: {
    "main.go": `package main\n${framework === "chi" ? 'import "net/http"\n' : ""}import "${dependency}"\nfunc run(${parameters}) ${framework === "echo" || framework === "fiber" ? "error { return nil }" : "{}"}\nfunc routes() {\n ${registration}\n}\n`,
  } })),
  { framework: "cli", adapter: "mcp-cli", files: {
    "package.json": '{"name":"fixture","bin":{"fixture":"bin/cli.ts"}}',
    "bin/cli.ts": 'import { ordersCommand } from "../src/cli/commands/orders.ts";\nswitch (process.argv[2]) { case "orders": ordersCommand(); break; }',
    "src/cli/commands/orders.ts": 'export async function ordersCommand() { return []; }',
  } },
  { framework: "mcp-server", adapter: "mcp-cli", files: {
    "package.json": '{"name":"fixture","dependencies":{"@modelcontextprotocol/sdk":"*"}}',
    "src/mcp/server.ts": 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { handleOrders } from "./tools/orders.ts";\nconst server = new McpServer({ name: "fixture", version: "1" });\nserver.registerTool("fixture_orders", {}, handleOrders);',
    "src/mcp/tools/orders.ts": 'export function handleOrders() { return []; }',
  } },
];

