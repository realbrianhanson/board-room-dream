// Shared AES-256-GCM helpers used by key-vault and openrouter-proxy.
// Read + validate the secret PER CALL. Never hash the literal string
// "undefined" (previously produced by `Deno.env.get(...) !` when the secret
// was missing) — that quietly minted a stable but attacker-guessable key.

// Pure helper for tests: returns the trimmed secret when valid, otherwise
// throws the exact operator-actionable error.
export function validateEncryptionSecret(v: string | undefined | null): string {
  if (v === undefined || v === null) {
    throw new Error("KEY_ENCRYPTION_SECRET is not configured");
  }
  const t = String(v).trim();
  if (t === "" || t === "undefined" || t === "null") {
    throw new Error("KEY_ENCRYPTION_SECRET is not configured");
  }
  return t;
}

function requireEncryptionSecret(): string {
  return validateEncryptionSecret(Deno.env.get("KEY_ENCRYPTION_SECRET"));
}

async function importAesKey(): Promise<CryptoKey> {
  const secret = requireEncryptionSecret();
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await importAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return b64encode(combined.buffer);
}

export async function decryptSecret(stored: string): Promise<string> {
  const key = await importAesKey();
  const buf = b64decode(stored);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
