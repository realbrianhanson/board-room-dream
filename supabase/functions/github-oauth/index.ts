// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptSecret } from "../_shared/crypto.ts";
import {
  decodeStateEnvelope,
  encodeStatePayload,
  isAllowedOrigin,
  normalizeOrigin,
} from "./origin.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const KEY_ENCRYPTION_SECRET = Deno.env.get("KEY_ENCRYPTION_SECRET")!;

const GITHUB_CLIENT_ID = Deno.env.get("GITHUB_CLIENT_ID") ?? "";
const GITHUB_CLIENT_SECRET = Deno.env.get("GITHUB_CLIENT_SECRET") ?? "";
const configured = !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(KEY_ENCRYPTION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}

async function makeState(userId: string, origin: string): Promise<string> {
  const ts = Date.now().toString();
  const payload = encodeStatePayload(userId, ts, origin);
  const sig = await hmac(payload);
  return b64url(new TextEncoder().encode(`${payload}|${sig}`));
}

async function verifyState(
  state: string,
  userId: string,
): Promise<
  | { ok: true; origin: string; ageSec: number }
  | { ok: false; reason: string; ageSec?: number }
> {
  try {
    const decoded = new TextDecoder().decode(b64urlDecode(state));
    const env = decodeStateEnvelope(decoded);
    if (!env) return { ok: false, reason: "shape" };
    if (env.uid !== userId) return { ok: false, reason: "uid_mismatch" };
    const ageMs = Date.now() - parseInt(env.ts, 10);
    const ageSec = Math.round(ageMs / 1000);
    if (!isFinite(ageMs) || ageMs < 0 || ageMs > 10 * 60 * 1000) {
      return { ok: false, reason: "age", ageSec };
    }
    const expected = await hmac(env.payload);
    if (expected.length !== env.sig.length) return { ok: false, reason: "sig_len", ageSec };
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ env.sig.charCodeAt(i);
    }
    if (diff !== 0) return { ok: false, reason: "sig_mismatch", ageSec };
    // Origin only returned after HMAC/user/age validation succeeds.
    const norm = normalizeOrigin(env.origin);
    if (!norm) return { ok: false, reason: "origin_shape", ageSec };
    return { ok: true, origin: norm, ageSec };
  } catch (e) {
    return { ok: false, reason: `parse_error:${(e as Error).message}` };
  }
}

async function loadAllowedOrigins(admin: any): Promise<string[] | null> {
  const { data, error } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "allowed_oauth_origins")
    .maybeSingle();
  if (error) {
    console.error(`[github-oauth] allowed_oauth_origins read failed: ${error.message}`);
    return null;
  }
  const raw = (data?.value as any)?.origins;
  if (!Array.isArray(raw)) return null;
  return raw.filter((x): x is string => typeof x === "string");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return j(401, { error: "Missing or invalid user JWT" });

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: uerr } = await userClient.auth.getUser();
  if (uerr || !userData.user) return j(401, { error: "Unauthorized" });
  const userId = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return j(400, { error: "Invalid JSON" }); }
  const action: string = body?.action;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    `[github-oauth] action=${action} user=${userId} client_id_prefix=${GITHUB_CLIENT_ID.slice(0, 6)} client_secret_present=${!!GITHUB_CLIENT_SECRET}`,
  );

  try {
    if (action === "status") {
      const { data } = await admin
        .from("api_keys")
        .select("last4, status")
        .eq("user_id", userId)
        .eq("provider", "github")
        .maybeSingle();
      return j(200, {
        configured,
        connected: !!data,
        last4: data?.last4 ?? null,
        status: data?.status ?? null,
      });
    }

    if (!configured) {
      console.error("[github-oauth] not configured: missing client id/secret env");
      return j(400, { error: "GitHub OAuth is not configured" });
    }

    if (action === "start") {
      const allowed = await loadAllowedOrigins(admin);
      if (!allowed || allowed.length === 0) {
        console.error("[github-oauth] start: allowed_oauth_origins missing/empty");
        return j(400, { error: "OAuth origin not allowed" });
      }
      const verifiedOrigin = isAllowedOrigin(body?.origin, allowed);
      if (!verifiedOrigin) {
        console.error("[github-oauth] start: origin not allowed");
        return j(400, { error: "OAuth origin not allowed" });
      }
      const state = await makeState(userId, verifiedOrigin);
      const redirect_uri = `${verifiedOrigin}/auth/github/callback`;
      console.log(`[github-oauth] start redirect_uri=${redirect_uri}`);
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", GITHUB_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirect_uri);
      url.searchParams.set("scope", "repo");
      url.searchParams.set("state", state);
      url.searchParams.set("allow_signup", "false");
      return j(200, { url: url.toString() });
    }

    if (action === "callback") {
      const code: string = String(body?.code ?? "").trim();
      const state: string = String(body?.state ?? "").trim();
      if (!code || !state) {
        console.error(
          `[github-oauth] callback missing code/state code_present=${!!code} state_present=${!!state}`,
        );
        return j(400, { error: "Missing code or state" });
      }
      const stateResult = await verifyState(state, userId);
      if (!stateResult.ok) {
        console.error(
          `[github-oauth] callback state verification failed reason=${stateResult.reason} age_sec=${stateResult.ageSec ?? "n/a"} user=${userId}`,
        );
        return j(400, { error: "Invalid or expired state" });
      }
      // Re-check allow-list at callback time in case config changed mid-flow.
      const allowed = await loadAllowedOrigins(admin);
      if (!isAllowedOrigin(stateResult.origin, allowed ?? [])) {
        console.error("[github-oauth] callback: state origin no longer allowed");
        return j(400, { error: "OAuth origin not allowed" });
      }
      const redirect_uri = `${stateResult.origin}/auth/github/callback`;

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri,
        }),
      });
      console.log(`[github-oauth] callback token exchange http_status=${tokenRes.status}`);
      if (!tokenRes.ok) {
        console.error(`[github-oauth] callback token exchange non-2xx`);
        return j(502, { error: "GitHub token exchange failed" });
      }
      const tokenJson: any = await tokenRes.json();
      const accessToken: string | undefined = tokenJson?.access_token;
      if (!accessToken) {
        console.error(
          `[github-oauth] callback no access_token; error_code=${tokenJson?.error ?? "n/a"}`,
        );
        return j(400, { error: tokenJson?.error_description ?? "No access token" });
      }
      console.log("[github-oauth] callback token received");

      const encrypted = await encryptSecret(accessToken);
      const last4 = accessToken.slice(-4);
      const { error } = await admin.from("api_keys").upsert(
        {
          user_id: userId,
          provider: "github",
          encrypted_key: encrypted,
          last4,
          status: "valid",
        },
        { onConflict: "user_id,provider" },
      );
      if (error) {
        console.error(`[github-oauth] callback upsert failed: ${error.message}`);
        throw error;
      }
      console.log(`[github-oauth] callback upsert ok last4=${last4}`);
      return j(200, { connected: true, last4, status: "valid" });
    }

    if (action === "disconnect") {
      const { error } = await admin
        .from("api_keys")
        .delete()
        .eq("user_id", userId)
        .eq("provider", "github");
      if (error) {
        console.error(`[github-oauth] disconnect failed: ${error.message}`);
        throw error;
      }
      console.log("[github-oauth] disconnect ok");
      return j(200, { disconnected: true });
    }

    console.error(`[github-oauth] unknown action=${action}`);
    return j(400, { error: "Unknown action" });
  } catch (e) {
    console.error(`[github-oauth] unhandled error: ${(e as Error).message}`);
    return j(500, { error: (e as Error).message });
  }
});
