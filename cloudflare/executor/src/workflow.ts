// Batch 17 — the Workflow that makes one OpenRouter call (spec §10.4).
// The ONLY file importing the Cloudflare runtime modules; everything it
// calls is pure and unit-tested under Node. It is covered by the Worker's
// tsc typecheck, not vitest.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows"; // lives in cloudflare:workflows, not cloudflare:workers
import type { CallOutput, DispatchRequest } from "./protocol.ts";
import { openSealedKey } from "./auth.ts";
import { callOpenRouterOnce, clampTimeout } from "./openrouter.ts";
import { buildResultCallback, postResult } from "./callback.ts";

export type Env = {
  /** Dashboard secret; shared with the orchestrator (EXECUTOR_SECRET in Lovable Cloud). */
  EXECUTOR_SECRET: string;
  EXECUTOR_VERSION: string;
  /** Comma-separated hostnames a dispatch may name in callback_url. */
  ALLOWED_CALLBACK_HOSTS: string;
  MAX_DISPATCH_BYTES: string;
  EXECUTOR_MAX_TIMEOUT_MS: string;
  EXECUTOR_WF: Workflow<DispatchRequest>;
};

export class SeatCallWorkflow extends WorkflowEntrypoint<Env, DispatchRequest> {
  async run(event: WorkflowEvent<DispatchRequest>, step: WorkflowStep): Promise<CallOutput> {
    const p = event.payload;
    const timeoutMs = clampTimeout(p.timeout_ms, Number(this.env.EXECUTOR_MAX_TIMEOUT_MS));
    // retries.limit 0 is load-bearing: a thrown step must never re-buy the
    // call. callOpenRouterOnce never throws for an upstream condition, so the
    // instance completes with a classified error instead. The explicit step
    // timeout (clamped + 60 s) replaces the platform default so the
    // in-closure abort always fires first and yields `timeout`, not a step
    // failure.
    const output = await step.do(
      "openrouter",
      { retries: { limit: 0, delay: "10 seconds", backoff: "exponential" }, timeout: `${Math.ceil((timeoutMs + 60_000) / 1000)} seconds` },
      async () => {
        const apiKey = await openSealedKey(this.env.EXECUTOR_SECRET, p.call_id, p.openrouter.key_sealed); // key lives only in this closure
        return await callOpenRouterOnce(
          fetch,
          {
            apiKey,
            body: p.openrouter.body,
            headers: p.openrouter.headers,
            transport: p.transport,
            timeoutMs,
            idleMs: p.idle_ms,
          },
          this.env.EXECUTOR_VERSION,
        );
      },
    );
    try {
      await step.do(
        "callback",
        { retries: { limit: 8, delay: "10 seconds", backoff: "exponential" }, timeout: "60 seconds" },
        async () => {
          const r = await postResult(
            fetch,
            this.env.EXECUTOR_SECRET,
            p.callback_url,
            buildResultCallback(p, output, this.env.EXECUTOR_VERSION),
          );
          if (r.ok) return;
          if (r.status >= 400 && r.status < 500) throw new NonRetryableError(`callback rejected ${r.status}`);
          throw new Error(`callback ${r.status}`);
        },
      );
    } catch {
      // A callback failure never fails the instance: the orchestrator's
      // collector reads this instance's output on its next tick.
    }
    return output;
  }
}
