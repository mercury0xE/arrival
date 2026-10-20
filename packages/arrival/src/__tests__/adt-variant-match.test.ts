/**
 * Structural ADTs (`define-variant` + exhaustive `match`) — runtime evaluation,
 * keyword-tagged `ADict` construction, predicate guards, membrane egress,
 * exhaustiveness door, and provenance propagation.
 */
import { describe, expect, it } from "vitest";
import { exec, execState } from "../eval/generator-exec.js";
import { ADict } from "../values/primitives/ADict.js";
import { ASymbol } from "../values/primitives/ASymbol.js";

describe("define-variant & exhaustive match", () => {
  const outcomeDecl = `
    (define-variant (Outcome a)
      (Converged (value a) (rounds integer))
      (Blocked (reason string)))
  `;

  it("constructs an ADict with :kind keyword tag and named fields", async () => {
    const state = await execState(`${outcomeDecl}\n(Converged 42 3)`);
    const val = state.values[state.values.length - 1];
    expect(val).toBeInstanceOf(ADict);
    const dict = val as ADict;
    const kind = dict.get("kind");
    expect(kind).toBeInstanceOf(ASymbol);
    expect((kind as ASymbol).__name__).toBe(":converged");

    const [, jsVal] = await exec(`${outcomeDecl}\n(Converged 42 3)`);
    expect(jsVal).toEqual({ kind: "converged", value: 42, rounds: 3 });
  });

  it("binds variant predicates (Converged? and Blocked?)", async () => {
    const results = await exec(`
      ${outcomeDecl}
      (define c (Converged 42 3))
      (define b (Blocked "timeout"))
      (list (Converged? c) (Blocked? c) (Converged? b) (Blocked? b) (Converged? 99))
    `);
    expect(results[results.length - 1]).toEqual([true, false, false, true, false]);
  });

  it("dispatches exhaustive match and binds field pattern variables", async () => {
    const results = await exec(`
      ${outcomeDecl}
      (define (score out)
        (match out
          ((Converged v r) (+ v r))
          ((Blocked msg) (string-length msg))))
      (list (score (Converged 42 3)) (score (Blocked "halted")))
    `);
    expect(results[results.length - 1]).toEqual([45, 6]);
  });

  it("supports wildcard (_) field patterns and else/_ catch-all clauses", async () => {
    const results = await exec(`
      ${outcomeDecl}
      (define (value-or-zero out)
        (match out
          ((Converged v _) v)
          (else 0)))
      (list (value-or-zero (Converged 99 4)) (value-or-zero (Blocked "nope")))
    `);
    expect(results[results.length - 1]).toEqual([99, 0]);
  });

  it("throws E-MATCH-NON-EXHAUSTIVE naming the missing variant when a clause is omitted", async () => {
    await expect(
      exec(`
        ${outcomeDecl}
        (match (Converged 42 3)
          ((Converged v r) (+ v r)))
      `),
    ).rejects.toThrow(/non-exhaustive match on Outcome: missing variant Blocked/);
  });

  it("throws E-MATCH-ARITY when pattern variable count mismatches variant field count", async () => {
    await expect(
      exec(`
        ${outcomeDecl}
        (match (Converged 42 3)
          ((Converged v) v)
          ((Blocked msg) 0))
      `),
    ).rejects.toThrow(/variant Converged expects 2 field patterns \(value, rounds\), got 1/);
  });
});
