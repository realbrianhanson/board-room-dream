// Batch 17 — signing + sealing shared with the Cloudflare Worker.
// Run: cd supabase/functions && deno test _shared/executor-auth.test.ts
//
// The known-answer vector and the sealed fixture live in executor-protocol.ts
// so the Worker's vitest suite (cloudflare/executor/src/auth.test.ts) asserts
// the SAME literals: Node's WebCrypto must verify what Deno signed and open
// what Deno sealed, or the two runtimes cannot talk to each other.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  canonicalString,
  EXECUTOR_SKEW_MS,
  hexToBytes,
  openSealedKey,
  sealApiKey,
  sha256Hex,
  signExecutorRequest,
  verifyExecutorRequest,
} from "./executor-auth.ts";
import {
  EXECUTOR_AUTH_VECTOR as V,
  EXECUTOR_CALLBACK_PATH,
  EXECUTOR_FIXTURES,
  SEALED_KEY_FIXTURE as S,
} from "./executor-protocol.ts";

const headersOf = (h: Record<string, string>) => new Headers(h);
const NOW = Number(V.ts);

// --- known-answer vector ---------------------------------------------------

Deno.test("sha256Hex — body digest matches the recorded vector", async () => {
  assertEquals(await sha256Hex(V.body), V.body_sha256);
});

Deno.test("canonicalString — exact layout: v1, METHOD, path, ts, nonce, body sha256, newline-separated", () => {
  assertEquals(canonicalString(V.method, V.path, V.ts, V.nonce, V.body_sha256), V.canonical);
  // Method is upper-cased so a lower-case caller signs the same bytes.
  assertEquals(canonicalString("post", V.path, V.ts, V.nonce, V.body_sha256), V.canonical);
});

Deno.test("signExecutorRequest — known-answer: fixed ts + nonce produce the recorded v1=<hex> signature", async () => {
  const h = await signExecutorRequest(V.secret, V.method, V.path, V.body, NOW, V.nonce);
  assertEquals(h["x-executor-sig"], V.sig);
  assertEquals(h["x-executor-ts"], V.ts);
  assertEquals(h["x-executor-nonce"], V.nonce);
  assertEquals(h["content-type"], "application/json");
});

Deno.test("verifyExecutorRequest — the recorded vector verifies", async () => {
  const h = { "x-executor-ts": V.ts, "x-executor-nonce": V.nonce, "x-executor-sig": V.sig };
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), V.body, NOW), { ok: true });
});

// --- round trip -------------------------------------------------------------

Deno.test("sign → verify round trip with a random nonce and the real clock", async () => {
  const now = Date.now();
  const body = JSON.stringify(EXECUTOR_FIXTURES.dispatch);
  const h = await signExecutorRequest("s3cret", "POST", "/v1/calls", body, now);
  assertEquals(h["x-executor-nonce"].length, 32, "16 random bytes as hex");
  assert(h["x-executor-sig"].startsWith("v1="));
  assertEquals(await verifyExecutorRequest("s3cret", "POST", "/v1/calls", headersOf(h), body, now + 5_000), { ok: true });
});

Deno.test("GET with an empty body signs and verifies (status polls)", async () => {
  const now = Date.now();
  const path = `/v1/calls/${EXECUTOR_FIXTURES.dispatch.call_id}`;
  const h = await signExecutorRequest("s3cret", "GET", path, "", now);
  assertEquals(await verifyExecutorRequest("s3cret", "GET", path, headersOf(h), "", now), { ok: true });
});

// --- callback-path parity (§5.3) --------------------------------------------

Deno.test("callback-path parity — the Worker signs new URL(callback_url).pathname; the orchestrator verifies EXECUTOR_CALLBACK_PATH", async () => {
  const callbackUrl = EXECUTOR_FIXTURES.dispatch.callback_url;
  const workerSignedPath = new URL(callbackUrl).pathname;      // what postResult does
  assertEquals(workerSignedPath, EXECUTOR_CALLBACK_PATH);       // "/functions/v1/boardroom-orchestrator"
  const body = JSON.stringify({ action: "executor_result", call_id: "c-1", step_id: "s", run_id: "r", output: EXECUTOR_FIXTURES.okOutput });
  const now = Date.now();
  const h = await signExecutorRequest(V.secret, "POST", workerSignedPath, body, now);
  assertEquals(await verifyExecutorRequest(V.secret, "POST", EXECUTOR_CALLBACK_PATH, headersOf(h), body, now), { ok: true });
});

Deno.test("callback-path parity — verifying against req.url's stripped path ('/boardroom-orchestrator') is a mismatch, which is why req.url must never be used", async () => {
  // Inside a hosted edge function the gateway strips the /functions/v1
  // prefix, so new URL(req.url).pathname is "/boardroom-orchestrator". A
  // verifier that used it would 401 every callback, the Workflow would stop
  // on NonRetryableError, and every settle would silently fall back to the
  // 60 s collector.
  const body = "{}";
  const now = Date.now();
  const h = await signExecutorRequest(V.secret, "POST", EXECUTOR_CALLBACK_PATH, body, now);
  assertEquals(await verifyExecutorRequest(V.secret, "POST", "/boardroom-orchestrator", headersOf(h), body, now), {
    ok: false,
    reason: "mismatch",
  });
});

// --- failure classes --------------------------------------------------------

Deno.test("verify — skew: ±301 s is rejected, ±300 s is accepted", async () => {
  const h = { "x-executor-ts": V.ts, "x-executor-nonce": V.nonce, "x-executor-sig": V.sig };
  assertEquals(EXECUTOR_SKEW_MS, 300_000);
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), V.body, NOW + 301_000), { ok: false, reason: "skew" });
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), V.body, NOW - 301_000), { ok: false, reason: "skew" });
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), V.body, NOW + 300_000), { ok: true });
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), V.body, NOW - 300_000), { ok: true });
  // A non-numeric timestamp is a skew failure too, never a crash.
  const bad = { ...h, "x-executor-ts": "yesterday" };
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(bad), V.body, NOW), { ok: false, reason: "skew" });
});

Deno.test("verify — tampered body / path / method / secret / nonce → mismatch", async () => {
  const h = { "x-executor-ts": V.ts, "x-executor-nonce": V.nonce, "x-executor-sig": V.sig };
  assertEquals((await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(h), '{"a":2}', NOW)), { ok: false, reason: "mismatch" });
  assertEquals((await verifyExecutorRequest(V.secret, V.method, "/v1/calls/x/cancel", headersOf(h), V.body, NOW)), { ok: false, reason: "mismatch" });
  assertEquals((await verifyExecutorRequest(V.secret, "GET", V.path, headersOf(h), V.body, NOW)), { ok: false, reason: "mismatch" });
  assertEquals((await verifyExecutorRequest(V.secret + "0", V.method, V.path, headersOf(h), V.body, NOW)), { ok: false, reason: "mismatch" });
  const nonce = { ...h, "x-executor-nonce": "ff0102030405060708090a0b0c0d0e0f" };
  assertEquals((await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(nonce), V.body, NOW)), { ok: false, reason: "mismatch" });
  // A signature of the wrong length / non-hex never reaches subtle.verify.
  const short = { ...h, "x-executor-sig": "v1=abcd" };
  assertEquals((await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(short), V.body, NOW)), { ok: false, reason: "mismatch" });
  const nonHex = { ...h, "x-executor-sig": "v1=" + "zz".repeat(32) };
  assertEquals((await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(nonHex), V.body, NOW)), { ok: false, reason: "mismatch" });
});

Deno.test("verify — missing headers → missing; unknown signature version → version", async () => {
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf({}), V.body, NOW), { ok: false, reason: "missing" });
  const noSig = { "x-executor-ts": V.ts, "x-executor-nonce": V.nonce };
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(noSig), V.body, NOW), { ok: false, reason: "missing" });
  const noTs = { "x-executor-nonce": V.nonce, "x-executor-sig": V.sig };
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(noTs), V.body, NOW), { ok: false, reason: "missing" });
  const v2 = { "x-executor-ts": V.ts, "x-executor-nonce": V.nonce, "x-executor-sig": "v2=" + V.sig.slice(3) };
  assertEquals(await verifyExecutorRequest(V.secret, V.method, V.path, headersOf(v2), V.body, NOW), { ok: false, reason: "version" });
});

// --- key sealing (§6.2) -----------------------------------------------------

Deno.test("sealApiKey / openSealedKey — round trip; fresh iv per seal; encoded shape is { v:1, iv, ct }", async () => {
  const a = await sealApiKey("secret", "call-1", "sk-or-v1-abc");
  const b = await sealApiKey("secret", "call-1", "sk-or-v1-abc");
  assertEquals(a.v, 1);
  assertEquals(base64ToBytes(a.iv).length, 12);
  assert(a.iv !== b.iv, "iv is random per seal");
  assert(a.ct !== b.ct);
  assert(!JSON.stringify(a).includes("sk-or-v1-abc"), "ciphertext never carries the plaintext");
  assertEquals(await openSealedKey("secret", "call-1", a), "sk-or-v1-abc");
  assertEquals(await openSealedKey("secret", "call-1", b), "sk-or-v1-abc");
});

Deno.test("openSealedKey — wrong call id (HKDF info + AAD), wrong secret, tampered ciphertext, bad shape all throw", async () => {
  const sealed = await sealApiKey("secret", "call-1", "sk-or-v1-abc");
  await assertRejects(() => openSealedKey("secret", "call-2", sealed));
  await assertRejects(() => openSealedKey("other", "call-1", sealed));
  const ct = base64ToBytes(sealed.ct);
  ct[0] ^= 0x01;
  await assertRejects(() => openSealedKey("secret", "call-1", { ...sealed, ct: bytesToBase64(ct) }));
  await assertRejects(() => openSealedKey("secret", "call-1", { v: 2, iv: sealed.iv, ct: sealed.ct } as any));
  await assertRejects(() => openSealedKey("secret", "call-1", null as any));
});

Deno.test("sealed fixture — what Deno sealed opens to the recorded key and only for the recorded call id (the Worker test opens the same literal)", async () => {
  assertEquals(await openSealedKey(S.secret, S.call_id, S.sealed), S.api_key);
  await assertRejects(() => openSealedKey(S.secret, S.call_id.replace(/-1$/, "-2"), S.sealed));
});

// --- byte helpers -----------------------------------------------------------

Deno.test("hex / base64 helpers round-trip and reject malformed hex", () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  assertEquals(bytesToHex(bytes), "000102feff");
  assertEquals(hexToBytes("000102feff"), bytes);
  assertEquals(hexToBytes("abc"), null, "odd length");
  assertEquals(hexToBytes("zz"), null, "non-hex");
  assertEquals(base64ToBytes(bytesToBase64(bytes)), bytes);
});
