// deno-lint-ignore-file no-explicit-any
// The learning flywheel's mining pass. An ADMIN invokes this on demand (it
// runs on the caller's BYOK OpenRouter key, which is why it isn't a cron):
// the Chair reads the workspace's recent audit findings and owner-reported
// batch outcomes and proposes new field-manual rules. Proposals land in
// field_manual_proposals as 'pending'; an admin approves or dismisses them in
// Settings, and approved rules join app_settings.field_manual_addenda — which
// every future batch, blueprint, review, and audit prompt inherits.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { adminClient, callSeat, NoUserKey, SeatUnavailable } from "../_shared/openrouter-proxy.ts";
import { LOVABLE_FIELD_MANUAL } from "../_shared/lovable-field-manual.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return j(401, { error: "Missing or invalid user JWT" });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: uerr } = await userClient.auth.getUser();
  if (uerr || !userData.user) return j(401, { error: "Unauthorized" });
  const userId = userData.user.id;

  const admin = adminClient();
  const { data: profile } = await admin.from("profiles").select("role").eq("id", userId).maybeSingle();
  if (profile?.role !== "admin") return j(403, { error: "Admins only" });

  // Evidence window: last 30 days of findings + outcomes across the workspace.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: findings }, { data: outcomes }, { data: addenda }] = await Promise.all([
    admin
      .from("audit_findings")
      .select("severity, title, description, file_path")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(120),
    admin
      .from("batches")
      .select("title, channel, outcome_md")
      .not("outcome_md", "is", null)
      .order("created_at", { ascending: false })
      .limit(60),
    admin.from("app_settings").select("value").eq("key", "field_manual_addenda").maybeSingle(),
  ]);

  if (!(findings ?? []).length && !(outcomes ?? []).length) {
    return j(200, { status: "no_evidence", inserted: 0 });
  }

  const existingRules: string[] = Array.isArray((addenda?.value as any)?.items)
    ? (addenda!.value as any).items.map((i: any) => String(i))
    : [];

  const system = `You are the Chair, mining this workspace's real build history for RECURRING Lovable failure patterns worth adding to the field manual — the doctrine injected into every future build prompt.

A good rule: appears in 2+ pieces of evidence, is preventable by a prompt-writing habit, and is not already covered by the current manual or addenda. Max 5 proposals; zero is a valid answer.

Return ONLY valid JSON:
{
  "proposals": [
    { "rule": "one imperative sentence, manual-style, generic across projects", "rationale": "which evidence shows this pattern, one paragraph" }
  ]
}`;
  const user = `CURRENT FIELD MANUAL
${LOVABLE_FIELD_MANUAL}

CURRENT ADDENDA
${existingRules.length ? existingRules.map((r) => `- ${r}`).join("\n") : "(none)"}

AUDIT FINDINGS (last 30 days)
${JSON.stringify(findings ?? [], null, 1)}

OWNER-REPORTED BATCH OUTCOMES
${JSON.stringify(outcomes ?? [], null, 1)}

Produce your JSON now.`;

  try {
    const res = await callSeat(userId, "chair", [
      { role: "system", content: system },
      { role: "user", content: user },
    ], { json: true, temperature: 0.3, reasoningEffort: "high" });

    let parsed: any = null;
    try { parsed = JSON.parse(res.content); } catch { /* below */ }
    const proposals = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
    const valid = proposals.filter((p: any) => typeof p?.rule === "string" && p.rule.trim().length >= 15).slice(0, 5);

    // Skip near-duplicates of existing rules or pending proposals.
    const { data: pending } = await admin
      .from("field_manual_proposals")
      .select("proposed_rule")
      .in("status", ["pending", "approved"]);
    const known = new Set([...existingRules, ...(pending ?? []).map((r: any) => String(r.proposed_rule))].map((s) => s.toLowerCase().trim()));
    const fresh = valid.filter((p: any) => !known.has(String(p.rule).toLowerCase().trim()));

    if (fresh.length) {
      await admin.from("field_manual_proposals").insert(fresh.map((p: any) => ({
        proposed_rule: String(p.rule).trim(),
        rationale: typeof p.rationale === "string" ? p.rationale : null,
        evidence: { findings: (findings ?? []).length, outcomes: (outcomes ?? []).length, window_days: 30 },
        created_by: userId,
      })));
    }
    return j(200, { status: "ok", inserted: fresh.length, considered: valid.length });
  } catch (e) {
    if (e instanceof NoUserKey) return j(200, { status: "no_key" });
    if (e instanceof SeatUnavailable) return j(500, { error: (e as Error).message });
    return j(500, { error: (e as Error).message });
  }
});
