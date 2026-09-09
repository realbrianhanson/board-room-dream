// Batch 17 — boardroom-executor Worker entry (spec §10). `fetch` routes the
// signed HTTP surface; the Workflow class is re-exported for the
// `workflows[].class_name` binding in wrangler.jsonc.
import { handleRequest } from "./handler.ts";
import { MAX_DISPATCH_BYTES } from "./protocol.ts";
import { EXECUTOR_MAX_TIMEOUT_MS } from "./openrouter.ts";
import { SeatCallWorkflow, type Env } from "./workflow.ts";

export { SeatCallWorkflow };
export type { Env };

function numberOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

function splitHosts(v: string | undefined): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(req, {
        secret: env.EXECUTOR_SECRET ?? "",
        wf: env.EXECUTOR_WF,
        now: () => Date.now(),
        version: env.EXECUTOR_VERSION || "batch17",
        allowedCallbackHosts: splitHosts(env.ALLOWED_CALLBACK_HOSTS),
        maxDispatchBytes: numberOr(env.MAX_DISPATCH_BYTES, MAX_DISPATCH_BYTES),
        maxTimeoutMs: numberOr(env.EXECUTOR_MAX_TIMEOUT_MS, EXECUTOR_MAX_TIMEOUT_MS),
      });
    } catch (e) {
      // The catch wraps the pre-auth body read and the signature check too,
      // so the response body is fixed: internal error text is logged, never
      // returned to a caller that may not be authenticated.
      console.error(`[executor] unhandled: ${String((e as any)?.message ?? e)}`);
      return new Response(JSON.stringify({ error: "internal" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
