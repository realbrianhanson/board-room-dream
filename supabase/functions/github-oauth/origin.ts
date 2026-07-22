// Pure helpers for GitHub OAuth origin validation and state payload encoding.
// Kept side-effect-free so they can be unit tested without Deno.serve.

export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.search || u.hash) return null;
  // Only "/" or "" path is acceptable.
  if (u.pathname !== "" && u.pathname !== "/") return null;
  // Reconstruct canonical origin — no trailing slash, no port coercion beyond URL default handling.
  return u.origin;
}

export function isAllowedOrigin(
  candidate: unknown,
  allowed: readonly unknown[] | null | undefined,
): string | null {
  const n = normalizeOrigin(candidate);
  if (!n) return null;
  if (!Array.isArray(allowed)) return null;
  for (const a of allowed) {
    if (normalizeOrigin(a) === n) return n;
  }
  return null;
}

// State payload: `${uid}|${ts}|${origin}` — signed separately via HMAC and
// packaged as `${payload}|${sig}` in the outer envelope. Encoding here does
// NOT sign; caller composes the signed envelope.
export function encodeStatePayload(uid: string, ts: string, origin: string): string {
  if (uid.includes("|") || ts.includes("|") || origin.includes("|")) {
    throw new Error("state payload fields must not contain '|'");
  }
  return `${uid}|${ts}|${origin}`;
}

export type DecodedStatePayload = {
  uid: string;
  ts: string;
  origin: string;
  payload: string;
  sig: string;
};

// Splits `${uid}|${ts}|${origin}|${sig}` — the caller verifies the sig.
// Returns null if the envelope shape is wrong.
export function decodeStateEnvelope(decoded: string): DecodedStatePayload | null {
  const parts = decoded.split("|");
  if (parts.length !== 4) return null;
  const [uid, ts, origin, sig] = parts;
  if (!uid || !ts || !origin || !sig) return null;
  return { uid, ts, origin, payload: `${uid}|${ts}|${origin}`, sig };
}
