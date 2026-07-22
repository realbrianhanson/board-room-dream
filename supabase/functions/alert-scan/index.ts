// deno-lint-ignore-file no-explicit-any
// Daily scan for stuck-student alerts. Called by pg_cron with x-pipeline-secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pipeline-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PIPELINE_SECRET = Deno.env.get("PIPELINE_SECRET")!;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function cohortFor(admin: any, userId: string): Promise<string | null> {
  const { data } = await admin.from("profiles").select("cohort_id").eq("id", userId).maybeSingle();
  return data?.cohort_id ?? null;
}

async function hasOpenAlert(admin: any, projectId: string, kind: string): Promise<boolean> {
  const { data } = await admin.from("alerts").select("id").eq("project_id", projectId).eq("kind", kind).eq("status", "open").limit(1);
  return (data ?? []).length > 0;
}

async function autoResolve(admin: any, projectId: string, kind: string, snoozedOk = true) {
  const now = new Date().toISOString();
  const q = admin.from("alerts").update({ status: "resolved", resolved_at: now }).eq("project_id", projectId).eq("kind", kind).eq("status", "open");
  await q;
  if (!snoozedOk) return;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const secret = req.headers.get("x-pipeline-secret");
  if (!secret || secret !== PIPELINE_SECRET) return j(401, { error: "unauthorized" });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const now = Date.now();
  const cutoff48h = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const stats = { stuck_48h_new: 0, stuck_48h_resolved: 0, never_locked_new: 0, never_locked_resolved: 0 };

  // ---- stuck_48h: projects in building/auditing with no batch or run_step activity in 48h.
  const { data: activeProjects } = await admin
    .from("projects")
    .select("id, user_id, status")
    .in("status", ["building", "auditing"]);

  for (const p of activeProjects ?? []) {
    // Latest batch status change.
    const { data: b } = await admin
      .from("batches")
      .select("built_at, sent_at, created_at")
      .eq("project_id", p.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastBatch = b ? new Date(b.built_at ?? b.sent_at ?? b.created_at).getTime() : 0;

    const { data: rs } = await admin
      .from("run_steps")
      .select("created_at, boardroom_runs!inner(project_id)")
      .eq("boardroom_runs.project_id", p.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const lastStep = rs && rs[0] ? new Date((rs[0] as any).created_at).getTime() : 0;

    const lastActivity = Math.max(lastBatch, lastStep);
    const stuck = lastActivity > 0 && lastActivity < new Date(cutoff48h).getTime();

    // Respect snoozed_until.
    const { data: snoozed } = await admin
      .from("alerts")
      .select("id, snoozed_until")
      .eq("project_id", p.id)
      .eq("kind", "stuck_48h")
      .eq("status", "snoozed")
      .order("created_at", { ascending: false })
      .limit(1);
    const snoozeActive = snoozed && snoozed[0] && snoozed[0].snoozed_until && new Date(snoozed[0].snoozed_until).getTime() > now;

    if (stuck && !snoozeActive && !(await hasOpenAlert(admin, p.id, "stuck_48h"))) {
      const cohort_id = await cohortFor(admin, p.user_id);
      const hoursIdle = Math.floor((now - lastActivity) / (60 * 60 * 1000));
      await admin.from("alerts").insert({
        cohort_id,
        user_id: p.user_id,
        project_id: p.id,
        kind: "stuck_48h",
        detail: { hours_idle: hoursIdle, project_status: p.status },
      });
      stats.stuck_48h_new++;
    } else if (!stuck) {
      // Auto-resolve open alert
      const { data: open } = await admin.from("alerts").select("id").eq("project_id", p.id).eq("kind", "stuck_48h").eq("status", "open").limit(1);
      if (open && open.length) {
        await autoResolve(admin, p.id, "stuck_48h");
        stats.stuck_48h_resolved++;
      }
    }
  }

  // ---- never_locked: validated more than 7 days ago with no plan_versions row.
  const { data: validated } = await admin
    .from("projects")
    .select("id, user_id, status, created_at")
    .eq("status", "validated")
    .lt("created_at", cutoff7d);

  for (const p of validated ?? []) {
    const { data: pv } = await admin.from("plan_versions").select("id").eq("project_id", p.id).eq("is_build_safe", true).limit(1);
    if ((pv ?? []).length) continue;
    if (await hasOpenAlert(admin, p.id, "never_locked")) continue;
    const cohort_id = await cohortFor(admin, p.user_id);
    const daysSince = Math.floor((now - new Date(p.created_at).getTime()) / (24 * 60 * 60 * 1000));
    await admin.from("alerts").insert({
      cohort_id,
      user_id: p.user_id,
      project_id: p.id,
      kind: "never_locked",
      detail: { days_since_created: daysSince },
    });
    stats.never_locked_new++;
  }

  // Auto-resolve never_locked when a plan_versions row now exists.
  const { data: openNL } = await admin.from("alerts").select("id, project_id").eq("kind", "never_locked").eq("status", "open");
  for (const a of openNL ?? []) {
    const { data: pv } = await admin.from("plan_versions").select("id").eq("project_id", a.project_id).eq("is_build_safe", true).limit(1);
    if ((pv ?? []).length) {
      await admin.from("alerts").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", a.id);
      stats.never_locked_resolved++;
    }
  }

  return j(200, { ok: true, ...stats });
});
