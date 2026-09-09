import { describe, expect, it } from "vitest";
import { buildResultCallback, postResult } from "./callback.ts";
import { verifyExecutorRequest } from "./auth.ts";
import { EXECUTOR_CALLBACK_PATH, EXECUTOR_FIXTURES } from "./protocol.ts";

const P = EXECUTOR_FIXTURES.dispatch;

describe("buildResultCallback", () => {
  it("carries action, call id, the step/run labels, the output and the version — nothing else", () => {
    const cb = buildResultCallback(P, EXECUTOR_FIXTURES.okOutput, "batch17");
    expect(cb).toEqual({
      action: "executor_result",
      call_id: P.call_id,
      step_id: P.labels.step_id,
      run_id: P.labels.run_id,
      output: EXECUTOR_FIXTURES.okOutput,
      executor_version: "batch17",
    });
    expect(JSON.stringify(cb)).not.toContain("key_sealed");
  });
});

describe("postResult", () => {
  function capture(status: number) {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(status === 204 ? null : "{}", { status });
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  it("signs with the callback URL's pathname so the orchestrator's EXECUTOR_CALLBACK_PATH verifies it", async () => {
    const { seen, fetchImpl } = capture(200);
    const cb = buildResultCallback(P, EXECUTOR_FIXTURES.okOutput, "batch17");
    const r = await postResult(fetchImpl, "s3cret", P.callback_url, cb);
    expect(r).toEqual({ ok: true, status: 200 });
    expect(seen.url).toBe(P.callback_url);
    expect(seen.init?.method).toBe("POST");
    const body = String(seen.init?.body);
    expect(JSON.parse(body)).toEqual(cb);
    const headers = new Headers(seen.init?.headers as Record<string, string>);
    expect(headers.get("content-type")).toBe("application/json");
    expect(await verifyExecutorRequest("s3cret", "POST", EXECUTOR_CALLBACK_PATH, headers, body, Date.now())).toEqual({ ok: true });
    // The full URL or the host is never what is signed.
    expect(await verifyExecutorRequest("s3cret", "POST", P.callback_url, headers, body, Date.now())).toEqual({ ok: false, reason: "mismatch" });
  });

  it("maps 2xx → ok, 4xx and 5xx → not ok with the status (the Workflow decides stop vs retry)", async () => {
    const cb = buildResultCallback(P, EXECUTOR_FIXTURES.timeoutOutput, "batch17");
    expect(await postResult(capture(204).fetchImpl, "s", P.callback_url, cb)).toEqual({ ok: true, status: 204 });
    expect(await postResult(capture(401).fetchImpl, "s", P.callback_url, cb)).toEqual({ ok: false, status: 401 });
    expect(await postResult(capture(404).fetchImpl, "s", P.callback_url, cb)).toEqual({ ok: false, status: 404 });
    expect(await postResult(capture(500).fetchImpl, "s", P.callback_url, cb)).toEqual({ ok: false, status: 500 });
  });

  it("a network failure propagates (the step retries)", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(postResult(failing, "s", P.callback_url, buildResultCallback(P, EXECUTOR_FIXTURES.okOutput, "v"))).rejects.toThrow("fetch failed");
  });
});
