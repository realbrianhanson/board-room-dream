import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type Row = { created_at: string; cost_usd: number; project_id: string | null };

export function SpendPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [cap, setCap] = useState<number>(25);
  const [capScope, setCapScope] = useState<"cohort" | "default">("default");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) return;

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("cost_ledger")
        .select("created_at, cost_usd, project_id")
        .eq("user_id", uid)
        .gte("created_at", since)
        .order("created_at", { ascending: false });
      const list = (data ?? []) as Row[];
      setRows(list);

      // Resolve cap.
      const { data: profile } = await supabase.from("profiles").select("cohort_id").eq("id", uid).maybeSingle();
      let resolved: number | null = null;
      if (profile?.cohort_id) {
        const { data: cohort } = await supabase
          .from("cohorts")
          .select("daily_cap_usd")
          .eq("id", profile.cohort_id)
          .maybeSingle();
        if (cohort?.daily_cap_usd != null) {
          const n = Number(cohort.daily_cap_usd);
          if (Number.isFinite(n) && n > 0) {
            resolved = n;
            setCapScope("cohort");
          }
        }
      }
      if (resolved == null) {
        const { data: setting } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "default_daily_cap_usd")
          .maybeSingle();
        const usd = Number((setting?.value as { usd?: number } | null)?.usd);
        resolved = Number.isFinite(usd) && usd > 0 ? usd : 25;
        setCapScope("default");
      }
      setCap(resolved);

      // Project names
      const ids = Array.from(new Set(list.map((r) => r.project_id).filter(Boolean))) as string[];
      if (ids.length) {
        const { data: projs } = await supabase.from("projects").select("id, name").in("id", ids);
        setProjectNames(Object.fromEntries((projs ?? []).map((p: { id: string; name: string }) => [p.id, p.name])));
      }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="h-24 animate-pulse rounded-md bg-surface-2" />
        <div className="h-32 animate-pulse rounded-md bg-surface-2" />
      </div>
    );
  }

  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const todaySpent = rows
    .filter((r) => new Date(r.created_at).getTime() >= startOfDayUtc.getTime())
    .reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const pct = Math.min(100, (todaySpent / cap) * 100);
  const barColor = pct >= 100 ? "hsl(8_60%_55%)" : pct >= 80 ? "hsl(38_65%_55%)" : "hsl(160_45%_48%)";

  // Group by day (UTC).
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = new Date(r.created_at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    byDay.set(key, (byDay.get(key) ?? 0) + Number(r.cost_usd ?? 0));
  }
  const days = Array.from(byDay.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));

  // Group by project.
  const byProject = new Map<string, number>();
  for (const r of rows) {
    const key = r.project_id ?? "(no project)";
    byProject.set(key, (byProject.get(key) ?? 0) + Number(r.cost_usd ?? 0));
  }
  const projects = Array.from(byProject.entries()).sort((a, b) => b[1] - a[1]);
  const total30 = rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Today's cap */}
      <div className="rounded-lg border border-border bg-surface-2 p-5">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Today · UTC</span>
          <span className="font-mono text-xs text-muted-foreground">
            cap from {capScope === "cohort" ? "your cohort" : "the workspace default"}
          </span>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-mono text-2xl text-foreground">${todaySpent.toFixed(2)}</span>
          <span className="font-mono text-sm text-muted-foreground">/ ${cap.toFixed(2)}</span>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-1">
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: barColor }} />
        </div>
        {pct >= 100 && (
          <p className="mt-3 text-xs text-[hsl(8_60%_70%)]">You've hit the daily cap. Runs pause automatically until it resets at 00:00 UTC.</p>
        )}
      </div>

      {/* Last 30 days */}
      <div className="rounded-lg border border-border bg-surface-2 p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Last 30 days</span>
          <span className="font-mono text-xs text-foreground">${total30.toFixed(2)} total</span>
        </div>
        {days.length === 0 ? (
          <p className="text-sm text-muted-foreground">No spend yet. The board hasn't cost you a cent.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full font-mono text-xs">
              <tbody>
                {days.map(([day, sum]) => (
                  <tr key={day} className="border-t border-border/40 first:border-t-0">
                    <td className="py-1.5 text-muted-foreground">{day}</td>
                    <td className="py-1.5 text-right text-foreground">${sum.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* By project */}
      <div className="rounded-lg border border-border bg-surface-2 p-5">
        <span className="mb-3 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">By project · 30 days</span>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to attribute yet.</p>
        ) : (
          <div className="space-y-1.5">
            {projects.map(([pid, sum]) => (
              <div key={pid} className="flex items-baseline justify-between font-mono text-xs">
                <span className="truncate text-muted-foreground">{pid === "(no project)" ? pid : (projectNames[pid] ?? pid.slice(0, 8))}</span>
                <span className="text-foreground">${sum.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
