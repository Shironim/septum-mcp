"""Independent expectations for the framework AST batch fixtures."""
from dataclasses import dataclass
from textwrap import dedent


@dataclass(frozen=True)
class FrameworkCase:
    files: dict[str, str]
    # Method, URI, declaration file, declaration line, action.
    routes: tuple[tuple[str, str, str, int, str], ...]
    # Same-length edit to an input and the changed prefix on affected catalog rows.
    edit: tuple[str, str, str, str, str]
    negative_queries: tuple[str, ...]
    adapter: str
    oracle_command: str
    oracle_code: str
    runtime_only_routes: tuple[tuple[str, str, str], ...] = ()


fastapi_handler = 'fixture/handlers.py'
fastapi_main = 'fixture/main.py'
flask_views = 'sample/views.py'
flask_main = 'sample/main.py'
django_urls = 'web/urls.py'
django_views = 'web/views.py'
express_app = 'src/app.ts'
express_handlers = 'src/handlers.ts'
fastify_app = 'src/app.ts'
fastify_handlers = 'src/handlers.ts'

CASES = {
    'fastapi': FrameworkCase(
        files={
            'requirements.txt': 'fastapi==0.115.12\n',
            'fixture/__init__.py': '',
            fastapi_handler: dedent('''\
                import fastapi as api
                router = api.APIRouter(prefix="/orders")
                alias = router

                @alias.api_route(path="", methods=["GET", "POST"], name="orders")
                async def orders():
                    return []

                @router.get("/details/")
                def details():
                    return {}

                verbs = ["DELETE"]
                @router.api_route("/opaque", methods=verbs)
                def opaque():
                    return {}
            '''),
            fastapi_main: dedent('''\
                from fastapi import FastAPI as App, APIRouter as Router
                from . import handlers as endpoints

                app = App()
                layer = Router(prefix="/layer")
                bridge = Router(prefix="/bridge")
                layer.include_router(router=endpoints.router, prefix="/mount")
                bridge.include_router(layer)
                app.include_router(layer, prefix="/one")
                app.include_router(bridge, prefix="/two")

                def health():
                    return {"ok": True}
                app.add_api_route(path="/health", endpoint=health, methods=["GET", "HEAD"], name="health")

                class Decoy:
                    def get(self, path):
                        return lambda action: action
                    def include_router(self, router, prefix):
                        pass

                decoy = Decoy()
                decoy.include_router(layer, prefix="/false-mount")
                @decoy.get("/fake")
                def fake():
                    pass

                label = '@app.get("/string")'
                # @app.get("/comment")
                def never_called():
                    app.include_router(layer, prefix="/nested")

                # A local constructor name shadows the import at this site.
                Router = Decoy
                unrelated = Router()
                @unrelated.get("/shadowed")
                def shadowed():
                    pass
            '''),
        },
        routes=tuple(
            (method, prefix + suffix, fastapi_handler, line, action)
            for prefix in ('/one/layer/mount/orders', '/two/bridge/layer/mount/orders')
            for method, suffix, line, action in [
                ('GET', '', 6, 'orders'), ('POST', '', 6, 'orders'),
                ('GET', '/details/', 10, 'details'),
            ]
        ) + (('GET', '/health', fastapi_main, 12, 'health'), ('HEAD', '/health', fastapi_main, 12, 'health')),
        edit=(fastapi_main, 'prefix="/one"', 'prefix="/new"', '/one/', '/new/'),
        negative_queries=('GET /fake', 'GET /shadowed', 'GET /orders', 'DELETE /one/layer/mount/orders/opaque'),
        adapter='fastapi',
        oracle_command='python',
        oracle_code=dedent('''\
            import json
            from fastapi.routing import APIRoute
            from fixture.main import app
            print(json.dumps([
                (method, route.path, route.endpoint.__name__)
                for route in app.routes if isinstance(route, APIRoute)
                for method in route.methods
            ]))
        '''),
        runtime_only_routes=(
            ('DELETE', '/one/layer/mount/orders/opaque', 'opaque'),
            ('DELETE', '/two/bridge/layer/mount/orders/opaque', 'opaque'),
        ),
    ),
    'flask': FrameworkCase(
        files={
            'requirements.txt': 'Flask==3.1.1\n',
            'sample/__init__.py': '',
            flask_views: dedent('''\
                from flask import Blueprint as MakeBlueprint
                items = MakeBlueprint(name="items", import_name=__name__, url_prefix="/unused")
                bound = items

                @bound.route(rule="", methods=("GET", "POST"), endpoint="catalog")
                def catalog():
                    return []

                def update(item_id):
                    return {"id": item_id}
                handler = update
                items.add_url_rule("/<int:item_id>", "update", handler, methods=["PATCH"])

                methods = ["DELETE"]
                @items.route("/opaque", methods=methods)
                def opaque():
                    return ""
            '''),
            flask_main: dedent('''\
                import flask as framework
                from .views import items as endpoints

                app = framework.Flask(__name__, static_folder=None)
                parent = framework.Blueprint("parent", __name__, url_prefix="/parent")
                bridge = framework.Blueprint("bridge", __name__, url_prefix="/bridge")
                parent.register_blueprint(blueprint=endpoints, url_prefix="/stock")
                parent.register_blueprint(endpoints, url_prefix="/archive", name="archived")
                bridge.register_blueprint(parent, url_prefix=None)
                app.register_blueprint(parent, url_prefix="/direct", name="direct")
                app.register_blueprint(bridge)

                def health():
                    return {"ok": True}
                app.add_url_rule(rule="/health", view_func=health)

                class Decoy:
                    def route(self, rule):
                        return lambda action: action
                    def register_blueprint(self, blueprint, url_prefix):
                        pass

                decoy = Decoy()
                decoy.register_blueprint(parent, url_prefix="/wrong")
                @decoy.route("/fake")
                def fake():
                    pass

                label = '@app.route("/string")'
                # @app.route("/comment")
                def never_called():
                    app.register_blueprint(parent, url_prefix="/nested")

                from flask import Blueprint
                Blueprint = Decoy
                not_a_blueprint = Blueprint()
                @not_a_blueprint.route("/shadowed")
                def shadowed():
                    pass
            '''),
        },
        routes=tuple(
            (method, prefix + suffix, flask_views, line, action)
            for group in ('/direct', '/bridge/parent')
            for edge in ('/stock', '/archive')
            for prefix in (group + edge,)
            for method, suffix, line, action in [
                ('GET', '', 6, 'catalog'), ('POST', '', 6, 'catalog'),
                ('PATCH', '/<int:item_id>', 9, 'update'),
            ]
        ) + (('GET', '/health', flask_main, 13, 'health'),),
        edit=(flask_main, 'url_prefix="/direct"', 'url_prefix="/public"', '/direct/', '/public/'),
        negative_queries=('GET /fake', 'GET /shadowed', 'GET /parent/unused', 'GET /direct/stock/opaque',
                          'DELETE /direct/stock/opaque'),
        adapter='flask',
        oracle_command='python',
        oracle_code=dedent('''\
            import json
            from sample.main import app
            # These fixtures declare neither HEAD nor OPTIONS explicitly.
            print(json.dumps([
                (method, rule.rule, app.view_functions[rule.endpoint].__name__)
                for rule in app.url_map.iter_rules()
                for method in rule.methods - {"HEAD", "OPTIONS"}
            ]))
        '''),
        runtime_only_routes=tuple(
            ('DELETE', group + edge + '/opaque', 'opaque')
            for group in ('/direct', '/bridge/parent')
            for edge in ('/stock', '/archive')
        ),
    ),
    'django': FrameworkCase(
        files={
            'requirements.txt': 'Django==5.2.10\ndjangorestframework==3.16.1\n',
            'web/__init__.py': '',
            django_urls: dedent('''\
                from django.urls import path as url, include as mount
                from . import catalog
                from .views import health as ready

                ignored = url("not-in-urlconf/", ready)
                variable = "dynamic/"
                urlpatterns = [
                    url("main/", mount(catalog)),
                    url("side/", mount("web.bridge")),
                    url(variable, ready),
                ]
                urlpatterns.append(url(route="ready/", view=ready, name="ready"))
                label = 'url("decoy/", ready)'
                # url("comment/", ready)
            '''),
            'web/bridge.py': dedent('''\
                from django.urls import path, include
                urlpatterns = [path("nested/", include("web.catalog"))]
            '''),
            'web/catalog.py': dedent('''\
                from django.urls import path, include
                from rest_framework.routers import SimpleRouter as MakeRouter
                from . import views as actual
                from .views import Orders as OrdersAlias

                router = MakeRouter()
                unused = MakeRouter()
                binding = router
                binding.register(prefix="orders", viewset=OrdersAlias, basename="order")
                unused.register("unused", OrdersAlias, basename="unused")
                urlpatterns = [path("v1/", include(router.urls))]
                urlpatterns += [path("checkout/<int:item>/", actual.Checkout.as_view())]
                urlpatterns.extend([path("mapped/", OrdersAlias.as_view({"put": "list"}))])
            '''),
            django_views: dedent('''\
                from django.http import HttpResponse
                from django.views import View as ClassView
                from django.views.decorators.http import require_POST as post_only
                from rest_framework.viewsets import ViewSet as Base
                from rest_framework.decorators import action as operation

                class Checkout(ClassView):
                    def get(self, request, item):
                        return HttpResponse(item)

                class Orders(Base):
                    def list(self, request):
                        return HttpResponse("orders")

                    @operation(detail=True, methods=["post"], url_path="run-now")
                    def run(self, request, pk=None):
                        return HttpResponse(pk)

                @post_only
                def health(request):
                    return HttpResponse("ok")
            '''),
            'web/zzz_views.py': dedent('''\
                from django.views import View
                class Checkout(View):
                    def post(self, request, item):
                        raise AssertionError("unrelated class")
            '''),
        },
        routes=tuple(
            (method, prefix + suffix, django_views, line, action)
            for prefix in ('/main', '/side/nested')
            for method, suffix, line, action in [
                ('GET', '/v1/orders', 12, 'list'), ('POST', '/v1/orders/{id}/run-now', 16, 'run'),
                ('GET', '/checkout/{item}', 8, 'get'), ('PUT', '/mapped', 12, 'list'),
            ]
        ) + (('POST', '/ready', django_views, 20, 'health'),),
        edit=(django_urls, 'url("main/"', 'url("next/"', '/main/', '/next/'),
        negative_queries=('GET /not-in-urlconf', 'POST /not-in-urlconf', 'GET /main/v1/unused',
                          'POST /main/checkout/{item}', 'GET /main/mapped', 'POST /dynamic'),
        adapter='django',
        oracle_command='python',
        oracle_code=dedent(r'''
            import json, re
            import django
            from django.conf import settings
            from django.test import RequestFactory
            from django.urls import get_resolver, URLResolver
            settings.configure(ROOT_URLCONF="web.urls", SECRET_KEY="fixture")
            django.setup()
            requests = RequestFactory()

            def rows(patterns, prefix=""):
                for entry in patterns:
                    raw = str(entry.pattern).removeprefix("^").removesuffix("$")
                    if isinstance(entry, URLResolver):
                        yield from rows(entry.url_patterns, prefix + raw)
                        continue
                    callback = entry.callback
                    uri = "/" + (prefix + raw).strip("/")
                    uri = re.sub(r"\(\?P<pk>[^)]+\)", "{id}", uri)
                    uri = re.sub(r"<(?:[^:>]+:)?([^>]+)>", r"{\1}", uri)
                    if getattr(callback, "actions", None):
                        for method, action in callback.actions.items():
                            yield method.upper(), uri, action
                    elif getattr(callback, "view_class", None):
                        for method in ("get", "post", "put", "patch", "delete"):
                            if hasattr(callback.view_class, method):
                                yield method.upper(), uri, method
                    else:
                        for method in ("get", "post", "put", "patch", "delete", "options", "head"):
                            if callback(getattr(requests, method)(uri)).status_code != 405:
                                yield method.upper(), uri, callback.__name__

            print(json.dumps(list(rows(get_resolver().url_patterns))))
        '''),
        runtime_only_routes=(('POST', '/dynamic', 'health'),),
    ),
    'express': FrameworkCase(
        files={
            'package.json': '{"type":"module","dependencies":{"express":"5.1.0"}}',
            express_handlers: dedent('''\
                export function show(_req, res) {
                    res.send("show");
                }
                export const store = (_req, res) => res.send("store");
            '''),
            'src/leaf.ts': dedent('''\
                import { Router as makeRouter } from "express";
                import { show as selected, store } from "./handlers";
                export const routes = makeRouter();
                const pass = (_req, _res, next) => next();
                const endpoint = routes.route(["/items", "/others"]);
                endpoint.get(pass, [selected]).post([pass, store]);
            '''),
            'src/api.ts': 'export { routes as default } from "./leaf";\n',
            express_app: dedent('''\
                import createExpress from "express";
                import * as routes from "./api";

                export const app = createExpress();
                const bridge = createExpress.Router();
                const layer = routes.default;
                const pass = (_req, _res, next) => next();
                app.use("/one", pass, [layer]);
                bridge.use("/deep", layer);
                app.use("/two", bridge);

                function ready(_req, res) {
                    res.send("ready");
                }
                app.get("/ready", ready);

                const hidden = createExpress.Router();
                function opaque(_req, res) {
                    res.send("opaque");
                }
                hidden.get("/hidden", opaque);
                const dynamic = ["/", "opaque"].join("");
                app.use(dynamic, hidden);

                const unrelated = { get() {}, use() {} };
                unrelated.get("/fake", ready);
                unrelated.use("/foreign", layer);
                const example = 'app.get("/string", ready)';
                // app.get("/comment", ready);
                function neverCalled() {
                    app.get("/nested", ready);
                }
            '''),
        },
        routes=tuple(
            (method, prefix + suffix, express_handlers, line, action)
            for prefix in ('/one', '/two/deep')
            for suffix in ('/items', '/others')
            for method, line, action in [('GET', 1, 'show'), ('POST', 4, 'store')]
        ) + (('GET', '/ready', express_app, 12, 'ready'),),
        edit=(express_app, 'app.use("/one"', 'app.use("/new"', '/one/', '/new/'),
        negative_queries=('GET /fake', 'GET /nested', 'GET /items', 'GET /hidden',
                          'GET /opaque/hidden', 'GET /foreign/items', 'PATCH /one/items'),
        adapter='express',
        oracle_command='javascript',
        oracle_code=dedent('''\
            import { app } from "./src/app";
            const paths = ["/ready", "/hidden", "/opaque/hidden", "/fake", "/nested",
              "/foreign/items", "/items", "/others"];
            for (const prefix of ["/one", "/new", "/two", "/two/deep"]) {
              for (const route of ["/items", "/others"]) paths.push(prefix + route);
            }
            const server = app.listen(0, "127.0.0.1");
            await new Promise((ok, fail) => {
              server.once("listening", ok);
              server.once("error", fail);
            });
            try {
              const rows = [];
              for (const path of paths) {
                for (const method of ["GET", "POST", "PATCH"]) {
                  const response = await fetch("http://127.0.0.1:" + server.address().port + path, { method });
                  if (response.ok) rows.push([method, path, await response.text()]);
                  else await response.arrayBuffer();
                }
              }
              console.log(JSON.stringify(rows));
            } finally {
              server.closeAllConnections();
              server.close();
            }
        '''),
        runtime_only_routes=(('GET', '/opaque/hidden', 'opaque'),),
    ),
    'fastify': FrameworkCase(
        files={
            'package.json': '{"type":"module","dependencies":{"fastify":"5.6.2","fastify-plugin":"5.1.0"}}',
            fastify_handlers: dedent('''\
                export function list() { return []; }
                export function save() { return {}; }
            '''),
            'src/catalog.ts': dedent('''\
                import { list as select, save } from "./handlers";
                function decoy(instance) {
                    instance.get("/never", select);
                }
                export default async function catalog(instance) {
                    const api = instance;
                    const route = { method: ["POST", "PUT"], url: "/write", handler: save };
                    api.route(route);
                    api.get("/read", select);
                    const foreign = { get() {} };
                    foreign.get("/fake", select);
                    const label = 'instance.get("/string", select)';
                    // instance.get("/comment", select);
                }
            '''),
            fastify_app: dedent('''\
                import { fastify as create } from "fastify";
                import adapt from "fastify-plugin";
                import mounted from "./catalog";
                export const app = create({ exposeHeadRoutes: false });
                export const observed = [];
                app.addHook("onRoute", route => {
                    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
                        observed.push([method, route.url, route.handler.name]);
                    }
                });

                const keep = async () => "keep";
                app.get("/keep", keep);
                app.register(mounted, { prefix: "/one" });
                app.register(async gateway => {
                    const local = gateway;
                    local.register(mounted, { prefix: "/edge" });
                }, { prefix: "/two" });

                const expose = async () => "expose";
                const retain = async () => "retain";
                const wrapped = adapt(async child => { child.get("/expose", expose); });
                const enclosed = adapt(async child => { child.get("/retain", retain); }, { encapsulate: true });
                app.register(wrapped, { prefix: "/ignored" });
                app.register(enclosed, { prefix: "/scoped" });

                const hidden = async () => "hidden";
                const prefix = ["/", "opaque"].join("");
                app.register(async child => { child.get("/hidden", hidden); }, { prefix });
                const unrelated = { register() {}, get() {} };
                unrelated.register(mounted, { prefix: "/foreign" });
                unrelated.get("/foreign", keep);
                async function notMounted(instance) {
                    instance.get("/unmounted", keep);
                }
            '''),
        },
        routes=tuple(
            (method, prefix + suffix, fastify_handlers, line, action)
            for prefix in ('/one', '/two/edge')
            for method, suffix, line, action in [
                ('GET', '/read', 1, 'list'), ('POST', '/write', 2, 'save'), ('PUT', '/write', 2, 'save'),
            ]
        ) + (
            ('GET', '/keep', fastify_app, 12, 'keep'),
            ('GET', '/expose', fastify_app, 20, 'expose'),
            ('GET', '/scoped/retain', fastify_app, 21, 'retain'),
        ),
        edit=(fastify_app, 'prefix: "/one"', 'prefix: "/new"', '/one/', '/new/'),
        negative_queries=('GET /read', 'GET /one/never', 'GET /one/fake', 'GET /hidden',
                          'GET /opaque/hidden', 'GET /foreign/read', 'GET /unmounted', 'GET /ignored/expose'),
        adapter='fastify',
        oracle_command='javascript',
        oracle_code=dedent('''\
            import { app, observed } from "./src/app";
            try {
                await app.ready();
                console.log(JSON.stringify(observed));
            } finally {
                await app.close();
            }
        '''),
        runtime_only_routes=(('GET', '/opaque/hidden', 'hidden'),),
    ),
    'hono': FrameworkCase(
        files={
            'package.json': '{"type":"module","dependencies":{"hono":"4.10.6"}}',
            'src/handlers.ts': dedent('''\
                export function read(c) { return c.text("read"); }
                export function late(c) { return c.text("late"); }
                export function ready(c) { return c.text("ready"); }
                export function hidden(c) { return c.text("hidden"); }
            '''),
            'src/leaf.ts': dedent('''\
                import { Hono as Router } from "hono";
                import { read as selected } from "./handlers";
                const router = new Router().basePath("/v3");
                export const endpoint = router
                  .get("/", selected)
                  .on(["GET", "PURGE"], ["/a", "/b"], selected);
            '''),
            'src/app.ts': dedent('''\
                import * as framework from "hono";
                import { endpoint as leaf } from "./leaf";
                import { late, ready, hidden } from "./handlers";

                export const app = new framework.Hono();
                const parent = new framework.Hono();
                parent.route("/deep", leaf);
                const api = app.basePath("/api");
                api.route("/one", parent);
                parent.get("/late", late);
                app.route("/two", parent);
                app.get("/ready", ready);

                const opaque = ["/", "opaque"].join("");
                app.basePath(opaque).get("/hidden", hidden);
                const foreign = { on() {}, route() {} };
                foreign.on("GET", "/fake", hidden);
                foreign.route("/wrong", leaf);
                const example = 'app.get("/string", hidden)';
                // app.get("/comment", hidden);
                function uncalled() {
                    app.get("/nested", hidden);
                }
            '''),
        },
        routes=tuple(
            (method, prefix + tail, 'src/handlers.ts', 1, 'read')
            for prefix in ('/api/one/deep/v3', '/two/deep/v3')
            for method, tail in [('GET', ''), ('GET', '/a'), ('PURGE', '/a'), ('GET', '/b'), ('PURGE', '/b')]
        ) + (('GET', '/two/late', 'src/handlers.ts', 2, 'late'), ('GET', '/ready', 'src/handlers.ts', 3, 'ready')),
        edit=('src/app.ts', 'route("/one"', 'route("/new"', '/api/one/', '/api/new/'),
        negative_queries=('GET /api/one/late', 'GET /v3', 'GET /wrong/v3', 'GET /fake', 'GET /nested',
                          'GET /opaque/hidden', 'PURGE /api/one/deep/v3'),
        adapter='hono',
        oracle_command='javascript',
        oracle_code=dedent('''\
            import {app} from "./src/app";
            console.log(JSON.stringify(app.routes.map(row => [row.method, row.path, row.handler.name])));
        '''),
        runtime_only_routes=(('GET', '/opaque/hidden', 'hidden'),),
    ),
    'elysia': FrameworkCase(
        files={
            'package.json': '{"type":"module","dependencies":{"elysia":"1.4.16"}}',
            'src/handlers.ts': dedent('''\
                export function list() { return "list"; }
                export function detail() { return "detail"; }
                export function late() { return "late"; }
                export function save() { return "save"; }
                export function direct() { return "direct"; }
                export function hidden() { return "hidden"; }
            '''),
            'src/catalog.ts': dedent('''\
                import { Elysia as Router } from "elysia";
                import { list as selected, detail } from "./handlers";
                const config = { prefix: "/catalog" };
                export const catalog = new Router(config)
                  .get("", selected)
                  .route("PROPFIND", "/detail", detail);
            '''),
            'src/app.ts': dedent('''\
                import { Elysia as Router, t } from "elysia";
                import { catalog as child } from "./catalog";
                import { late, list, save, direct, hidden } from "./handlers";

                export const app = new Router({ prefix: "/root" });
                app.use([child]);
                child.get("/late", late);
                const body = t.Object({ name: t.String() });
                app.group("/api", (branch) => {
                    const alias = branch;
                    return alias.group("/nested", { body }, (inner) => inner
                        .use(child)
                        .guard({ body }, area => area.post("", save)));
                });
                app.use(instance => instance.get("/direct", direct));
                app.get("/replace", list).get("/replace", save);

                const opaque = ["/", "opaque"].join("");
                app.group(opaque, instance => instance.get("/hidden", hidden));
                const foreign = { get() {}, use() {}, group() {} };
                foreign.get("/fake", hidden);
                foreign.use(child);
                foreign.group("/foreign", instance => instance.get("/other", hidden));
                const example = 'app.get("/string", hidden)';
                // app.get("/comment", hidden);
                function unregistered(instance) { return instance.get("/unregistered", hidden); }
            '''),
        },
        routes=(
            ('GET', '/root/catalog', 'src/handlers.ts', 1, 'list'),
            ('PROPFIND', '/root/catalog/detail', 'src/handlers.ts', 2, 'detail'),
            ('GET', '/root/api/nested/catalog', 'src/handlers.ts', 1, 'list'),
            ('PROPFIND', '/root/api/nested/catalog/detail', 'src/handlers.ts', 2, 'detail'),
            ('GET', '/root/api/nested/catalog/late', 'src/handlers.ts', 3, 'late'),
            ('POST', '/root/api/nested', 'src/handlers.ts', 4, 'save'),
            ('GET', '/root/direct', 'src/handlers.ts', 5, 'direct'),
            ('GET', '/root/replace', 'src/handlers.ts', 4, 'save'),
        ),
        edit=('src/app.ts', 'group("/api"', 'group("/new"', '/root/api', '/root/new'),
        negative_queries=('GET /root/catalog/late', 'GET /catalog', 'GET /root/fake',
                          'GET /root/opaque/hidden', 'GET /root/foreign/other', 'GET /root/unregistered'),
        adapter='elysia',
        oracle_command='javascript',
        oracle_code=dedent('''\
            import { app } from "./src/app";
            console.log(JSON.stringify(app.routes.map(row => [row.method, row.path, row.handler.name])));
        '''),
        runtime_only_routes=(('GET', '/root/opaque/hidden', 'hidden'),),
    ),
    'nestjs': FrameworkCase(
        files={
            'package.json': dedent('''\
                {"type":"module","dependencies":{"@nestjs/common":"11.1.11","@nestjs/core":"11.1.11",
                "@nestjs/platform-express":"11.1.11","reflect-metadata":"0.2.2","rxjs":"7.8.2"}}
            '''),
            'tsconfig.json': '{"compilerOptions":{"experimentalDecorators":true,"emitDecoratorMetadata":true}}',
            'src/api.ts': dedent('''\
                import { Controller as Api, Get as Read, RequestMapping as MapRoute,
                    RequestMethod as Verb } from "@nestjs/common";
                import * as common from "@nestjs/common";
                const Get = (_path: string): MethodDecorator => () => {};
                const computed = () => ["", "dynamic"].join("/");

                @Api({ path: ["v1/orders", "archive"] })
                export class OrdersController {
                    @Read(["", "list"])
                    list() { return "list"; }
                    @MapRoute({ path: "save", method: Verb.PUT })
                    save() { return "save"; }
                    @common.All("dispatch")
                    dispatch() { return "dispatch"; }
                    @Get("fake")
                    fake() { return "fake"; }
                    @Read(computed())
                    dynamic() { return "dynamic"; }
                }
            '''),
            'src/other.ts': dedent('''\
                import * as common from "@nestjs/common";
                @common.Controller("health")
                export class OrdersController {
                    @common.Get("ready")
                    ready() { return "ready"; }
                }
                @common.Controller({ get path() { return "via-getter"; } })
                export class GetterController {
                    @common.Get("diagnostic")
                    diagnostic() { return "diagnostic"; }
                }
            '''),
            'src/app.ts': dedent('''\
                import { Module } from "@nestjs/common";
                import { OrdersController } from "./api";
                import { OrdersController as HealthController, GetterController } from "./other";
                @Module({ controllers: [OrdersController, HealthController, GetterController] })
                export class AppModule {}
            '''),
        },
        routes=(
            ('GET', '/v1/orders', 'src/api.ts', 10, 'list'),
            ('GET', '/v1/orders/list', 'src/api.ts', 10, 'list'),
            ('GET', '/archive', 'src/api.ts', 10, 'list'),
            ('GET', '/archive/list', 'src/api.ts', 10, 'list'),
            ('PUT', '/v1/orders/save', 'src/api.ts', 12, 'save'),
            ('PUT', '/archive/save', 'src/api.ts', 12, 'save'),
            ('ANY', '/v1/orders/dispatch', 'src/api.ts', 14, 'dispatch'),
            ('ANY', '/archive/dispatch', 'src/api.ts', 14, 'dispatch'),
            ('GET', '/health/ready', 'src/other.ts', 5, 'ready'),
        ),
        edit=('src/api.ts', '"v1/orders"', '"v2/orders"', '/v1/orders', '/v2/orders'),
        negative_queries=('GET /v1/orders/fake', 'GET /archive/fake', 'GET /v1/orders/dynamic',
                          'GET /archive/dynamic', 'POST /v1/orders/save', 'GET /health/list',
                          'GET /diagnostic', 'GET /via-getter/diagnostic'),
        adapter='nestjs',
        oracle_command='javascript',
        oracle_code=dedent('''\
            import "reflect-metadata";
            import { METHODS } from "node:http";
            import { NestFactory } from "@nestjs/core";
            import { AppModule } from "./src/app";

            const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
            try {
                await app.listen(0, "127.0.0.1");
                const address = await app.getUrl();
                const routes = [];
                for (const { route } of app.getHttpAdapter().getInstance().router.stack) {
                    if (!route) continue;
                    const registered = Object.keys(route.methods).map(key => key.toUpperCase());
                    const matchesAll = route.methods._all || (
                        registered.length === METHODS.length && METHODS.every(method => registered.includes(method))
                    );
                    const methods = matchesAll ? ["ANY"] : registered;
                    for (const method of methods) {
                        const requestMethods = method === "ANY" ? ["GET", "PATCH"] : [method];
                        const actions = new Set();
                        for (const requestMethod of requestMethods) {
                            const response = await fetch(address + route.path, { method: requestMethod });
                            if (!response.ok) throw new Error(`${requestMethod} ${route.path}: ${response.status}`);
                            actions.add(await response.text());
                        }
                        if (actions.size !== 1) throw new Error(`Inconsistent action for ${route.path}`);
                        routes.push([method, route.path, [...actions][0]]);
                    }
                }
                console.log(JSON.stringify(routes));
            } finally {
                await app.close();
            }
        '''),
        runtime_only_routes=(('GET', '/v1/orders/dynamic', 'dynamic'), ('GET', '/archive/dynamic', 'dynamic'),
                             ('GET', '/via-getter/diagnostic', 'diagnostic')),
    ),
}
