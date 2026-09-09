// Batch 17 — the Worker side of the cross-runtime contract: Node's WebCrypto
// must verify what Deno signed and open what Deno sealed. The literals come
// from executor-protocol.ts and were produced by the Deno implementation.
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  canonicalString,
  openSealedKey,
  sealApiKey,
  sha256Hex,
  signExecutorRequest,
  verifyExecutorRequest,
} from "./auth.ts";
import { EXECUTOR_AUTH_VECTOR as V, EXECUTOR_CALLBACK_PATH, EXECUTOR_FIXTURES, SEALED_KEY_FIXTURE as S } from "./protocol.ts";

const NOW = Number(V.ts);
const headersOf = (h: Record<string, string>) => new Headers(h);

describe("known-answer vector (same literal as the Deno suite)", () => {
  it("sha256Hex and canonicalString reproduce the recorded intermediates", async () => {
    expect(await sha256Hex(V.body)).toBe(V.body_sha256);
    expect(canonicalString(V.method, V.path, V.ts, V.nonce, V.body_sha256)).toBe(V.canonical);
  });

  it("signExecutorRequest under Node produces the exact v1=<hex> Deno produced", async () => {
    const h = await signExecutorRequest(V.secret, V.method, V.path, V.body, NOW, V.nonce);
    expect(h["x-executor-sig"]).toBe(V.sig);
    expect(h["x-executor-ts"]).toBe(V.ts);
    expect(h["x-executor-nonce"]).toBe(V.nonce);
    expect(h["content-type"]).toBe("application/json");
  });

  it("Node verifies the Deno-signed headers", async () => {
    const h = { "x-executor-ts": V.ts, "x-executor-nonce": V.nonce, "x-executor-sig": V.sig };
    expect(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), V.body, NOW)).toEqual({ ok: true });
  });

  it("skew / tamper / missing / version failures classify as in Deno", async () => {
    const h = { "x-executor-ts": V.ts, "x-executor-nonce": V.nonce, "x-executor-sig": V.sig };
    expect(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), V.body, NOW + 301_000)).toEqual({ ok: false, reason: "skew" });
    expect(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), '{"a":2}', NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyExecutorRequest(V.secret, "GET", V.path, headersOf(h), V.body, NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyExecutorRequest(V.secret, V.method, "/v1/calls/x", headersOf(h), V.body, NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf({}), V.body, NOW)).toEqual({ ok: false, reason: "missing" });
    const v2 = { ...h, "x-executor-sig": "v2=" + V.sig.slice(3) };
    expect(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(v2), V.body, NOW)).toEqual({ ok: false, reason: "version" });
  });
});

describe("round trip and callback-path parity", () => {
  it("sign → verify with a random nonce and the real clock", async () => {
    const now = Date.now();
    const body = JSON.stringify(EXECUTOR_FIXTURES.dispatch);
    const h = await signExecutorRequest("s3cret", "POST", "/v1/calls", body, now);
    expect(h["x-executor-nonce"]).toHaveLength(32);
    expect(await verifyExecutorRequest("s3cret", "POST", "/v1/calls", headersOf(h), body, now + 1_000)).toEqual({ ok: true });
  });

  it("what postResult signs (new URL(callback_url).pathname) verifies against EXECUTOR_CALLBACK_PATH, not the stripped req.url path", async () => {
    const path = new URL(EXECUTOR_FIXTURES.dispatch.callback_url).pathname;
    expect(path).toBe(EXECUTOR_CALLBACK_PATH);
    const body = "{}";
    const now = Date.now();
    const h = await signExecutorRequest(V.secret, "POST", path, body, now);
    expect(await verifyExecutorRequest(V.secret, "POST", EXECUTOR_CALLBACK_PATH, headersOf(h), body, now)).toEqual({ ok: true });
    expect(await verifyExecutorRequest(V.secret, "POST", "/boardroom-orchestrator", headersOf(h), body, now)).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("key sealing", () => {
  it("opens the Deno-produced sealed fixture, and only for the recorded call id", async () => {
    expect(await openSealedKey(S.secret, S.call_id, S.sealed)).toBe(S.api_key);
    await expect(openSealedKey(S.secret, S.call_id.replace(/-1$/, "-2"), S.sealed)).rejects.toBeTruthy();
    await expect(openSealedKey(S.secret + "x", S.call_id, S.sealed)).rejects.toBeTruthy();
  });

  it("seal → open round trip under Node; ciphertext never carries the plaintext; tamper throws", async () => {
    const sealed = await sealApiKey("secret", "call-1", "sk-or-v1-abc");
    expect(sealed.v).toBe(1);
    expect(base64ToBytes(sealed.iv)).toHaveLength(12);
    expect(JSON.stringify(sealed)).not.toContain("sk-or-v1-abc");
    expect(await openSealedKey("secret", "call-1", sealed)).toBe("sk-or-v1-abc");
    const ct = base64ToBytes(sealed.ct);
    ct[0] ^= 1;
    await expect(openSealedKey("secret", "call-1", { ...sealed, ct: bytesToBase64(ct) })).rejects.toBeTruthy();
  });
});
