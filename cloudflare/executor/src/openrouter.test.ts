// Batch 17 — the streaming call, driven with a fake fetch and real (short)
// timers. Nothing here touches the network.
import { describe, expect, it } from "vitest";
import {
  accumulateSse,
  buildUpstreamInit,
  callOpenRouterOnce,
  clampTimeout,
  classifyFailure,
  finishSse,
  initialSseState,
  OPENROUTER_CHAT_URL,
} from "./openrouter.ts";
import { EXECUTOR_FIXTURES, SSE_KEEPALIVE_PREFIX } from "./protocol.ts";

const BODY = EXECUTOR_FIXTURES.dispatch.openrouter.body;
const HEADERS = EXECUTOR_FIXTURES.dispatch.openrouter.headers;
const MODEL = BODY.model as string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake fetch answering with an SSE stream; `plan` is called with the stream controller and the request signal. */
function sseFetch(
  plan: (send: (s: string) => void, close: () => void, signal: AbortSignal) => void | Promise<void>,
  init?: { status?: number; contentType?: string },
) {
  const seen: { url?: string; init?: RequestInit } = {};
  const fetchImpl = (async (url: any, reqInit?: RequestInit) => {
    seen.url = String(url);
    seen.init = reqInit;
    const enc = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (s: string) => {
          if (!closed) ctrl.enqueue(enc.encode(s));
        };
        const close = () => {
          if (!closed) {
            closed = true;
            ctrl.close();
          }
        };
        void plan(send, close, reqInit!.signal!);
      },
    });
    return new Response(stream, {
      status: init?.status ?? 200,
      headers: { "content-type": init?.contentType ?? "text/event-stream" },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content: string, extra: Record<string, unknown> = {}) =>
  chunk({ id: "gen-1", model: MODEL, provider: "Anthropic", choices: [{ index: 0, delta: { role: "assistant", content } }], ...extra });
const final = (usage: unknown, finish = "stop") =>
  chunk({ id: "gen-1", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finish, native_finish_reason: "end_turn" }], usage });
const USAGE = { prompt_tokens: 21_740, completion_tokens: 6_120, cost: 0.4183, completion_tokens_details: { reasoning_tokens: 4_200 } };

const opts = (over: Partial<Parameters<typeof callOpenRouterOnce>[1]> = {}) => ({
  apiKey: "sk-or-test",
  body: BODY,
  headers: HEADERS,
  transport: "sse" as const,
  timeoutMs: 5_000,
  idleMs: 5_000,
  ...over,
});

describe("clampTimeout", () => {
  it("min(max, max(30 s, ms ?? 360 s)); a non-finite max falls back to 900 s", () => {
    expect(clampTimeout(undefined)).toBe(360_000);
    expect(clampTimeout(1_000)).toBe(30_000);
    expect(clampTimeout(720_000)).toBe(720_000);
    expect(clampTimeout(2_000_000)).toBe(900_000);
    expect(clampTimeout(720_000, 600_000)).toBe(600_000);
    expect(clampTimeout(NaN)).toBe(360_000);
    expect(clampTimeout(720_000, NaN)).toBe(720_000);
  });
});

describe("buildUpstreamInit", () => {
  it("sse adds only stream:true; every other field is byte-identical; json sends the body untouched", () => {
    const init = buildUpstreamInit("k", BODY, HEADERS, "sse", new AbortController().signal);
    const sent = JSON.parse(String(init.body));
    expect(sent.stream).toBe(true);
    delete sent.stream;
    expect(JSON.stringify(sent)).toBe(JSON.stringify(BODY));
    const json = buildUpstreamInit("k", BODY, HEADERS, "json", new AbortController().signal);
    expect(String(json.body)).toBe(JSON.stringify(BODY));
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer k");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["HTTP-Referer"]).toBe(HEADERS["HTTP-Referer"]);
    expect(h["X-Title"]).toBe(HEADERS["X-Title"]);
  });

  it("a dispatch header cannot override Authorization or Content-Type, in any letter case", () => {
    const init = buildUpstreamInit("k", BODY, { Authorization: "Bearer evil" }, "sse", new AbortController().signal);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const lower = buildUpstreamInit(
      "k",
      BODY,
      { authorization: "Bearer evil", "content-type": "text/plain", "X-Title": "kept" },
      "sse",
      new AbortController().signal,
    );
    const h = new Headers(lower.headers as Record<string, string>);   // what fetch would send: merged case-insensitively
    expect(h.get("authorization")).toBe("Bearer k");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("x-title")).toBe("kept");
  });
});

describe("accumulateSse / finishSse", () => {
  it("buffers lines split mid-chunk, ignores comments (but counts their bytes), stops at [DONE], last usage wins", () => {
    let s = initialSseState(MODEL);
    const wire = `${SSE_KEEPALIVE_PREFIX}\n\n` + delta("Hel") + delta("lo") + final(USAGE);
    const cut = wire.indexOf('"content":"lo') + 5;   // split inside a data line
    s = accumulateSse(s, wire.slice(0, cut));
    expect(s.content).toBe("Hel");
    s = accumulateSse(s, wire.slice(cut));
    expect(s.content).toBe("Hello");
    expect(s.done).toBe(false);
    s = accumulateSse(s, "data: [DONE]\n\n");
    expect(s.done).toBe(true);
    expect(s.bytes).toBe(wire.length + "data: [DONE]\n\n".length);
    const fin = finishSse(s);
    expect("response" in fin).toBe(true);
    const r = (fin as { response: any }).response;
    expect(r.choices[0].message).toEqual({ role: "assistant", content: "Hello" });
    expect(r.choices[0].finish_reason).toBe("stop");
    expect(r.choices[0].native_finish_reason).toBe("end_turn");
    expect(r.usage.cost).toBe(0.4183);
    expect(r.usage.completion_tokens_details.reasoning_tokens).toBe(4_200);
    expect(r.model).toBe(MODEL);
    expect(r.id).toBe("gen-1");
    expect(r.provider).toBe("Anthropic");
  });

  it("a mid-stream top-level error event → upstream_status with the code", () => {
    let s = initialSseState(MODEL);
    s = accumulateSse(s, delta("partial") + chunk({ error: { code: 429, message: "Rate limited" } }) + "data: [DONE]\n\n");
    const fin = finishSse(s);
    expect(fin).toEqual({ error: { kind: "upstream_status", status: 429, message: "Rate limited", model: MODEL } });
  });

  it("OpenRouter's error event carrying BOTH a top-level error and choices[0].finish_reason \"error\" → upstream_status, never a truncated answer", () => {
    let s = initialSseState(MODEL);
    s = accumulateSse(
      s,
      delta("par") +
        chunk({ id: "gen-1", model: MODEL, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error", native_finish_reason: "error" }], error: { code: 503, message: "Provider overloaded" } }) +
        "data: [DONE]\n\n",
    );
    expect(finishSse(s)).toEqual({ error: { kind: "upstream_status", status: 503, message: "Provider overloaded", model: MODEL } });
  });

  it("finish_reason \"error\" with no error object is still an error (never ok with partial content)", () => {
    let s = initialSseState(MODEL);
    s = accumulateSse(s, delta("par") + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "error", native_finish_reason: "overloaded_error" }] }));
    const fin = finishSse(s);
    expect("error" in fin).toBe(true);
    expect((fin as any).error).toMatchObject({ kind: "upstream_status", message: "finish_reason error (overloaded_error)", model: MODEL });
    expect((fin as any).error.status).toBeUndefined();
  });

  it("a truncated stream (no finish_reason, no usage) → body_transport", () => {
    const s = accumulateSse(initialSseState(MODEL), delta("half"));
    const fin = finishSse(s);
    expect((fin as any).error.kind).toBe("body_transport");
    expect((fin as any).error.model).toBe(MODEL);
  });

  it("an unterminated last line is flushed by finishSse", () => {
    const s = accumulateSse(initialSseState(MODEL), delta("x") + final(USAGE).trimEnd());
    const fin = finishSse(s) as { response: any };
    expect(fin.response.usage).toEqual(USAGE);
    expect(fin.response.choices[0].finish_reason).toBe("stop");
  });
});

describe("classifyFailure", () => {
  it("abort marks, pre-response, non-2xx and body phases", () => {
    expect(classifyFailure({ abortKind: "timeout", abortMs: 720_000 }, "body", undefined, MODEL)).toEqual({
      kind: "timeout",
      message: `OpenRouter call to ${MODEL} timed out after 720000ms`,
      model: MODEL,
      ms: 720_000,
    });
    expect(classifyFailure({ abortKind: "idle", abortMs: 90_000 }, "body", undefined, MODEL).kind).toBe("idle");
    expect(classifyFailure(new TypeError("fetch failed"), "pre_response", undefined, MODEL)).toEqual({
      kind: "pre_response",
      message: "fetch failed",
      model: MODEL,
    });
    expect(classifyFailure(new Error("Rate limited"), "headers", 429, MODEL)).toEqual({
      kind: "upstream_status",
      status: 429,
      message: "Rate limited",
      model: MODEL,
    });
    expect(classifyFailure(new Error("terminated"), "body", undefined, MODEL).kind).toBe("body_transport");
    const ab = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyFailure(ab, "body", undefined, MODEL).kind).toBe("timeout");
  });
});

describe("callOpenRouterOnce (sse)", () => {
  it("streams a full completion into the non-streaming shape with usage, finish_reason, ttft and latency", async () => {
    const { seen, fetchImpl } = sseFetch(async (send, close) => {
      send(`${SSE_KEEPALIVE_PREFIX}\n\n`);
      await sleep(5);
      send(delta('{"plan"'));
      send(delta(':"ok"}'));
      send(final(USAGE));
      send("data: [DONE]\n\n");
      close();
    });
    const out = await callOpenRouterOnce(fetchImpl, opts(), "batch17");
    expect(seen.url).toBe(OPENROUTER_CHAT_URL);
    expect(JSON.parse(String(seen.init?.body)).stream).toBe(true);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.response.choices[0].message.content).toBe('{"plan":"ok"}');
    expect(out.response.choices[0].finish_reason).toBe("stop");
    expect(out.response.usage).toEqual(USAGE);
    expect(out.model).toBe(MODEL);
    expect(out.streamed).toBe(true);
    expect(out.executor_version).toBe("batch17");
    expect(typeof out.ttft_ms).toBe("number");
    expect(out.latency_ms).toBeGreaterThanOrEqual(out.ttft_ms as number);
  });

  it("total timer fires → timeout with ms (stalled stream)", async () => {
    const { fetchImpl } = sseFetch(async (send) => {
      send(`${SSE_KEEPALIVE_PREFIX}\n\n`);
      // never closes
    });
    const out = await callOpenRouterOnce(fetchImpl, opts({ timeoutMs: 60, idleMs: 5_000 }), "v");
    expect(out).toEqual({ ok: false, error: { kind: "timeout", message: `OpenRouter call to ${MODEL} timed out after 60ms`, model: MODEL, ms: 60 } });
  });

  it("idle timer fires on a stalled body → idle; keepalive comments reset it", async () => {
    const stalled = sseFetch(async (send) => {
      send(delta("a"));
      // silence
    });
    const out = await callOpenRouterOnce(stalled.fetchImpl, opts({ timeoutMs: 5_000, idleMs: 60 }), "v");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe("idle");
    expect(out.error.ms).toBe(60);

    // Six keepalives 50 ms apart (300 ms of silence in total) against a 300 ms idle window:
    // each gap is well inside the window, the whole wait is not.
    const kept = sseFetch(async (send, close) => {
      for (let i = 0; i < 6; i++) {
        await sleep(50);
        send(`${SSE_KEEPALIVE_PREFIX}\n\n`);
      }
      send(delta("late"));
      send(final(USAGE));
      send("data: [DONE]\n\n");
      close();
    });
    const ok = await callOpenRouterOnce(kept.fetchImpl, opts({ timeoutMs: 5_000, idleMs: 300 }), "v");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.response.choices[0].message.content).toBe("late");
  });

  it("the idle timer is not armed before the response headers: a slow time-to-headers is not idle", async () => {
    const slowHeaders = (async (url: any, init?: RequestInit) => {
      await sleep(150);
      const { fetchImpl } = sseFetch(async (send, close) => {
        send(delta("ok"));
        send(final(USAGE));
        send("data: [DONE]\n\n");
        close();
      });
      return fetchImpl(url, init);
    }) as typeof fetch;
    const out = await callOpenRouterOnce(slowHeaders, opts({ timeoutMs: 5_000, idleMs: 60 }), "v");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.response.choices[0].message.content).toBe("ok");
  });

  it("returns as soon as [DONE] is seen even if the socket lingers open", async () => {
    const { fetchImpl } = sseFetch(async (send) => {
      send(delta("done"));
      send(final(USAGE));
      send("data: [DONE]\n\n");
      // never closes
    });
    const t0 = Date.now();
    const out = await callOpenRouterOnce(fetchImpl, opts({ timeoutMs: 5_000, idleMs: 5_000 }), "v");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.response.choices[0].message.content).toBe("done");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("mid-stream error event → upstream_status; truncated stream → body_transport", async () => {
    const err = sseFetch(async (send, close) => {
      send(delta("x"));
      send(chunk({ error: { code: 503, message: "Provider overloaded" } }));
      close();
    });
    const a = await callOpenRouterOnce(err.fetchImpl, opts(), "v");
    expect(a).toEqual({ ok: false, error: { kind: "upstream_status", status: 503, message: "Provider overloaded", model: MODEL } });

    const both = sseFetch(async (send, close) => {
      send(delta("par"));
      send(chunk({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }], error: { code: 503, message: "Provider overloaded" } }));
      send("data: [DONE]\n\n");
      close();
    });
    const c = await callOpenRouterOnce(both.fetchImpl, opts(), "v");
    expect(c).toEqual({ ok: false, error: { kind: "upstream_status", status: 503, message: "Provider overloaded", model: MODEL } });

    const cut = sseFetch(async (send, close) => {
      send(delta("half"));
      close();
    });
    const b = await callOpenRouterOnce(cut.fetchImpl, opts(), "v");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.kind).toBe("body_transport");
  });

  it("body stream that errors after 2xx → body_transport", async () => {
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(delta("a")));
          ctrl.error(new Error("socket hang up"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const out = await callOpenRouterOnce(fetchImpl, opts(), "v");
    expect(out).toEqual({ ok: false, error: { kind: "body_transport", message: "socket hang up", model: MODEL } });
  });

  it("non-2xx → upstream_status with status and body text; pre-response TypeError → pre_response", async () => {
    const r429 = (async () => new Response('{"error":{"message":"Rate limited"}}', { status: 429 })) as typeof fetch;
    expect(await callOpenRouterOnce(r429, opts(), "v")).toEqual({
      ok: false,
      error: { kind: "upstream_status", status: 429, message: '{"error":{"message":"Rate limited"}}', model: MODEL },
    });
    const r503 = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
    const b = await callOpenRouterOnce(r503, opts(), "v");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toMatchObject({ kind: "upstream_status", status: 503 });
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await callOpenRouterOnce(dead, opts(), "v")).toEqual({
      ok: false,
      error: { kind: "pre_response", message: "fetch failed", model: MODEL },
    });
  });

  it("an empty non-2xx body names the status; a bare AbortError carries the total budget as ms", async () => {
    const empty = (async () => new Response("", { status: 503 })) as typeof fetch;
    expect(await callOpenRouterOnce(empty, opts(), "v")).toEqual({
      ok: false,
      error: { kind: "upstream_status", status: 503, message: "HTTP 503", model: MODEL },
    });
    const aborted = (async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }) as typeof fetch;
    const out = await callOpenRouterOnce(aborted, opts({ timeoutMs: 720_000 }), "v");
    expect(out).toEqual({ ok: false, error: { kind: "timeout", message: "The operation was aborted", model: MODEL, ms: 720_000 } });
  });

  it("a non-SSE JSON body on a stream request is parsed like a direct response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(EXECUTOR_FIXTURES.okOutput.response), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const out = await callOpenRouterOnce(fetchImpl, opts(), "v");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.response).toEqual(EXECUTOR_FIXTURES.okOutput.response);
    expect(out.streamed).toBe(false);
    expect(out.ttft_ms).toBeNull();
  });
});

describe("callOpenRouterOnce (json)", () => {
  it("awaits r.json() exactly as the proxy does; the body has no stream field", async () => {
    let sent: any;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(EXECUTOR_FIXTURES.okOutput.response), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const out = await callOpenRouterOnce(fetchImpl, opts({ transport: "json" }), "batch17");
    expect(sent.stream).toBeUndefined();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response).toEqual(EXECUTOR_FIXTURES.okOutput.response);
      expect(out.streamed).toBe(false);
      expect(out.model).toBe(MODEL);
    }
  });

  it("json transport has no idle timer: headers after 150 ms with idleMs 60 still succeeds (only the total timer governs, as in the proxy)", async () => {
    const fetchImpl = (async () => {
      await sleep(150);
      return new Response(JSON.stringify(EXECUTOR_FIXTURES.okOutput.response), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const out = await callOpenRouterOnce(fetchImpl, opts({ transport: "json", idleMs: 60, timeoutMs: 5_000 }), "v");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.response).toEqual(EXECUTOR_FIXTURES.okOutput.response);
    // …and the total timer still does.
    const slow = (async () => {
      await sleep(300);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const t = await callOpenRouterOnce(slow, opts({ transport: "json", idleMs: 5_000, timeoutMs: 60 }), "v");
    expect(t).toEqual({ ok: false, error: { kind: "timeout", message: `OpenRouter call to ${MODEL} timed out after 60ms`, model: MODEL, ms: 60 } });
  });

  it("a 2xx body that is not JSON → body_transport (never recorded as usage)", async () => {
    const fetchImpl = (async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    const out = await callOpenRouterOnce(fetchImpl, opts({ transport: "json" }), "v");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("body_transport");
  });
});
