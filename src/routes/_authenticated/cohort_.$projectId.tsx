import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardroomSession } from "@/components/boardroom-session";
import { ArrowLeft, Github, Lock, ScrollText, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/cohort_/$projectId")({
  beforeLoad: async () => {
    // See cohort.tsx — canonical user_roles / has_role gate, RLS remains
    // the real boundary, transient auth/role failures fail closed.
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) throw redirect({ to: "/dashboard" });
    const uid = userData.user.id;
    const [{ data: isAdmin, error: aErr }, { data: isInstructor, error: iErr }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: uid, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: uid, _role: "instructor" }),
    ]);
    if (aErr || iErr) throw redirect({ to: "/dashboard" });
    if (!isAdmin && !isInstructor) throw redirect({ to: "/dashboard" });
  },
  component: CohortProjectPage,
});

type ProjectRow = {
  id: string;
  name: string;
  status: string;
  user_id: string;
  is_import: boolean;
  github_repo: string | null;
  current_batch_no: number;
  created_at: string;
};

type BatchRow = {
  id: string;
  batch_no: number;
  title: string;
  channel: string;
  status: string;
  is_fix: boolean;
};

type FindingRow = {
  id: string;
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  file_path: string | null;
  status: string;
};

const SEVERITY_TONE: Record<string, string> = {
  P0: "text-[hsl(8_60%_55%)] border-[hsl(8_60%_55%)]/40 bg-[hsl(8_60%_55%)]/10",
  P1: "text-[hsl(8_60%_55%)] border-[hsl(8_60%_55%)]/40 bg-[hsl(8_60%_55%)]/10",
  P2: "text-[hsl(38_65%_55%)] border-[hsl(38_65%_55%)]/40 bg-[hsl(38_65%_55%)]/10",
  P3: "text-muted-foreground border-border/40",
};

function CohortProjectPage() {
  const { projectId } = Route.useParams();
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [tab, setTab] = useState<"plan" | "design" | "batches" | "audits">("plan");

  const load = useCallback(async () => {
    const { data: p } = await supabase
      .from("projects")
      .select("id, name, status, user_id, is_import, github_repo, current_batch_no, created_at")
      .eq("id", projectId)
      .maybeSingle();
    setProject((p as any) ?? null);
    if (p) {
      const { data: prof } = await supabase.from("profiles").select("display_name").eq("id", (p as any).user_id).maybeSingle();
      setOwner((prof as any)?.display_name ?? null);
    }
    const { data: bs } = await supabase
      .from("batches")
      .select("id, batch_no, title, channel, status, is_fix")
      .eq("project_id", projectId)
      .order("batch_no");
    setBatches((bs ?? []) as any);

    const { data: fs } = await supabase
      .from("audit_findings")
      .select("id, severity, title, file_path, status, audits!inner(project_id)")
      .eq("audits.project_id", projectId)
      .in("status", ["open", "fix_drafted"])
      .order("severity");
    setFindings((fs ?? []) as any);
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (!project) {
    return <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link to="/cohort" className="mb-4 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Cohort
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
            {owner ?? "Member"} · {project.is_import ? "Import" : "Greenfield"}
          </p>
          <h1 className="font-display text-3xl leading-tight text-foreground">{project.name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Status <span className="text-foreground">{project.status}</span> · Batch {project.current_batch_no}
            {project.github_repo && (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Github className="h-3 w-3" /> {project.github_repo}
                </span>
              </>
            )}
          </p>
        </div>
        <span className="rounded-full border border-border/40 bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Read-only view
        </span>
      </div>

      <div className="mb-6 flex gap-1 border-b border-border/40">
        {(["plan", "design", "batches", "audits"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm capitalize transition-colors ${
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "plan" && (
        <div className="rounded-xl border border-border/40 bg-surface-1 p-1">
          <BoardroomSession
            projectId={projectId}
            kind="plan"
            rubric={[
              "painful_problem", "reachable_buyer", "monetization_path",
              "buildable_scope", "differentiation", "wow_factor",
            ]}
            conveneLabel="Convene the board"
            runningTitle="The board is in session"
            emptyTitle="No plan session yet."
            emptySubtitle="The student hasn't convened the board."
            readOnly
          />
        </div>
      )}

      {tab === "design" && (
        <div className="rounded-xl border border-border/40 bg-surface-1 p-1">
          <BoardroomSession
            projectId={projectId}
            kind="design"
            rubric={[
              "distinctiveness", "premium_feel", "usability",
              "buildable_in_lovable", "coherence", "signature_element",
            ]}
            conveneLabel="Convene the Design Council"
            runningTitle="The Design Council is in session"
            emptyTitle="No design session yet."
            emptySubtitle="The student hasn't convened the Design Council."
            readOnly
          />
        </div>
      )}

      {tab === "batches" && (
        <div className="rounded-xl border border-border/40 bg-surface-1">
          {batches.length === 0 ? (
            <div className="flex items-center gap-3 p-8 text-sm text-muted-foreground">
              <ScrollText className="h-4 w-4" />
              No batches yet.
            </div>
          ) : (
            <ul className="divide-y divide-border/20">
              {batches.map((b) => (
                <li key={b.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="text-foreground">
                      <span className="font-mono text-muted-foreground">#{b.batch_no}</span>{" "}
                      {b.title}
                      {b.is_fix && (
                        <span className="ml-2 rounded-full border border-[hsl(8_60%_55%)]/40 px-2 py-0.5 font-mono text-[9px] uppercase text-[hsl(8_60%_55%)]">
                          fix
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                      {b.channel}
                    </p>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                    {b.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "audits" && (
        <div className="rounded-xl border border-border/40 bg-surface-1">
          {findings.length === 0 ? (
            <div className="flex items-center gap-3 p-8 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-[hsl(160_45%_48%)]" /> No open findings.
            </div>
          ) : (
            <ul className="divide-y divide-border/20">
              {findings.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-foreground">{f.title}</p>
                    {f.file_path && (
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{f.file_path}</p>
                    )}
                  </div>
                  <span className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase ${SEVERITY_TONE[f.severity]}`}>
                    {f.severity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {project.status === "locked" && (
        <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" /> Plan is locked · view the workspace at{" "}
          <Link to="/plan/$projectId" params={{ projectId }} className="text-foreground hover:text-primary">
            /plan
          </Link>
        </div>
      )}
    </div>
  );
}
