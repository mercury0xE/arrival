/**
 * RunContext teardown — disposal half of docs/execution.md §HERMETIC's per-run identity
 * (RunContext mints; this module owns what happens when it ends).
 *
 * A RunContext is minted once per `exec()` by default, but a REPL-style caller may hand
 * the SAME RunContext to N successive passes (`ExecOptions.runCtx`). Anything scoped to
 * that RunContext (capability resources) must survive across those passes and tear down
 * exactly once, at the SESSION's end — never per pass, never twice.
 *
 * Two teardown paths:
 *   EXPLICIT — caller calls {@link disposeRunContext}, or `await using` a RunContext
 *     (`[Symbol.asyncDispose]` delegates here).
 *   BACKSTOP — a RunContext dropped without either is torn down via FinalizationRegistry
 *     once unreachable. Best-effort by spec; bounds leakage, does not replace explicit.
 *
 * Both funnel through one idempotency guard (`disposed`).
 */

import type { RunContext } from "./RunContext.js";

type Teardown = () => Promise<void>;

/** One RunContext's teardowns + double-run guard. Held OFF the RunContext (WeakMap
 *  side-table) so a plain RunContext carries no lifecycle plumbing until a resource
 *  actually accrues. */
interface RunLifecycle {
  teardowns: Teardown[];
  disposed: boolean;
  disposeRequested: boolean;
  inFlight: number;
  backstopArmed: boolean;
}

const lifecycles = new WeakMap<RunContext, RunLifecycle>();

/** GC backstop. Held value is the RunLifecycle (not the RunContext — FinalizationRegistry
 *  contract: target may already be gone). `unregister` uses RunContext as token (caller of
 *  dispose still holds a live reference). */
const backstop = new FinalizationRegistry<RunLifecycle>((lifecycle) => {
  if (lifecycle.disposed) return;
  lifecycle.disposed = true;
  const pending = lifecycle.teardowns;
  lifecycle.teardowns = [];
  // Detached — nothing awaits a GC callback; swallow unhandled rejections.
  void Promise.allSettled(pending.map((fn) => fn()));
});

function lifecycleOf(runCtx: RunContext): RunLifecycle {
  let lifecycle = lifecycles.get(runCtx);
  if (lifecycle === undefined) {
    lifecycle = {
      teardowns: [],
      disposed: false,
      disposeRequested: false,
      inFlight: 0,
      backstopArmed: false,
    };
    lifecycles.set(runCtx, lifecycle);
  }
  return lifecycle;
}

async function runTeardowns(runCtx: RunContext, lifecycle: RunLifecycle): Promise<void> {
  if (lifecycle.disposed) return;
  lifecycle.disposed = true;
  if (lifecycle.backstopArmed) {
    lifecycle.backstopArmed = false;
    backstop.unregister(runCtx);
  }
  const pending = lifecycle.teardowns;
  lifecycle.teardowns = [];
  if (pending.length > 0) {
    await Promise.allSettled(pending.map((fn) => fn()));
  }
}

/** Register `teardown` to run once at `runCtx` disposal (explicit or backstop). Called on
 *  a resource's FIRST touch under a given RunContext. Already-disposed run accepts no
 *  further teardowns (silent) — nothing should still spawn resources against a ended session.
 *  When `disposeRequested && !disposed` (an in-flight host call is draining), the teardown
 *  is still registered so it runs as soon as `inFlight` reaches 0. */
export function onRunContextDispose(runCtx: RunContext, teardown: Teardown): void {
  const lifecycle = lifecycleOf(runCtx);
  if (lifecycle.disposed) return;
  if (!lifecycle.backstopArmed) {
    lifecycle.backstopArmed = true;
    backstop.register(runCtx, lifecycle, runCtx);
  }
  lifecycle.teardowns.push(teardown);
}

/** Increment the in-flight host operation count for `runCtx` so a concurrent
 *  {@link disposeRunContext} defers physical teardown until {@link releaseRunContext}. */
export function retainRunContext(runCtx: RunContext): void {
  const lifecycle = lifecycleOf(runCtx);
  if (lifecycle.disposed) return;
  lifecycle.inFlight += 1;
}

/** Decrement the in-flight host operation count for `runCtx`. If disposal was requested
 *  while this operation was in flight and `inFlight` reaches 0, execute teardowns now. */
export async function releaseRunContext(runCtx: RunContext): Promise<void> {
  const lifecycle = lifecycles.get(runCtx);
  if (lifecycle === undefined) return;
  if (lifecycle.inFlight > 0) {
    lifecycle.inFlight -= 1;
  }
  if (lifecycle.inFlight === 0 && lifecycle.disposeRequested && !lifecycle.disposed) {
    await runTeardowns(runCtx, lifecycle);
  }
}

/** Tear `runCtx` down: run every accumulated teardown (parallel, best-effort —
 *  capability resources are independent; no cross-capability order). Idempotent.
 *  ONE function every teardown path funnels through: exec's owned-runCtx finally,
 *  REPL session close, and `[Symbol.asyncDispose]`. */
export async function disposeRunContext(runCtx: RunContext): Promise<void> {
  const lifecycle = lifecycleOf(runCtx);
  if (lifecycle.disposed) return;
  lifecycle.disposeRequested = true;
  if (lifecycle.inFlight > 0) return;
  await runTeardowns(runCtx, lifecycle);
}
