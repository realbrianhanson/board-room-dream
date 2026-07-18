import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

type Project = {
  id: string;
  name: string;
  status: string;
  current_batch_no: number;
  created_at: string;
  has_design?: boolean;
};

const NEXT_ACTION: Record<string, string> = {
  intake: "Finish the intake",
  validated: "Enter the boardroom",
  boardroom: "Continue the debate",
  locked: "Review your locked plan",
  building: "Ship the next batch",
  auditing: "Review findings",
  polishing: "Approve the polish",
  done: "Publish",
  killed: "Revise the idea",
};

function nextActionLabel(p: Project): string {
  if (p.status === "locked" && !p.has_design) return "Convene the Design Council";
  return NEXT_ACTION[p.status] ?? "Open";
}

const STATUS_COLOR: Record<string, string> = {
  intake: "hsl(40 10% 62%)",
  validated: "hsl(38 65% 55%)",
  boardroom: "hsl(38 65% 55%)",
  locked: "hsl(38 65% 55%)",
  building: "hsl(205 60% 55%)",
  auditing: "hsl(160 45% 48%)",
  polishing: "hsl(38 65% 55%)",
  done: "hsl(160 45% 48%)",
  killed: "hsl(8 60% 55%)",
};

const STATUS_FILL: Record<string, number> = {
  intake: 0.15,
  validated: 0.35,
  boardroom: 0.45,
  locked: 0.55,
  building: 0.7,
  auditing: 0.8,
  polishing: 0.9,
  done: 1,
  killed: 1,
};

function MiniRing({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "hsl(40 10% 62%)";
  const fill = STATUS_FILL[status] ?? 0.1;
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r={r} fill="none" stroke="hsl(40 15% 24% / 0.5)" strokeWidth="2" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fill)}
        strokeLinecap="round"
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

function DashboardPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");

  async function load() {
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, status, current_batch_no, created_at")
      .order("created_at", { ascending: false });
    if (error) {
      toast.error(error.message);
      setProjects([]);
      return;
    }
    const rows = (data ?? []) as Project[];
    const lockedIds = rows.filter((r) => r.status === "locked").map((r) => r.id);
    let designSet = new Set<string>();
    if (lockedIds.length) {
      const { data: pvs } = await supabase
        .from("plan_versions")
        .select("project_id")
        .eq("kind", "design")
        .in("project_id", lockedIds);
      designSet = new Set((pvs ?? []).map((r: any) => r.project_id));
    }
    setProjects(rows.map((r) => ({ ...r, has_design: designSet.has(r.id) })));
  }
  useEffect(() => {
    load();
  }, []);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const uid = userData.user.id;
      const { data: proj, error: pErr } = await supabase
        .from("projects")
        .insert({ user_id: uid, name: name.trim(), status: "intake" })
        .select("id")
        .single();
      if (pErr) throw pErr;
      const { data: intake, error: iErr } = await supabase
        .from("intakes")
        .insert({ project_id: proj.id, user_id: uid, answers: {} })
        .select("id")
        .single();
      if (iErr) throw iErr;
      navigate({ to: "/intake/$intakeId", params: { intakeId: intake.id } });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12 md:py-16">
      <div className="flex items-end justify-between gap-4">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Dashboard
          </span>
          <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">
            Your desk.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Every idea you bring the board lives here, from first intake to final ship.
          </p>
        </div>
        {!showNew && (
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            <Plus className="h-4 w-4" />
            New project
          </button>
        )}
      </div>

      {showNew && (
        <form
          onSubmit={createProject}
          className="mt-8 rounded-xl border border-border bg-surface-1 p-6"
        >
          <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Project name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Working title — you can rename later"
            className="w-full rounded-md border border-border bg-surface-2 px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
          />
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              {creating ? "Opening intake…" : "Start intake"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNew(false);
                setName("");
              }}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-10">
        {projects === null ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-surface-1" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
            <p className="font-display text-2xl text-foreground">No projects yet.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Bring the board an idea.
            </p>
            {!showNew && (
              <button
                onClick={() => setShowNew(true)}
                className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
              >
                <Plus className="h-4 w-4" />
                New project
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} onOpen={(id) => resume(id, p.status, navigate)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

async function resume(
  projectId: string,
  status: string,
  navigate: ReturnType<typeof useNavigate>,
) {
  if (status === "intake" || status === "validated" || status === "killed") {
    const { data } = await supabase
      .from("intakes")
      .select("id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      navigate({ to: "/intake/$intakeId", params: { intakeId: data.id } });
      return;
    }
  }
  if (status === "locked") {
    const { data: design } = await supabase
      .from("plan_versions")
      .select("id")
      .eq("project_id", projectId)
      .eq("kind", "design")
      .limit(1)
      .maybeSingle();
    if (!design) {
      navigate({ to: "/design/$projectId", params: { projectId } });
      return;
    }
    navigate({ to: "/plan/$projectId", params: { projectId } });
    return;
  }
  navigate({ to: "/boardroom/$projectId", params: { projectId } });
}

function ProjectCard({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onOpen(project.id)}
      className="group flex flex-col items-start rounded-xl border border-border bg-surface-1 p-6 text-left transition-colors hover:border-primary/40 hover:bg-surface-2"
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-lg text-foreground">{project.name}</h3>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            {project.status}
            {project.current_batch_no > 0 && ` · batch ${project.current_batch_no}`}
          </p>
        </div>
        <MiniRing status={project.status} />
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Created {new Date(project.created_at).toLocaleDateString()}
      </p>
      <span className="mt-3 inline-flex items-center gap-1.5 text-xs text-foreground/80 group-hover:text-primary">
        {NEXT_ACTION[project.status] ?? "Open"}
        <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}
