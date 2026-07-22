import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ArrowRight, Check, ScrollText, ShieldCheck } from "lucide-react";
import { CodeSourcePicker } from "@/components/code-source-picker";
import { GitHubRepoCard } from "@/components/github-repo-card";
import { ProjectJourney } from "@/components/project-journey";
import { useProjectJourney } from "@/hooks/use-project-journey";

export const Route = createFileRoute("/_authenticated/audits_/$projectId")({
  component: AuditCenterPage,
});

type Audit = {
  id: string;
  batch_id: string | null;
  kind: "batch" | "final_az";
  status: "running" | "clean" | "findings" | "failed";
  loop_no: number;
  source: "github" | "paste" | null;
  head_sha: string | null;
  files_analyzed: number | null;
  summary: {
    counts?: Record<string, number>;
    text?: string;
    validation_downgrades?: Array<{ title: string; file_path: string | null; from: string; to: string; reason: string }>;
  } | null;
  created_at: string;
  completed_at: string | null;
};

type Finding = {
  id: string;
  audit_id: string;
  severity: "P0" | "P1" | "P2" | "P3";
  file_path: string | null;
  title: string;
  description: string | null;
  evidence: string | null;
  confidence: "high" | "medium" | "low";
  line_start: number | null;
  line_end: number | null;
  status: "open" | "fix_drafted" | "resolved" | "dismissed";
  seat: string | null;
  fix_batch_id: string | null;
};

type Batch = { id: string; batch_no: number; title: string; status: string };

const SEV_STYLE: Record<Finding["severity"], string> = {
  P0: "border-[hsl(8_60%_55%/0.55)] bg-[hsl(8_60%_25%/0.35)] text-[hsl(8_60%_82%)]",
  P1: "border-[hsl(8_60%_55%/0.35)] bg-[hsl(8_60%_25%/0.2)] text-[hsl(8_60%_78%)]",
  P2: "border-primary/35 bg-primary/10 text-[hsl(38_65%_75%)]",
  P3: "border-border bg-surface-2 text-muted-foreground",
};

function AuditCenterPage() {
  const { projectId } = Route.useParams();
  const journey = useProjectJourney(projectId);
  const [projectName, setProjectName] = useState<string>("");
  const [isImport, setIsImport] = useState<boolean>(false);
  const [ghRepo, setGhRepo] = useState<string | null>(null);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasted, setPasted] = useState("");

  const load = useCallback(async () => {
    const [{ data: p }, { data: au }, { data: bs }] = await Promise.all([
      supabase.from("projects").select("name, is_import, github_repo").eq("id", projectId).maybeSingle(),
      supabase.from("audits").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
      supabase.from("batches").select("id, batch_no, title, status").eq("project_id", projectId).order("batch_no", { ascending: true }),
    ]);
    const proj = p as { name?: string; is_import?: boolean; github_repo?: string | null } | null;
    setProjectName(proj?.name ?? "");
    setIsImport(!!proj?.is_import);
    setGhRepo(proj?.github_repo ?? null);
    const auditRows = (au ?? []) as Audit[];
    setAudits(auditRows);
    setBatches((bs ?? []) as Batch[]);
    // Scope findings to THIS project's audits only. Never issue an unfiltered
    // audit_findings query — RLS returns just this owner's rows, but pulling
    // every one of them for a single project view is wasteful and leaks
    // cross-project noise into the realtime handler.
    const auditIds = auditRows.map((a) => a.id);
    if (auditIds.length === 0) {
      setFindings([]);
    } else {
      const { data: fi } = await supabase
        .from("audit_findings")
        .select("*")
        .in("audit_id", auditIds)
        .order("severity", { ascending: true });
      setFindings((fi ?? []) as Finding[]);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const ch = supabase
      .channel(`audits-center:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "audits", filter: `project_id=eq.${projectId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "audit_findings" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [projectId, load]);

  async function startFinalAudit(source: "github" | "paste") {
    if (starting) return;
    setStarting(true);
    try {
      const payload: Record<string, unknown> = { action: "start_final_audit", project_id: projectId, source };
      if (source === "paste") payload.pasted_code = pasted;
      const { data, error } = await supabase.functions.invoke("audit-runner", { body: payload });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("The board is reading your code.");
      setShowPaste(false);
      setPasted("");
      load();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to start audit");
    } finally {
      setStarting(false);
    }
  }


  const batchAudits = useMemo(() => audits.filter((a) => a.kind === "batch"), [audits]);
  const finalAudit = useMemo(() => audits.find((a) => a.kind === "final_az") ?? null, [audits]);
  const findingsByAudit = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = m.get(f.audit_id) ?? [];
      list.push(f);
      m.set(f.audit_id, list);
    }
    return m;
  }, [findings]);

  const openFindings = useMemo(
    () => findings.filter((f) => f.status === "open" || f.status === "fix_drafted"),
    [findings],
  );

  async function dismiss(f: Finding) {
    if (f.severity !== "P2" && f.severity !== "P3") {
      toast.error("P0/P1 findings resolve only through re-audit.");
      return;
    }
    const { error } = await supabase.from("audit_findings").update({ status: "dismissed" }).eq("id", f.id);
    if (error) toast.error(error.message);
    else load();
  }

  if (loading) return <div className="mx-auto max-w-5xl px-6 py-14"><div className="h-32 animate-pulse rounded-xl bg-surface-1" /></div>;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 md:px-10 md:py-14">
      <Link to="/audits" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">← Audits</Link>
      <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{projectName || "Project"}</h1>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">The audit ledger</p>
      {journey && (
        <div className="mt-4 mb-2">
          <ProjectJourney stages={journey} />
        </div>
      )}

      {/* Open findings */}
      <section className="mt-10">
        <h2 className="font-display text-xl text-foreground">Open findings</h2>
        {openFindings.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">The board has no open issues for you right now.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {openFindings.map((f) => (
              <div key={f.id} className="rounded-lg border border-border bg-surface-1 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${SEV_STYLE[f.severity]}`}>
                    {f.severity}
                  </span>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
                    f.confidence === "high" ? "border-[hsl(160_45%_48%/0.4)] text-[hsl(160_45%_72%)] bg-[hsl(160_45%_28%/0.15)]"
                    : f.confidence === "low" ? "border-border text-muted-foreground bg-surface-2"
                    : "border-primary/35 text-[hsl(38_65%_75%)] bg-primary/10"
                  }`}>
                    {f.confidence} confidence
                  </span>
                  {f.seat && <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{f.seat}</span>}
                  {f.file_path && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {f.file_path}
                      {f.line_start ? `:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ""}` : ""}
                    </span>
                  )}
                  {f.status === "fix_drafted" && (
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[hsl(38_65%_72%)]">Fix batch drafted</span>
                  )}
                </div>
                <p className="mt-2 text-sm text-foreground">{f.title}</p>
                {f.description && <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>}
                {f.evidence && (
                  <p className="mt-2 border-l border-border pl-3 font-mono text-[11px] text-muted-foreground/90">
                    Evidence — {f.evidence}
                  </p>
                )}
                {(f.severity === "P2" || f.severity === "P3") && f.status === "open" && (
                  <button
                    onClick={() => dismiss(f)}
                    className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Per-batch history */}
      <section className="mt-12">
        <h2 className="font-display text-xl text-foreground">Per-batch history</h2>
        {batchAudits.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No batch audits yet. Ship a batch and run the audit.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {batchAudits.map((a) => {
              const b = batches.find((x) => x.id === a.batch_id);
              const fs = findingsByAudit.get(a.id) ?? [];
              return (
                <div key={a.id} className="rounded-lg border border-border bg-surface-1 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {b ? `Batch ${b.batch_no}` : "Batch"} · loop {a.loop_no}
                    </span>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
                      a.status === "clean" ? "border-[hsl(160_45%_48%/0.4)] text-[hsl(160_45%_70%)] bg-[hsl(160_45%_28%/0.15)]"
                      : a.status === "findings" ? "border-[hsl(8_60%_55%/0.4)] text-[hsl(8_60%_75%)] bg-[hsl(8_60%_25%/0.15)]"
                      : "border-border text-muted-foreground bg-surface-2"
                    }`}>
                      {a.status}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                      {a.source ?? "—"} · {a.files_analyzed ?? 0} files
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {new Date(a.created_at).toLocaleString()}
                    </span>
                  </div>
                  {b && <p className="mt-1 text-sm text-foreground">{b.title}</p>}
                  {fs.length > 0 && (
                    <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                      {(["P0","P1","P2","P3"] as const).map((s) => {
                        const n = fs.filter((f) => f.severity === s).length;
                        return n ? `${n} ${s} ` : null;
                      })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Final A-Z */}
      <section className="mt-12">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[hsl(38_65%_70%)]" />
          <h2 className="font-display text-xl text-foreground">Final A–Z audit</h2>
        </div>
        {!finalAudit ? (
          <div className="mt-3 space-y-3">
            {isImport ? (
              <p className="text-sm text-muted-foreground">
                Eligible now — link your repo (or paste your code below) and the board reads it end-to-end.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Eligible once every batch has passed or been skipped. Start it from the Runway.
              </p>
            )}
            {isImport && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => startFinalAudit("github")}
                  disabled={starting || !ghRepo}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
                >
                  {starting ? "Opening the audit…" : ghRepo ? "Run the A–Z audit" : "Link a repo first"}
                </button>
                <button
                  onClick={() => setShowPaste((v) => !v)}
                  className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground hover:border-primary/40"
                >
                  {showPaste ? "Cancel paste" : "Paste code instead"}
                </button>
              </div>
            )}
            {isImport && !ghRepo && (
              <GitHubRepoCard
                projectId={projectId}
                isOwner={true}
                onLinked={(fullName) => setGhRepo(fullName)}
              />
            )}
            {isImport && showPaste && (
              <div className="rounded-lg border border-border bg-surface-1 p-4">
                <CodeSourcePicker value={pasted} onChange={setPasted} maxBytes={5_000_000} />
                <button
                  onClick={() => startFinalAudit("paste")}
                  disabled={starting || !pasted.trim()}
                  className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
                >
                  {starting ? "Opening the audit…" : "Run the A–Z audit on this code"}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-border bg-surface-1 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
                finalAudit.status === "clean" ? "border-[hsl(160_45%_48%/0.4)] text-[hsl(160_45%_70%)] bg-[hsl(160_45%_28%/0.15)]"
                : finalAudit.status === "findings" ? "border-[hsl(8_60%_55%/0.4)] text-[hsl(8_60%_75%)] bg-[hsl(8_60%_25%/0.15)]"
                : "border-border text-muted-foreground bg-surface-2"
              }`}>
                {finalAudit.status}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {finalAudit.source ?? "—"} · {finalAudit.files_analyzed ?? 0} files
              </span>
            </div>
            {finalAudit.summary?.text && <p className="mt-3 text-sm text-foreground/85">{finalAudit.summary.text}</p>}
            {finalAudit.summary?.validation_downgrades && finalAudit.summary.validation_downgrades.length > 0 && (
              <div className="mt-4 rounded-md border border-border/60 bg-surface-2 p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  Downgraded by the board — {finalAudit.summary.validation_downgrades.length} unsupported serious claim(s) rescored
                </p>
                <ul className="mt-2 space-y-1">
                  {finalAudit.summary.validation_downgrades.map((d, i) => (
                    <li key={i} className="font-mono text-[11px] text-muted-foreground">
                      <span className="text-[hsl(38_65%_72%)]">{d.from} → {d.to}</span>
                      {" · "}{d.title}
                      {d.file_path ? ` (${d.file_path})` : ""}
                      {" · "}{d.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {finalAudit.status === "clean" && !isImport && (
              <p className="mt-3 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-[hsl(160_45%_70%)]">
                <Check className="h-4 w-4" /> Passed A–Z. Ship it.
              </p>
            )}
            {finalAudit.status === "clean" && isImport && (
              <p className="mt-3 text-sm text-foreground/85">
                Clean read. Convene the improvement board to plan what to build next.
              </p>
            )}
            <Link
              to={isImport ? "/boardroom/$projectId" : "/runway/$projectId"}
              params={{ projectId }}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground hover:border-primary/40"
            >
              {isImport ? "To the Boardroom" : "Back to the Runway"} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}

      </section>
    </div>
  );
}
