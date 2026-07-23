// deno-lint-ignore-file no-explicit-any
// Daily instructor digest. Sends via Resend when RESEND_API_KEY is set;
// otherwise logs the digest gracefully (matches app-wide "graceful degradation"
// pattern for missing optional integrations).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pipeline-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PIPELINE_SECRET = Deno.env.get("PIPELINE_SECRET")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
const FROM_EMAIL = Deno.env.get("DIGEST_FROM_EMAIL") ?? "boardroom@example.com";

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Every user/DB-influenced string flowing into the digest HTML must be
// escaped. Ampersand FIRST so it does not double-escape the entity refs
// emitted for the other characters. Layout markup written by us is trusted
// and NOT escaped.
export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KIND_TITLE: Record<string, string> = {
  stuck_48h: "No activity in 48h",
  audit_loop: "Audit loop — needs human eyes",
  spend_cap: "Spend cap hit — run paused",
  never_locked: "Idea never made it out of the boardroom",
};

function alertLine(a: any): string {
  const d = a.detail ?? {};
  switch (a.kind) {
    case "stuck_48h": return `${escapeHtml(d.hours_idle ?? "48+")}h idle`;
    case "audit_loop": return `Loop ${escapeHtml(d.loop_no ?? 2)} on "${escapeHtml(d.batch_title ?? "batch")}"`;
    case "spend_cap": return `${escapeHtml(d.run_kind ?? "run")} · $${Number(d.spent_usd ?? 0).toFixed(2)} / $${Number(d.budget_usd ?? 0).toFixed(2)}`;
    case "never_locked": return `${escapeHtml(d.days_since_created ?? 7)}+ days since validated`;
    default: return "";
  }
}

async function sendDigest(to: string, subject: string, html: string): Promise<{ sent: boolean; reason?: string }> {
  if (!RESEND_API_KEY) return { sent: false, reason: "no_email_provider" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`resend send failed [${res.status}]: ${body}`);
    return { sent: false, reason: `resend_${res.status}` };
  }
  return { sent: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const secret = req.headers.get("x-pipeline-secret");
  if (!secret || secret !== PIPELINE_SECRET) return j(401, { error: "unauthorized" });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: cohorts } = await admin.from("cohorts").select("id, name, instructor_id");
  const results: any[] = [];

  for (const c of cohorts ?? []) {
    if (!c.instructor_id) { results.push({ cohort: c.name, skipped: "no_instructor" }); continue; }

    // Members
    const { data: members } = await admin.from("profiles").select("id, display_name").eq("cohort_id", c.id);
    const memberIds = (members ?? []).map((m: any) => m.id);
    if (!memberIds.length) { results.push({ cohort: c.name, skipped: "no_members" }); continue; }

    // Open alerts
    const { data: alertRows } = await admin
      .from("alerts")
      .select("id, kind, detail, created_at, user_id, project_id")
      .eq("cohort_id", c.id)
      .eq("status", "open")
      .order("created_at", { ascending: false });

    // Progress snapshot
    const { data: projects } = await admin
      .from("projects")
      .select("id, name, status, user_id")
      .in("user_id", memberIds);

    const projIds = (projects ?? []).map((p: any) => p.id);
    let lockedSet = new Set<string>();
    if (projIds.length) {
      const { data } = await admin.from("plan_versions").select("project_id").eq("kind", "plan").eq("is_build_safe", true).in("project_id", projIds);
      lockedSet = new Set((data ?? []).map((r: any) => r.project_id));
    }

    const totals = {
      members: memberIds.length,
      projects: projects?.length ?? 0,
      locked: (projects ?? []).filter((p: any) => lockedSet.has(p.id)).length,
      done: (projects ?? []).filter((p: any) => p.status === "done").length,
      open_alerts: alertRows?.length ?? 0,
    };

    // Instructor email
    const { data: instrRes } = await admin.auth.admin.getUserById(c.instructor_id);
    const to = instrRes?.user?.email;
    if (!to) { results.push({ cohort: c.name, skipped: "no_instructor_email" }); continue; }

    const nameById = new Map((members ?? []).map((m: any) => [m.id, m.display_name ?? "Member"]));
    const projById = new Map((projects ?? []).map((p: any) => [p.id, p.name]));

    const alertListHtml = (alertRows ?? []).length
      ? `<ul style="padding-left:18px;margin:8px 0 0">${(alertRows ?? []).slice(0, 15).map((a: any) =>
          `<li style="margin:6px 0"><strong>${escapeHtml(KIND_TITLE[a.kind] ?? a.kind)}</strong> — ${escapeHtml(nameById.get(a.user_id) ?? "Member")} · ${escapeHtml(projById.get(a.project_id) ?? "—")} <span style="color:#888">(${alertLine(a)})</span></li>`).join("")}</ul>`
      : `<p style="color:#888;margin:8px 0 0">Nobody is stuck. The board is calm.</p>`;

    const html = `<!doctype html><html><body style="background:#141519;font-family:Inter,Arial,sans-serif;color:#eee;padding:24px">
      <div style="max-width:560px;margin:0 auto;background:#1a1c22;border:1px solid #2a2d34;border-radius:12px;padding:24px">
        <p style="font-family:monospace;letter-spacing:.28em;font-size:11px;color:#888;text-transform:uppercase;margin:0">Boardroom · Daily digest</p>
        <h1 style="font-family:'Fraunces',Georgia,serif;font-size:24px;color:#f2ecd8;margin:6px 0 4px">${escapeHtml(c.name)}</h1>
        <p style="color:#aaa;margin:0 0 20px;font-size:13px">${totals.members} members · ${totals.projects} projects · ${totals.locked} locked · ${totals.done} shipped · ${totals.open_alerts} open alert${totals.open_alerts === 1 ? "" : "s"}</p>
        <h2 style="font-size:12px;font-family:monospace;letter-spacing:.22em;text-transform:uppercase;color:#888;margin:0 0 4px">Attention</h2>
        ${alertListHtml}
        <p style="margin:24px 0 0;color:#888;font-size:12px">Open the cohort dashboard for the full picture.</p>
      </div>
    </body></html>`;

    const subject = `Boardroom — ${escapeHtml(c.name)} · ${totals.open_alerts} alert${totals.open_alerts === 1 ? "" : "s"}`;
    const send = await sendDigest(to, subject, html);
    results.push({ cohort: c.name, to, ...totals, ...send });
  }

  // Reference LOVABLE_API_KEY to make the missing-provider path obvious in logs
  // without leaking values.
  if (!RESEND_API_KEY && !LOVABLE_API_KEY) {
    console.log("[instructor-digest] no email provider configured — digest computed, not sent");
  }

  return j(200, { ok: true, cohorts: results });
});
