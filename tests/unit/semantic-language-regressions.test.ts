import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FastApiSemanticExtractor } from "../../src/core/parser/extractors/fastapi-semantic.ts";
import { NestJsSemanticExtractor } from "../../src/core/parser/extractors/nestjs-semantic.ts";
import { DjangoSemanticExtractor } from "../../src/core/parser/extractors/django-semantic.ts";
import { FlaskSemanticExtractor } from "../../src/core/parser/extractors/flask-semantic.ts";
import { blankCommentsAndStrings, findClosingParenthesis } from "../../src/core/parser/boundary-tracker.ts";

describe("framework language regressions", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "septum-semantic-depth-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const [framework, extractor, source] of [
    ["FastAPI", new FastApiSemanticExtractor(), `app = FastAPI()
@app.get(f"/orders/{kind}")
def dynamic(): pass
@app.get(b"/bytes")
def bytes_path(): pass
@app.get("/sta" "tic")
def static_path(): pass
@app.get("/esc\\x61ped")
def escaped_path(): pass
`],
    ["Flask", new FlaskSemanticExtractor(), `app = Flask(__name__)
@app.route(f"/orders/{kind}")
def dynamic(): pass
@app.route(b"/bytes")
def bytes_path(): pass
@app.route("/sta" "tic")
def static_path(): pass
@app.route("/esc\\x61ped")
def escaped_path(): pass
`],
    ["Django", new DjangoSemanticExtractor(), `@api_view(["GET"])
def dynamic(request): pass
@api_view(["GET"])
def bytes_path(request): pass
@api_view(["GET"])
def static_path(request): pass
@api_view(["GET"])
def escaped_path(request): pass
urlpatterns = [
path(f"orders/{kind}", dynamic),
path(b"bytes", bytes_path),
path("sta" "tic", static_path),
path("esc\\x61ped", escaped_path),
]`],
  ] as const) {
    it(`${framework} accepts static string values and excludes interpolated/bytes route targets`, async () => {
      writeFileSync(join(root, "urls.py"), source);
      const slices = await extractor.extractSlices(root);
      expect(slices.map(s => s.route_uri).sort()).toEqual(["/escaped", "/static"]);
    });
  }

  it("does not replace unresolved FastAPI prefixes with an empty prefix", async () => {
    writeFileSync(join(root, "api.py"), `app = FastAPI()
router = APIRouter(prefix=prefix)
child = APIRouter()
app.include_router(child, prefix=f"/{kind}")
@router.get("/orders")
def orders(): pass
@child.get("/payments")
def payments(): pass
@app.get("/health")
def health(): pass
`);
    expect((await new FastApiSemanticExtractor().extractSlices(root)).map(s => s.route_uri)).toEqual(["/health"]);
  });

  it("applies Flask registration overrides and keeps unresolved blueprint prefixes unresolved", async () => {
    writeFileSync(join(root, "api.py"), `app = Flask(__name__)
known = Blueprint("known", __name__, url_prefix="/default")
unknown = Blueprint("unknown", __name__, url_prefix=prefix)
child = Blueprint("child", __name__)
app.register_blueprint(known, url_prefix="/override")
app.register_blueprint(child, url_prefix=f"/{kind}")
@known.route("/orders")
def orders(): pass
@unknown.route("/unknown")
def missing(): pass
@child.route("/payments")
def payments(): pass
`);
    expect((await new FlaskSemanticExtractor().extractSlices(root)).map(s => s.route_uri)).toEqual(["/override/orders"]);
  });

  for (const [override, expected] of [["None", "/parent/default/orders"], ['""', "/parent/orders"]]) {
    it(`preserves nested Flask blueprint prefixes with override ${override}`, async () => {
      writeFileSync(join(root, "api.py"), `app = Flask(__name__)
parent = Blueprint("parent", __name__, url_prefix="/parent")
child = Blueprint("child", __name__, url_prefix="/default")
parent.register_blueprint(child, url_prefix=${override})
app.register_blueprint(parent)
@child.route("/orders")
def orders(): pass
`);
      expect((await new FlaskSemanticExtractor().extractSlices(root)).map(s => s.route_uri)).toEqual([expected]);
    });
  }

  it("balances nested parameters while ignoring strings and comments and rejects incomplete input", async () => {
    const source = '(call(")"), /* ) */ dto) trailing';
    expect(findClosingParenthesis(blankCommentsAndStrings(source), 0)).toBe(source.indexOf(') trailing'));
    expect(findClosingParenthesis('(call(', 0)).toBe(-1);
    expect(findClosingParenthesis('call()', 0)).toBe(-1);
  });

  it("extracts annotated FastAPI handlers with multiline parameters and nested defaults", async () => {
    writeFileSync(join(root, "api.py"), `from fastapi import FastAPI
app = FastAPI()
@app.post("/orders")
async def create(
    order: OrderCreate,
    user = Depends(get_current_user),
) -> dict[str, str]:
    return order_service.create(order)
`);
    const slices = await new FastApiSemanticExtractor().extractSlices(root);
    expect(slices).toHaveLength(1);
    expect(slices[0].controller_line).toBe(4);
    const chain = JSON.parse(slices[0].execution_chain_json);
    expect(chain.some((s: any) => s.stage === "validation" && s.symbol === "OrderCreate")).toBe(true);
    expect(chain.some((s: any) => s.stage === "guard" && s.symbol === "get_current_user")).toBe(true);
  });

  it("keeps NestJS DTO bindings across nested decorator arguments", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/orders.controller.ts"), `import { Controller, Post, Body, ValidationPipe, Headers, Get } from "@nestjs/common";
@Controller('orders')
export class OrdersController {
  @Post()
  create(
    @Body(new ValidationPipe({ transform: true })) dto: CreateOrderDto,
    @Headers('x-label)') label: string,
  ) { return this.service.create(dto); }
  @Get()
  list() { return []; }
}`);
    const slices = await new NestJsSemanticExtractor().extractSlices(root);
    expect(slices).toHaveLength(2);
    const create = slices.find(s => s.action_name === "create")!;
    expect(create.controller_line).toBe(5);
    expect(JSON.parse(create.execution_chain_json).some((s: any) => s.stage === "validation" && s.symbol === "CreateOrderDto")).toBe(true);
  });

  for (const [base, actions] of [
    ["viewsets.ReadOnlyModelViewSet", ["list", "retrieve"]],
    ["viewsets.ViewSet", []],
    ["mixins.ListModelMixin, viewsets.GenericViewSet", ["list"]],
  ] as const) {
    it(`does not invent CRUD actions for ${base}`, async () => {
      writeFileSync(join(root, "views.py"), `class OrderViewSet(${base}):\n    serializer_class = OrderSerializer\n    queryset = Order.objects.all()\n`);
      writeFileSync(join(root, "urls.py"), `from rest_framework.routers import SimpleRouter
from views import OrderViewSet
router = SimpleRouter()
router.register("orders", OrderViewSet, basename="order")
urlpatterns = router.urls
`);
      const slices = await new DjangoSemanticExtractor().extractSlices(root);
      expect(slices.map(s => s.action_name)).toEqual([...actions]);
      expect(slices.some(s => s.http_method === "POST")).toBe(false);
      for (const slice of slices) {
        expect(JSON.parse(slice.execution_chain_json).find((s: any) => s.stage === "controller").description).toContain("Inherited");
      }
    });
  }
});
