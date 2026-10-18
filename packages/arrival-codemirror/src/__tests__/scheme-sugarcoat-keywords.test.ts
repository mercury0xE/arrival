// DEFINITION_KEYWORDS — the set the sugarcoat StreamLanguage tags t.definitionKeyword (syntax
// highlighting). define/overridable is a define-shaped binding form (bindingsAt in
// arrival-lsp's scheme-service.ts already treats it exactly like `define` for scope
// analysis), so it should highlight the same way, not read as a plain variableName call.
import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";
import { DEFINITION_KEYWORDS, parser } from "../scheme-sugarcoat.js";

function tokens(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const state = parser.startState!(2);
  for (const line of src.split("\n")) {
    const s = new StringStream(line, 2, 2, () => 0);
    while (!s.eol()) {
      s.start = s.pos;
      const tag = parser.token(s, state);
      if (s.pos === s.start) {
        s.pos++;
        continue;
      }
      if (tag) out.push([line.slice(s.start, s.pos), tag]);
    }
  }
  return out;
}

describe("DEFINITION_KEYWORDS", () => {
  it("includes define/overridable alongside the other define-family forms", () => {
    expect(DEFINITION_KEYWORDS.has("define/overridable")).toBe(true);
  });

  it("still includes the existing define-family forms (no regression)", () => {
    for (const kw of [
      "define",
      "define-values",
      "define-syntax",
      "define-macro",
      "defmacro",
      "define-class",
      "define-record-type",
    ]) {
      expect(DEFINITION_KEYWORDS.has(kw)).toBe(true);
    }
  });

  it("tags the defined name as sugarcoatDefName in both (define x 1) and (define (foo x) x)", () => {
    expect(tokens("(define x 1)")).toEqual([
      ["(", "paren"],
      ["define", "sugarcoatSpecial"],
      ["x", "sugarcoatDefName"],
      ["1", "number"],
      [")", "paren"],
    ]);
    expect(tokens("(define (foo x) x)")).toEqual([
      ["(", "paren"],
      ["define", "sugarcoatSpecial"],
      ["(", "paren"],
      ["foo", "sugarcoatDefName"],
      ["x", "variableName"],
      [")", "paren"],
      ["x", "variableName"],
      [")", "paren"],
    ]);
  });
});
