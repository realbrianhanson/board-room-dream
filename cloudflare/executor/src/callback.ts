// Batch 17 — Worker → orchestrator result callback (spec §6.5 / §10.6).
// Pure builder + a fetch-injected POST; no cloudflare:* imports.
import type { CallOutput, DispatchRequest, ExecutorResultCallback } from "./protocol.ts";
import { signExecutorRequest } from "./auth.ts";

export function buildResultCallback(p: DispatchRequest, output: CallOutput, version: string): ExecutorResultCallback {
  return {
    action: "executor_result",
    call_id: p.call_id,
    step_id: p.labels.step_id,
    run_id: p.labels.run_id,
    output,
    executor_version: version,
  };
}

/**
 * POST the signed result to `callbackUrl`. The signed path is
 * `new URL(callbackUrl).pathname` — the orchestrator verifies against its
 * EXECUTOR_CALLBACK_PATH constant, never req.url (§5.3). A network failure
 * throws so the Workflow step retries; an HTTP answer is returned as-is and
 * the Workflow decides (2xx done, 4xx stop, 5xx retry).
 */
export async function postResult(
  fetchImpl: typeof fetch,
  secret: string,
  callbackUrl: string,
  body: ExecutorResultCallback,
): Promise<{ ok: boolean; status: number }> {
  const path = new URL(callbackUrl).pathname;
  const raw = JSON.stringify(body);
  const headers = await signExecutorRequest(secret, "POST", path, raw);
  const r = await fetchImpl(callbackUrl, { method: "POST", headers, body: raw });
  return { ok: r.ok, status: r.status };
}
