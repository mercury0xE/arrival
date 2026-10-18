import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { harvestPlaneHost } from "../harvest-plane-host.js";

describe("harvestPlaneHost — name-level skip, not scheme/* prefix", () => {
  it("binds authored-type natives PRE does not own, and skips overlay names", () => {
    const skip = new Set(["apply", "append", "map", "join", "list", "car", "cdr", "string-append"]);
    const { entries } = harvestPlaneHost(BASE_ROSTER, skip);
    const names = new Set(entries.map(([n]) => n));
    expect(names.has("apply")).toBe(false);
    expect(names.has("map")).toBe(false);
    expect(names.has("vector->list")).toBe(true);
    expect(names.has("member")).toBe(true);
    expect(names.has("string-split")).toBe(true);
    expect(names.has("string-tokenize")).toBe(true);
    const vec = entries.find(([n]) => n === "vector->list")?.[1];
    expect(vec).toMatch(/List</);
  });

  it("does not harvest names in skipNames even if the pack is scheme/*", () => {
    const { entries } = harvestPlaneHost(BASE_ROSTER, new Set(["vector->list", "member"]));
    const names = new Set(entries.map(([n]) => n));
    expect(names.has("vector->list")).toBe(false);
    expect(names.has("member")).toBe(false);
    expect(names.has("string-split")).toBe(true);
  });

  it("harvests record-shaped inputRest into kwargsMembers and preserves mixed positional + kwargs signatures", () => {
    const cap = EnvCapability.define("test/host-kwargs", {
      symbols: (symbol, z) => ({
        "read-file": symbol.rosetta`read-file: mixed kwargs`(
          { input: [z.string], inputRest: { offset: z.number.optional() }, output: [z.string] },
          (p) => p,
        ),
        "pure-kw": symbol.rosetta`pure-kw: pure kwargs`(
          { input: [], inputRest: { name: z.string }, output: [z.string] },
          (opts) => opts.name,
        ),
        "var-plus": symbol.rosetta`var-plus: variadic rest`(
          { input: [z.number], inputRest: z.number, output: [z.number] },
          (a) => a,
        ),
      }),
    });
    const { entries, kwargsMembers } = harvestPlaneHost([cap], new Set());
    expect(kwargsMembers).toEqual(["pure-kw", "read-file"]);
    const byName = new Map(entries);
    expect(byName.get("read-file")).toBe("(a: string, b?: { offset?: number }) => string");
    expect(byName.get("pure-kw")).toBe("(a: { name: string }) => string");
  });
});


