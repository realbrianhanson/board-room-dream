import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Bell, CheckCircle2, Clock, DollarSign, Users2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/cohort")({
  beforeLoad: async () => {
    const { data } = await supabase.from("profiles").select("role").maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    if (role !== "instructor" && role !== "admin") throw redirect({ to: "/dashboard" });
  },
  component: CohortPage,
});

type MemberRow = {
  id: string;
  display_name: string | null;
  cohort_id: string | null;
  cohort_name?: string | null;
  project_count: number;
  locked_count: number;
  active_project?: { id: string; name: string; status: string; current_batch_no: number } | null;
  open_alerts: number;
};

type AlertRow = {
  id: string;
  kind: "stuck_48h" | "audit_loop" | "spend_cap" | "never_locked";
  status: "open" | "resolved" | "snoozed";
  detail: any;
  created_at: string;
  project_id: string | null;
  user_id: string;
  cohort_id: string | null;
  project?: { name: string } | null;
  user?: { display_name: string | null } | null;
};

const KIND_LABEL: Record<AlertRow["kind"], { title: string; icon: any; tone: string }> = {
  stuck_48h: { title: "No activity in 48h", icon: Clock, tone: "text-[hsl(38_65%_55%)]" },
  audit_loop: { title: "Audit loop — needs human eyes", icon: AlertTriangle, tone: "text-[hsl(8_60%_55%)]" },
  spend_cap: { title: "Spend cap hit — run paused", tone: "text-[hsl(8_60%_55%)]", icon: DollarSign },
  never_locked: { title: "Idea never made it out of the boardroom", tone: "text-[hsl(38_65%_55%)]", icon: Bell },
};

function alertLine(a: AlertRow): string {
  const d = a.detail ?? {};
  switch (a.kind) {
    case "stuck_48h": return `${d.hours_idle ?? "48+"}h idle · project ${d.project_status ?? ""}`.trim();
    case "audit_loop": return `Loop ${d.loop_no ?? 2} on "${d.batch_title ?? "batch"}" · P0 ${d.counts?.P0 ?? 0} · P1 ${d.counts?.P1 ?? 0}`;
    case "spend_cap": return `${d.run_kind ?? "run"} · $${Number(d.spent_usd ?? 0).toFixed(2)} / $${Number(d.budget_usd ?? 0).toFixed(2)}`;
    case "never_locked": return `${d.days_since_created ?? 7}+ days since validated · no locked plan`;
  }
}

function CohortPage() {
  const [cohorts, setCohorts] = useState<{ id: string; name: string }[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) return;

    // Cohorts the instructor teaches (RLS also permits admin-wide reads).
    const { data: cohortsData } = await supabase.from("cohorts").select("id, name").order("name");
    setCohorts((cohortsData ?? []) as any);

    // Members in those cohorts.
    const cohortIds = (cohortsData ?? []).map((c: any) => c.id);
    let profileRows: any[] = [];
    if (cohortIds.length) {
      const { data } = await supabase
        .from("profiles")
        .select("id, display_name, cohort_id")
        .in("cohort_id", cohortIds);
      profileRows = data ?? [];
    }

    // Projects per member.
    const memberIds = profileRows.map((p) => p.id);
    let projectRows: any[] = [];
    if (memberIds.length) {
      const { data } = await supabase
        .from("projects")
        .select("id, name, status, user_id, current_batch_no, created_at")
        .in("user_id", memberIds)
        .order("created_at", { ascending: false });
      projectRows = data ?? [];
    }

    // Locked-plan counts.
    const projectIds = projectRows.map((p) => p.id);
    let lockedByProject = new Set<string>();
    if (projectIds.length) {
      const { data } = await supabase
        .from("plan_versions")
        .select("project_id")
        .eq("kind", "plan")
        .in("project_id", projectIds);
      lockedByProject = new Set((data ?? []).map((r: any) => r.project_id));
    }

    // Open alert counts per user.
    let openAlertsByUser: Record<string, number> = {};
    if (memberIds.length) {
      const { data } = await supabase
        .from("alerts")
        .select("user_id")
        .in("user_id", memberIds)
        .eq("status", "open");
      for (const r of data ?? []) {
        openAlertsByUser[(r as any).user_id] = (openAlertsByUser[(r as any).user_id] ?? 0) + 1;
      }
    }

    const cohortNameById = new Map((cohortsData ?? []).map((c: any) => [c.id, c.name]));
    const rows: MemberRow[] = profileRows.map((p) => {
      const projects = projectRows.filter((pr) => pr.user_id === p.id);
      const active = projects.find((pr) => !["done", "killed"].includes(pr.status)) ?? projects[0] ?? null;
      const locked = projects.filter((pr) => lockedByProject.has(pr.id)).length;
      return {
        id: p.id,
        display_name: p.display_name,
        cohort_id: p.cohort_id,
        cohort_name: cohortNameById.get(p.cohort_id) ?? null,
        project_count: projects.length,
        locked_count: locked,
        active_project: active
          ? { id: active.id, name: active.name, status: active.status, current_batch_no: active.current_batch_no ?? 0 }
          : null,
        open_alerts: openAlertsByUser[p.id] ?? 0,
      };
    }).sort((a, b) => (b.open_alerts - a.open_alerts) || ((b.active_project ? 1 : 0) - (a.active_project ? 1 : 0)));
    setMembers(rows);

    // Recent open alerts across cohorts.
    const { data: alertRows } = await supabase
      .from("alerts")
      .select("id, kind, status, detail, created_at, project_id, user_id, cohort_id")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(30);
    // Hydrate project + user labels.
    const alertIds = (alertRows ?? []) as AlertRow[];
    const projIds = Array.from(new Set(alertIds.map((a) => a.project_id).filter(Boolean))) as string[];
    const userIds = Array.from(new Set(alertIds.map((a) => a.user_id)));
    let projMap = new Map<string, string>();
    let userMap = new Map<string, string | null>();
    if (projIds.length) {
      const { data } = await supabase.from("projects").select("id, name").in("id", projIds);
      projMap = new Map((data ?? []).map((r: any) => [r.id, r.name]));
    }
    if (userIds.length) {
      const { data } = await supabase.from("profiles").select("id, display_name").in("id", userIds);
      userMap = new Map((data ?? []).map((r: any) => [r.id, r.display_name]));
    }
    setAlerts(alertIds.map((a) => ({
      ...a,
      project: a.project_id ? { name: projMap.get(a.project_id) ?? "Untitled" } : null,
      user: { display_name: userMap.get(a.user_id) ?? null },
    })));

    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Realtime: refresh on alerts changes.
  useEffect(() => {
    const channel = supabase
      .channel("cohort-alerts")
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, () => { void load(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  async function resolveAlert(id: string) {
    const { error } = await supabase
      .from("alerts")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Marked resolved");
  }

  async function snoozeAlert(id: string, days: number) {
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from("alerts")
      .update({ status: "snoozed", snoozed_until: until })
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success(`Snoozed for ${days}d`);
  }

  const stuckCount = alerts.length;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Cohort</p>
          <h1 className="font-display text-4xl leading-tight text-foreground">The room, at a glance.</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {cohorts.length
              ? `${members.length} members across ${cohorts.length} cohort${cohorts.length === 1 ? "" : "s"} · ${stuckCount} open alert${stuckCount === 1 ? "" : "s"}.`
              : "You don't instruct any cohorts yet."}
          </p>
        </div>
      </div>

      {/* Alerts strip */}
      <section className="mb-10">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Attention</h2>
        {loading ? (
          <div className="rounded-xl border border-border/40 bg-surface-1 p-6 text-sm text-muted-foreground">Scanning…</div>
        ) : alerts.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-border/40 bg-surface-1 p-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-[hsl(160_45%_48%)]" />
            Nobody is stuck. The board is calm.
          </div>
        ) : (
          <ul className="space-y-2">
            {alerts.map((a) => {
              const meta = KIND_LABEL[a.kind];
              const Icon = meta.icon;
              return (
                <li key={a.id} className="rounded-xl border border-border/40 bg-surface-1 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Icon className={`h-4 w-4 ${meta.tone}`} />
                        <p className="text-sm text-foreground">{meta.title}</p>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {a.user?.display_name ?? "Member"} · {a.project?.name ?? "—"} · {alertLine(a)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {a.project_id && (
                        <Link
                          to="/cohort/$projectId"
                          params={{ projectId: a.project_id }}
                          className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:border-primary/40"
                        >
                          Open project →
                        </Link>
                      )}
                      <button
                        onClick={() => snoozeAlert(a.id, 3)}
                        className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Snooze 3d
                      </button>
                      <button
                        onClick={() => resolveAlert(a.id)}
                        className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Resolve
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Members */}
      <section>
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Members</h2>
        {loading ? (
          <div className="rounded-xl border border-border/40 bg-surface-1 p-6 text-sm text-muted-foreground">Loading…</div>
        ) : members.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-border/40 bg-surface-1 p-8 text-sm text-muted-foreground">
            <Users2 className="h-4 w-4" />
            No members yet. Share your cohort code and they'll show up here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/40 bg-surface-1">
            <table className="w-full text-sm">
              <thead className="border-b border-border/40 text-left font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Member</th>
                  <th className="px-4 py-3">Cohort</th>
                  <th className="px-4 py-3">Projects</th>
                  <th className="px-4 py-3">Locked</th>
                  <th className="px-4 py-3">Active</th>
                  <th className="px-4 py-3">Alerts</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-t border-border/20 text-foreground">
                    <td className="px-4 py-3">{m.display_name ?? "Member"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{m.cohort_name ?? "—"}</td>
                    <td className="px-4 py-3 font-mono">{m.project_count}</td>
                    <td className="px-4 py-3 font-mono">{m.locked_count}</td>
                    <td className="px-4 py-3">
                      {m.active_project ? (
                        <span className="text-muted-foreground">
                          <span className="text-foreground">{m.active_project.name}</span> · {m.active_project.status}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {m.open_alerts ? (
                        <span className="rounded-full border border-[hsl(8_60%_55%)]/40 bg-[hsl(8_60%_55%)]/10 px-2 py-0.5 font-mono text-[10px] text-[hsl(8_60%_55%)]">
                          {m.open_alerts} open
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {m.active_project ? (
                        <Link
                          to="/cohort/$projectId"
                          params={{ projectId: m.active_project.id }}
                          className="inline-flex items-center gap-1 text-xs text-foreground hover:text-primary"
                        >
                          Drill in <ArrowRight className="h-3 w-3" />
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
