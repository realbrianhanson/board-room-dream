// Batch 17 — request signing and key sealing shared by the boardroom-orchestrator
// edge function and the Cloudflare executor Worker (spec §6.1 / §6.2).
//
// Pure WebCrypto + TextEncoder only: no Deno.*, no Node built-ins, no URL
// imports, so the same file runs under Deno, workerd (esbuild) and vitest.
//
//   canonical = "v1\n" + METHOD + "\n" + path_with_query + "\n" + ts + "\n" + nonce + "\n" + sha256hex(body)
//   sig       = HMAC-SHA256(utf8(EXECUTOR_SECRET), canonical)
//
// Replay inside the skew window is harmless by construction (dispatch is
// idempotent on call_id, status reads are read-only, cancel is idempotent,
// executor_result settles idempotently), so there is no nonce store.
import type { SealedKey } from "./executor-protocol.ts";
export type { SealedKey };

export const EXECUTOR_SIG_VERSION = "v1";
export const EXECUTOR_SKEW_MS = 300_000;
/** HKDF salt for key sealing; the call id is the HKDF info AND the AES-GCM AAD. */
export const EXECUTOR_SEAL_SALT = "boardroom-executor-v1";

export type ExecutorHeaders = {
  "x-executor-ts": string;
  "x-executor-nonce": string;
  "x-executor-sig": string;
  "content-type": "application/json";
};

export type VerifyFailure = "missing" | "version" | "skew" | "mismatch";
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- byte helpers (no Buffer: the Worker runs without nodejs_compat) ---------

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Null on odd length or a non-hex character. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- signing ----------------------------------------------------------------

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return bytesToHex(new Uint8Array(digest));
}

export function canonicalString(
  method: string,
  pathWithQuery: string,
  ts: string,
  nonce: string,
  bodySha256Hex: string,
): string {
  return `${EXECUTOR_SIG_VERSION}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${ts}\n${nonce}\n${bodySha256Hex}`;
}

function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export function randomNonceHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signExecutorRequest(
  secret: string,
  method: string,
  pathWithQuery: string,
  body: string,
  nowMs: number = Date.now(),
  nonceHex: string = randomNonceHex(),
): Promise<ExecutorHeaders> {
  const ts = String(Math.floor(nowMs));
  const canonical = canonicalString(method, pathWithQuery, ts, nonceHex, await sha256Hex(body));
  const key = await hmacKey(secret, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(canonical)));
  return {
    "x-executor-ts": ts,
    "x-executor-nonce": nonceHex,
    "x-executor-sig": `${EXECUTOR_SIG_VERSION}=${bytesToHex(sig)}`,
    "content-type": "application/json",
  };
}

/**
 * Verify a signed request. `pathWithQuery` MUST be the path the sender
 * signed (for callbacks: EXECUTOR_CALLBACK_PATH, never `new URL(req.url).pathname`).
 * Comparison goes through crypto.subtle.verify (constant time).
 */
export async function verifyExecutorRequest(
  secret: string,
  method: string,
  pathWithQuery: string,
  headers: { get(n: string): string | null },
  body: string,
  nowMs: number,
  skewMs: number = EXECUTOR_SKEW_MS,
): Promise<VerifyResult> {
  const ts = headers.get("x-executor-ts");
  const nonce = headers.get("x-executor-nonce");
  const sig = headers.get("x-executor-sig");
  if (!ts || !nonce || !sig) return { ok: false, reason: "missing" };
  const prefix = `${EXECUTOR_SIG_VERSION}=`;
  if (!sig.startsWith(prefix)) return { ok: false, reason: "version" };
  const tsNum = Number(ts);
  if (!/^\d{1,16}$/.test(ts) || !Number.isFinite(tsNum) || Math.abs(nowMs - tsNum) > skewMs) {
    return { ok: false, reason: "skew" };
  }
  const sigBytes = hexToBytes(sig.slice(prefix.length));
  if (!sigBytes || sigBytes.length !== 32) return { ok: false, reason: "mismatch" };
  const canonical = canonicalString(method, pathWithQuery, ts, nonce, await sha256Hex(body));
  const key = await hmacKey(secret, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(canonical));
  return ok ? { ok: true } : { ok: false, reason: "mismatch" };
}

// --- key sealing (§6.2) -----------------------------------------------------
//
//   k      = HKDF-SHA256(ikm = utf8(secret), salt = utf8("boardroom-executor-v1"), info = utf8(call_id), 32 bytes)
//   sealed = AES-256-GCM(k, iv = 12 random bytes, plaintext = utf8(api_key), aad = utf8(call_id))

async function deriveSealKey(secret: string, callId: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(EXECUTOR_SEAL_SALT), info: enc.encode(callId) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

export async function sealApiKey(secret: string, callId: string, apiKey: string): Promise<SealedKey> {
  const key = await deriveSealKey(secret, callId, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(callId) },
    key,
    enc.encode(apiKey),
  );
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

/** Throws on a wrong secret, a wrong call id (AAD / HKDF info) or a tampered ciphertext. */
export async function openSealedKey(secret: string, callId: string, sealed: SealedKey): Promise<string> {
  if (!sealed || sealed.v !== 1 || typeof sealed.iv !== "string" || typeof sealed.ct !== "string") {
    throw new Error("sealed key: unsupported format");
  }
  const key = await deriveSealKey(secret, callId, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(sealed.iv), additionalData: enc.encode(callId) },
    key,
    base64ToBytes(sealed.ct),
  );
  return dec.decode(pt);
}
