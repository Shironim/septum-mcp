import { describe, expect, it } from "bun:test";
import { parseWithTreeSitter } from "../../src/core/parser/wasm-loader.ts";
import { readPythonStaticString } from "../../src/core/parser/static-string.ts";

describe("Python static string values for semantic extraction", () => {
  for (const [source, expected] of [
    ['"/orders"', "/orders"],
    ['r"/orders/\\d+"', "/orders/\\d+"],
    ['u"/caf\\u00e9"', "/café"],
    ['"/\\U0001f600"', "/😀"],
    ['"/\\157rders"', "/orders"],
    ['"/sta" "tic"', "/static"],
    ['("/sta" # comment\n "tic")', "/static"],
    ['"/one\\\ntwo"', "/onetwo"],
    ['"""/multi\nline"""', "/multi\nline"],
    ['"/unknown\\d"', "/unknown\\d"],
    ['f"/orders/{kind}"', undefined],
    ['f"/constant"', undefined],
    ['b"/bytes"', undefined],
    ['"/static" f"/{kind}"', undefined],
    ['"/\\N{LATIN SMALL LETTER A}"', undefined],
    ['prefix + "/orders"', undefined],
  ] as const) {
    it(`decodes or refuses ${source}`, async () => {
      const result = await parseWithTreeSitter("python", source, root => {
        let value = root.firstNamedChild?.firstNamedChild;
        if (value?.type === "parenthesized_expression") value = value.firstNamedChild;
        return { value: readPythonStaticString(value) };
      });
      expect(result).not.toBeNull();
      expect(result!.value).toBe(expected);
    });
  }
});
