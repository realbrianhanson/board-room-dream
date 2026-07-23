// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptSecret, encryptSecret } from "../_shared/crypto.ts";

// COMPATIBILITY NOTE (APP-RELIABILITY-FINDINGS-R1 / task 5):
// The prior local encrypt/decrypt in this file used the identical byte
// format as _shared/crypto.ts: SHA-256(secret_bytes) → AES-GCM key, then
// base64(IV(12) || ciphertext_with_tag). Both used TextEncoder/TextDecoder
// on the plaintext. Rows written by the old implementation therefore
// decrypt correctly through the shared helpers with no rotation needed.
// The shared helpers additionally FAIL CLOSED when KEY_ENCRYPTION_SECRET
// is missing/blank/'undefined' (see crypto.test.ts) — a strict improvement
// over the old `Deno.env.get(...)!` non-null assertion.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function verifyOpenRouter(key: string): Promise<boolean> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    return r.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) {
    return j(401, { error: "Missing or invalid user JWT" });
  }

  // Verify caller identity with anon client
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: uerr } = await userClient.auth.getUser();
  if (uerr || !userData.user) return j(401, { error: "Unauthorized" });
  const userId = userData.user.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return j(400, { error: "Invalid JSON" });
  }
  const action: string = body?.action;
  const provider: string = body?.provider ?? "openrouter";
  if (!["openrouter", "github"].includes(provider)) {
    return j(400, { error: "Invalid provider" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (action === "list") {
      const { data, error } = await admin
        .from("api_keys")
        .select("provider, last4, status")
        .eq("user_id", userId);
      if (error) throw error;
      return j(200, { keys: data ?? [] });
    }

    if (action === "store" || action === "rotate") {
      const key: string = String(body?.key ?? "").trim();
      if (!key || key.length < 16) return j(400, { error: "Key too short" });
      const encrypted = await encrypt(key);
      const last4 = key.slice(-4);
      let status: "unverified" | "valid" | "invalid" = "unverified";
      if (provider === "openrouter") {
        status = (await verifyOpenRouter(key)) ? "valid" : "invalid";
      }
      const { error } = await admin.from("api_keys").upsert(
        {
          user_id: userId,
          provider,
          encrypted_key: encrypted,
          last4,
          status,
        },
        { onConflict: "user_id,provider" },
      );
      if (error) throw error;
      return j(200, { provider, last4, status });
    }

    if (action === "verify") {
      const { data, error } = await admin
        .from("api_keys")
        .select("encrypted_key")
        .eq("user_id", userId)
        .eq("provider", provider)
        .maybeSingle();
      if (error) throw error;
      if (!data) return j(404, { error: "No key stored" });
      const key = await decrypt(data.encrypted_key);
      let status: "unverified" | "valid" | "invalid" = "unverified";
      if (provider === "openrouter") {
        status = (await verifyOpenRouter(key)) ? "valid" : "invalid";
      }
      const { error: uerr2 } = await admin
        .from("api_keys")
        .update({ status })
        .eq("user_id", userId)
        .eq("provider", provider);
      if (uerr2) throw uerr2;
      const last4 = key.slice(-4);
      return j(200, { provider, last4, status });
    }

    if (action === "delete") {
      const { error } = await admin
        .from("api_keys")
        .delete()
        .eq("user_id", userId)
        .eq("provider", provider);
      if (error) throw error;
      return j(200, { provider, deleted: true });
    }

    return j(400, { error: "Unknown action" });
  } catch (e) {
    return j(500, { error: (e as Error).message });
  }
});
