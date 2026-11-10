import { describe, expect, it } from "bun:test";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";

describe("AST dependency and declaration integrity across languages", () => {
  const parser = new ASTParserEngine();

  it("finds Python imports in conditional and function scopes without reading decoys", async () => {
    const result = await parser.parseFile("app.py", `if TYPE_CHECKING:
    from .models import (
        Order as Purchase,
    )
def load():
    try:
        from .service import checkout
    except ImportError:
        import fallback as backend
    text = 'import poison'
# import ignored
`);
    expect(result.status).toBe("parsed");
    expect(result.dependencies.map(d => d.target)).toEqual([".models", ".service", "fallback"]);
    expect(result.dependencies[0].imported_symbols).toEqual(["Order", "Purchase"]);
    expect(result.dependencies[0].statement).toContain("Order as Purchase");
    expect(result.symbols.some(s => s.name.includes("text"))).toBe(false);
  });

  it("retains C# namespace identity, aliases and nested enums", async () => {
    const result = await parser.parseFile("Orders.cs", `using Purchase = App.Models.Order;
namespace Sales { public class Order { public enum State { New } public void Save() {} } }
namespace Shipping { public class Order { public void Save() {} } }`);
    expect(result.status).toBe("parsed");
    expect(result.symbols.map(s => s.name)).toEqual([
      "Sales.Order", "Sales.Order.State", "Sales.Order.Save", "Shipping.Order", "Shipping.Order.Save",
    ]);
    expect(result.dependencies[0].target).toBe("App.Models.Order");
    expect(result.dependencies[0].imported_symbols).toContain("Purchase");
    const fileScoped = await parser.parseFile("File.cs", "namespace Sales;\nclass Order { void Save() {} }");
    expect(fileScoped.symbols.map(s => s.name)).toEqual(["Sales.Order", "Sales.Order.Save"]);
  });

  it("preserves Java wildcard imports and nested records", async () => {
    const result = await parser.parseFile("Orders.java", `import java.util.*;
import static java.util.Collections.*;
class Orders { record Item(int id) {} }`);
    expect(result.status).toBe("parsed");
    expect(result.dependencies.map(d => [d.target, d.imported_symbols])).toEqual([
      ["java.util.*", ["*"]], ["java.util.Collections.*", ["*"]],
    ]);
    expect(result.symbols.some(s => s.name === "Orders.Item")).toBe(true);
  });

  it("uses Ruby literal argument nodes and marks interpolated or computed requires dynamic", async () => {
    const result = await parser.parseFile("order.rb", `require_relative("./order")
require 'json'
require "app/#{name}"
require path
other.require 'ignored'
# require 'comment'
`);
    expect(result.status).toBe("parsed");
    expect(result.dependencies.map(d => d.target)).toEqual([
      "./order", "json", 'dynamic:require "app/#{name}"', "dynamic:require path",
    ]);
    expect(result.dependencies[0].imported_symbols).toEqual(["order"]);
    expect(result.dependencies[2].is_external).toBe(false);
  });

  it("extracts PHP promoted properties only from constructor promotion parameters", async () => {
    const result = await parser.parseFile("Order.php", `<?php
namespace Sales;
class Order {
  public function __construct(
    private readonly Service $svc,
    public int $count = 0,
    string $label = ''
  ) {}
  public function run(int $value) {}
}`);
    expect(result.status).toBe("parsed");
    expect(result.symbols.filter(s => s.kind === "property").map(s => [s.name, s.visibility])).toEqual([
      ["Sales\\Order::$svc", "private"], ["Sales\\Order::$count", "public"],
    ]);
    expect(result.symbols.find(s => s.name.endsWith("::$svc"))?.signature).toContain("readonly Service $svc");
  });

  it("flattens Rust grouped use trees while retaining aliases, self and wildcards", async () => {
    const result = await parser.parseFile("lib.rs", `use crate::orders::{
    // Import decoy: Poison
    self, Order, nested::{Repo as Storage, Item}, *
};`);
    expect(result.status).toBe("parsed");
    expect(result.dependencies.map(d => [d.target, d.imported_symbols])).toEqual([
      ["crate::orders", ["orders"]], ["crate::orders::Order", ["Order"]],
      ["crate::orders::nested::Repo", ["Repo", "Storage"]],
      ["crate::orders::nested::Item", ["Item"]], ["crate::orders::*", ["*"]],
    ]);
    expect(result.dependencies.every(d => !d.is_external)).toBe(true);
    expect(result.dependencies[0].statement).toContain("Repo as Storage");
  });

  it("qualifies TypeScript namespace members and keeps top-level declarations distinct", async () => {
    const result = await parser.parseFile("orders.ts", `export namespace Billing {
  export class Order { save() {} }
  export namespace Nested { export function load() {} }
  export const limit = 10;
}
export class Order { save() {} }
`);
    expect(result.status).toBe("parsed");
    expect(result.symbols.map(s => s.name)).toEqual([
      "Billing::Order", "Billing::Order::save", "Billing::Nested::load", "Billing::limit", "Order", "Order::save",
    ]);
  });
});
