import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus, ArrowRight, Lightbulb, Package, Trash2 } from "lucide-react";
import { ProjectJourney } from "@/components/project-journey";
import { buildJourney } from "@/lib/project-journey";
import { classifyAudits, parseTimestamp } from "@/lib/audit-classification";
import { projectStatusLine } from "@/lib/project-status-line";
import {
  isImportCoreReady,
  missingImportFields,
  normalizeStrategyForPersist,
  RECOMMEND_PLACEHOLDER,
  STRATEGY_FIELD_LABELS,
  type ImportStrategyInput,
  type StrategyField,
} from "@/lib/import-strategy";
import { initialModeFromSearch } from "@/lib/dashboard-search";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";



export const Route = createFileRoute("/_authenticated/dashboard")({
  // Lightweight validator — tolerate any value; the pure helper below decides
  // whether it actually opens a form. Never throws on unknown input.
  validateSearch: (raw: Record<string, unknown>): { new?: string } => ({
    new: typeof raw.new === "string" ? raw.new : undefined,
  }),
  component: DashboardPage,
});

type Project = {
  id: string;
  name: string;
  status: string;
  current_batch_no: number;
  created_at: string;
  is_import?: boolean;
  github_repo?: string | null;
  has_design?: boolean;
  has_batches?: boolean;
  has_fix_needed?: boolean;
  fix_batch_no?: number;
  all_passed?: boolean;
  has_final_audit?: boolean;
  has_import_audit?: boolean;
  has_locked_plan?: boolean;
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
  imported: "Set up the audit",
};

function nextActionLabel(p: Project): string {
  if (p.is_import) {
    if (!p.github_repo) return "Link your repo so the board can read the code";
    // Imports gate the Boardroom on the pre-plan A–Z audit specifically.
    if (!p.has_import_audit) return "Run the A–Z audit";
    if (!p.has_locked_plan) return "Convene the improvement board";
  }
  if (p.status === "locked" && !p.has_design) return "Convene the Design Council";
  if (p.status === "locked" && p.has_design && !p.has_batches) return "Generate your build sequence";
  if (p.has_fix_needed) return `The board found issues — Batch ${p.fix_batch_no} waiting`;
  if (p.status === "auditing" && p.all_passed && !p.has_final_audit) return "Run the A–Z audit";
  if (p.status === "done") return "Passed A–Z. Ship it.";
  if (p.status === "building" && p.current_batch_no > 0) return `Continue the Runway — Batch ${p.current_batch_no}`;
  if (p.status === "building") return "Continue the Runway";
  return NEXT_ACTION[p.status] ?? "Open";
}


const STATUS_COLOR: Record<string, string> = {
  intake: "hsl(40 10% 62%)",
  validated: "hsl(var(--primary))",
  boardroom: "hsl(var(--primary))",
  locked: "hsl(var(--primary))",
  building: "hsl(var(--info))",
  auditing: "hsl(var(--success))",
  polishing: "hsl(var(--primary))",
  done: "hsl(var(--success))",
  killed: "hsl(var(--destructive))",
  imported: "hsl(var(--primary))",
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
  imported: 0.2,
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

type NewMode = null | "chooser" | "idea" | "import";
const IMPORT_GOAL_OPTIONS = [
  { value: "code_audit", label: "Code audit" },
  { value: "design_review", label: "Design review" },
  { value: "improvements", label: "Improvements & missing features" },
] as const;

function DashboardPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<NewMode>(() => initialModeFromSearch(search.new));

  // Auto-open the form when arriving from Onboarding, then clear the search
  // param so a browser refresh does not re-open the form.
  useEffect(() => {
    const initial = initialModeFromSearch(search.new);
    if (initial) {
      setMode(initial);
      navigate({ to: "/dashboard", search: {}, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "New idea" form
  const [name, setName] = useState("");

  // "Existing app" form — core identity
  const [impName, setImpName] = useState("");
  const [impDescription, setImpDescription] = useState("");
  const [impUrl, setImpUrl] = useState("");
  const [impGoals, setImpGoals] = useState<string[]>(["code_audit"]);
  // "Existing app" form — optional strategy
  const [impBuyer, setImpBuyer] = useState("");
  const [impAcquisitionChannel, setImpAcquisitionChannel] = useState("");
  const [impPaidOffer, setImpPaidOffer] = useState("");
  const [impPriceAnchor, setImpPriceAnchor] = useState("");
  const [impUpgradeTrigger, setImpUpgradeTrigger] = useState("");
  const [impActivation, setImpActivation] = useState("");
  const [impWow, setImpWow] = useState("");
  const [impPositioning, setImpPositioning] = useState("");

  function resetForms() {
    setMode(null);
    setName("");
    setImpName("");
    setImpDescription("");
    setImpUrl("");
    setImpGoals(["code_audit"]);
    setImpBuyer("");
    setImpAcquisitionChannel("");
    setImpPaidOffer("");
    setImpPriceAnchor("");
    setImpUpgradeTrigger("");
    setImpActivation("");
    setImpWow("");
    setImpPositioning("");
  }

  async function load() {
    setLoadError(null);
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, status, current_batch_no, created_at, is_import, github_repo, lovable_project_url")
      .order("created_at", { ascending: false });
    if (error) {
      // Do NOT collapse a query failure into the empty state. That would
      // hide a retryable network/RLS problem behind "No projects yet.".
      toast.error(error.message);
      setLoadError(error.message);
      return;
    }
    const rows = (data ?? []) as Project[];
    const ids = rows.map((r) => r.id);
    const designSet = new Set<string>();
    const batchSet = new Set<string>();
    const planSet = new Set<string>();
    const fixInfo = new Map<string, number>();
    const allPassedSet = new Set<string>();
    const importAuditSet = new Set<string>();
    const finalAuditSet = new Set<string>();
    if (ids.length) {
      const [pvsRes, bsRes, auRes] = await Promise.all([
        supabase.from("plan_versions").select("project_id, kind, locked_at").in("project_id", ids).eq("is_build_safe", true),
        supabase.from("batches").select("project_id, batch_no, status, built_at, sent_at, created_at").in("project_id", ids),
        supabase.from("audits").select("project_id, kind, status, created_at").in("project_id", ids).eq("kind", "final_az").in("status", ["clean", "findings"]),
      ]);
      // Secondary query failure MUST surface as a load error — silently
      // computing all-false stages here is what recreated the wrong
      // "shipped" journey. Bail out and let the user retry.
      if (pvsRes.error || bsRes.error || auRes.error) {
        const msg = pvsRes.error?.message ?? bsRes.error?.message ?? auRes.error?.message ?? "Failed to load project stages";
        toast.error(msg);
        setLoadError(msg);
        return;
      }
      const planLockedAt = new Map<string, number | null>();
      for (const r of (pvsRes.data ?? []) as Array<{ project_id: string; kind: string; locked_at: string }>) {
        if (r.kind === "design") designSet.add(r.project_id);
        if (r.kind === "plan") {
          planSet.add(r.project_id);
          planLockedAt.set(r.project_id, parseTimestamp(r.locked_at));
        }
      }

      const byProject = new Map<
        string,
        Array<{ batch_no: number; status: string; built_at: string | null; sent_at: string | null; created_at: string | null }>
      >();
      for (const r of (bsRes.data ?? []) as Array<{
        project_id: string;
        batch_no: number;
        status: string;
        built_at: string | null;
        sent_at: string | null;
        created_at: string | null;
      }>) {
        batchSet.add(r.project_id);
        const list = byProject.get(r.project_id) ?? [];
        list.push({
          batch_no: r.batch_no,
          status: r.status,
          built_at: r.built_at,
          sent_at: r.sent_at,
          created_at: r.created_at,
        });
        byProject.set(r.project_id, list);
      }
      for (const [pid, list] of byProject) {
        const fix = list.find((x) => x.status === "fix_needed");
        if (fix) fixInfo.set(pid, fix.batch_no);
        if (list.length > 0 && list.every((x) => x.status === "passed" || x.status === "skipped")) {
          allPassedSet.add(pid);
        }
      }
      // Group audits by project and run the SAME classifier the hook uses,
      // so dashboard + boardroom/design/audit/runway pages can never drift
      // on what counts as pre-plan vs post-build audit evidence.
      const auditsByProject = new Map<string, Array<{ status: string; created_at: string }>>();
      for (const r of (auRes.data ?? []) as Array<{ project_id: string; status: string; created_at: string }>) {
        const list = auditsByProject.get(r.project_id) ?? [];
        list.push({ status: r.status, created_at: r.created_at });
        auditsByProject.set(r.project_id, list);
      }
      for (const pid of ids) {
        const { has_import_audit, has_final_audit } = classifyAudits({
          audits: auditsByProject.get(pid) ?? [],
          planLockedAt: planLockedAt.get(pid) ?? null,
          batches: byProject.get(pid) ?? [],
        });
        if (has_import_audit) importAuditSet.add(pid);
        if (has_final_audit) finalAuditSet.add(pid);
      }
    }
    setProjects(
      rows.map((r) => ({
        ...r,
        has_design: designSet.has(r.id),
        has_batches: batchSet.has(r.id),
        has_locked_plan: planSet.has(r.id),
        has_fix_needed: fixInfo.has(r.id),
        fix_batch_no: fixInfo.get(r.id),
        all_passed: allPassedSet.has(r.id),
        has_import_audit: importAuditSet.has(r.id),
        has_final_audit: finalAuditSet.has(r.id),
      }) as Project),
    );
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

  const strategyValues: ImportStrategyInput = {
    buyer: impBuyer,
    acquisition_channel: impAcquisitionChannel,
    paid_offer: impPaidOffer,
    price_anchor: impPriceAnchor,
    upgrade_trigger: impUpgradeTrigger,
    activation_moment: impActivation,
    wow_moment: impWow,
    positioning: impPositioning,
  };
  // Fast-import gate: only the three identity fields are required to CREATE
  // the project. Six required strategy fields (buyer, acquisition_channel,
  // paid_offer, activation_moment, wow_moment, positioning) are required
  // before the A–Z audit itself can start. Price anchor and upgrade trigger
  // are optional owner decisions — blank stays blank; the board never
  // invents monetization answers. (Enforced in Audit Center UI + server gate.)
  const importCoreReady = isImportCoreReady({
    name: impName,
    description: impDescription,
    goals: impGoals,
  });
  const importMissingStrategy = missingImportFields(strategyValues);


  async function createImport(e: React.FormEvent) {
    e.preventDefault();
    if (!importCoreReady) return;
    setCreating(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const uid = userData.user.id;
      const { data: proj, error: pErr } = await supabase
        .from("projects")
        .insert({
          user_id: uid,
          name: impName.trim(),
          status: "imported",
          is_import: true,
          lovable_project_url: impUrl.trim() || null,
        })
        .select("id")
        .single();
      if (pErr) throw pErr;
      // Blanks persist as empty strings so downstream code treats them as
      // explicit missing owner input rather than fabricated placeholder
      // claims. The audit page has a compact editor to fill them in later.
      const strategy = normalizeStrategyForPersist({
        buyer: impBuyer,
        acquisition_channel: impAcquisitionChannel,
        paid_offer: impPaidOffer,
        price_anchor: impPriceAnchor,
        upgrade_trigger: impUpgradeTrigger,
        activation_moment: impActivation,
        wow_moment: impWow,
        positioning: impPositioning,
      });
      const { error: iErr } = await supabase.from("intakes").insert({
        project_id: proj.id,
        user_id: uid,
        answers: {
          imported: true,
          description: impDescription.trim(),
          lovable_project_url: impUrl.trim() || null,
          goals: impGoals,
          ...strategy,
        },
      });
      if (iErr) throw iErr;
      toast.success(
        "Project opened. Fill in strategy context and link GitHub in the Audit Center — the A–Z audit requires credible owner context on the six required strategy fields. Price and upgrade trigger are optional owner decisions.",
      );

      const newProjectId = proj.id;
      resetForms();
      await load();
      navigate({ to: "/audits/$projectId", params: { projectId: newProjectId } });
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
            App Blueprint
          </span>
          <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">
            Dashboard
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Every idea you bring the board lives here, from first intake to final ship.
          </p>
        </div>
        {mode === null && (
          <button
            onClick={() => setMode("chooser")}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            <Plus className="h-4 w-4" />
            New project
          </button>
        )}
      </div>

      {mode === "chooser" && (
        <div className="mt-8 rounded-xl border border-border bg-surface-1 p-6">
          <div className="mb-5 flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              What are you bringing the board?
            </p>
            <button
              type="button"
              onClick={resetForms}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <button
              type="button"
              onClick={() => setMode("idea")}
              className="group flex h-full flex-col items-start rounded-xl border border-border bg-surface-2 p-5 text-left transition-colors hover:border-primary/50"
            >
              <Lightbulb className="mb-3 h-5 w-5 text-primary" />
              <h3 className="font-display text-lg text-foreground">New idea</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                The board debates it, scores it, and locks a plan you can build.
              </p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-xs text-foreground/80 group-hover:text-primary">
                Start the intake <ArrowRight className="h-3 w-3" />
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode("import")}
              className="group flex h-full flex-col items-start rounded-xl border border-border bg-surface-2 p-5 text-left transition-colors hover:border-primary/50"
            >
              <Package className="mb-3 h-5 w-5 text-primary" />
              <h3 className="font-display text-lg text-foreground">Existing app</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Bring code you already built — the board audits it and drafts what to fix next.
              </p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-xs text-foreground/80 group-hover:text-primary">
                Import a project <ArrowRight className="h-3 w-3" />
              </span>
            </button>
          </div>
        </div>
      )}

      {mode === "idea" && (
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
              onClick={resetForms}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Back
            </button>
          </div>
        </form>
      )}

      {mode === "import" && (
        <form
          onSubmit={createImport}
          className="mt-8 space-y-5 rounded-xl border border-border bg-surface-1 p-6"
        >
          <div>
            <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              App name
            </label>
            <input
              autoFocus
              value={impName}
              onChange={(e) => setImpName(e.target.value)}
              placeholder="What do you call it?"
              className="w-full rounded-md border border-border bg-surface-2 px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              What does it do?
            </label>
            <textarea
              value={impDescription}
              onChange={(e) => setImpDescription(e.target.value)}
              placeholder="Plain words — what the app is, who uses it, what it does for them."
              rows={4}
              className="w-full resize-none rounded-md border border-border bg-surface-2 px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              Lovable project URL (optional)
            </label>
            <input
              value={impUrl}
              onChange={(e) => setImpUrl(e.target.value)}
              placeholder="https://lovable.dev/projects/..."
              className="w-full rounded-md border border-border bg-surface-2 px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              What do you want from the board?
            </label>
            <div className="flex flex-wrap gap-2">
              {IMPORT_GOAL_OPTIONS.map((g) => {
                const on = impGoals.includes(g.value);
                return (
                  <button
                    key={g.value}
                    type="button"
                    onClick={() =>
                      setImpGoals((prev) =>
                        prev.includes(g.value) ? prev.filter((v) => v !== g.value) : [...prev, g.value],
                      )
                    }
                    className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                      on
                        ? "border-primary/60 bg-primary/15 text-foreground"
                        : "border-border bg-surface-2 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    }`}
                  >
                    {g.label}
                  </button>
                );
              })}
            </div>
          </div>
          <details className="rounded-lg border border-border bg-surface-2/40 p-4">
            <summary className="cursor-pointer list-none">
              <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
                Strategy context — 6 required + 2 optional owner decisions
              </span>
              <p className="mt-2 text-xs text-muted-foreground">
                You can open the project now and fill these in from the Audit
                Center. Six required fields (buyer, acquisition channel, paid
                offer, activation moment, wow moment, positioning) must carry
                credible owner context before the A–Z audit runs. Price anchor
                and upgrade trigger are optional owner monetization decisions —
                leave them blank to defer, or tap
                <span className="mx-1 font-mono text-foreground/80">Board should recommend</span>
                if you'd rather have the board propose one. Blanks stay blank
                and the board never invents a price or upgrade path.
              </p>
            </summary>
            <div className="mt-4 space-y-4">
              <ImportStrategyField
                label="Buyer — who uses and pays"
                value={impBuyer}
                onChange={setImpBuyer}
                placeholder="Independent finance advisers running solo practices"
              />
              <ImportStrategyField
                label="Acquisition channel — where can you reach the first 10 buyers in 30 days?"
                value={impAcquisitionChannel}
                onChange={setImpAcquisitionChannel}
                placeholder="LinkedIn DMs to advisers I already follow · niche subreddit · industry Slack"
              />
              <ImportStrategyField
                label="Paid offer — what is paid for"
                value={impPaidOffer}
                onChange={setImpPaidOffer}
                placeholder="Weekly compliance briefing PDF · or 'internal/free'"
              />
              <ImportStrategyField
                label="Price anchor"
                value={impPriceAnchor}
                onChange={setImpPriceAnchor}
                placeholder='$29/mo'
                recommendable
                onRecommend={() => setImpPriceAnchor(RECOMMEND_PLACEHOLDER)}
              />
              <ImportStrategyField
                label="Upgrade trigger — buy, renew, or move up"
                value={impUpgradeTrigger}
                onChange={setImpUpgradeTrigger}
                placeholder="Monthly regulator update lands"
                recommendable
                onRecommend={() => setImpUpgradeTrigger(RECOMMEND_PLACEHOLDER)}
              />
              <ImportStrategyField
                label="Activation moment — first 90 seconds"
                value={impActivation}
                onChange={setImpActivation}
                placeholder="They paste one client scenario and see the flagged risks"
              />
              <ImportStrategyField
                label="Wow moment — the screenshot-worthy one"
                value={impWow}
                onChange={setImpWow}
                placeholder="The one-page risk summary they show a client"
              />
              <ImportStrategyField
                label='Positioning — "Unlike ___, this app ___"'
                value={impPositioning}
                onChange={setImpPositioning}
                placeholder="Unlike compliance PDFs, this app flags the client-specific risk in one glance."
              />
            </div>
          </details>
          {importCoreReady && importMissingStrategy.length > 0 && (
            <div
              role="status"
              className="rounded-md border border-border bg-surface-2/60 px-4 py-3 text-xs text-muted-foreground"
            >
              You can open the project now. Still needed before the A–Z audit can start:{" "}
              <span className="text-foreground">
                {importMissingStrategy
                  .map((f: StrategyField) => STRATEGY_FIELD_LABELS[f])
                  .join(", ")}
              </span>
              .
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating || !importCoreReady}
              data-testid="import-create-submit"
              className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              {creating ? "Opening…" : "Open the project"}
            </button>

            <button
              type="button"
              onClick={resetForms}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Back
            </button>
          </div>
        </form>
      )}

      <div className="mt-10">
        {loadError ? (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-6 py-6 text-sm text-destructive">
            <p className="font-medium">Couldn't load your projects.</p>
            <p className="mt-1 text-destructive/80">{loadError}</p>
            <button
              type="button"
              onClick={() => { void load(); }}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
            >
              Retry
            </button>
          </div>
        ) : projects === null ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-surface-1" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
            <p className="font-display text-2xl text-foreground">No projects yet.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Bring the board an idea — or an app you've already built.
            </p>
            {mode === null && (
              <button
                onClick={() => setMode("chooser")}
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
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={(id) => resume(id, p, navigate)}
                onDeleted={(id) =>
                  setProjects((prev) => (prev ?? []).filter((x) => x.id !== id))
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

async function resume(
  projectId: string,
  project: Project,
  navigate: ReturnType<typeof useNavigate>,
) {
  const status = project.status;
    if (project.is_import) {
    if (!project.github_repo) {
      navigate({ to: "/audits/$projectId", params: { projectId } });
      return;
    }
    if (!project.has_import_audit) {
      navigate({ to: "/audits/$projectId", params: { projectId } });
      return;
    }
    if (!project.has_locked_plan) {
      navigate({ to: "/boardroom/$projectId", params: { projectId } });
      return;
    }
    if (!project.has_design) {
      navigate({ to: "/design/$projectId", params: { projectId } });
      return;
    }
    if (!project.has_batches) {
      navigate({ to: "/runway/$projectId", params: { projectId } });
      return;
    }
    navigate({ to: "/runway/$projectId", params: { projectId } });
    return;
  }
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
    const [{ data: design }, { data: batch }] = await Promise.all([
      supabase.from("plan_versions").select("id").eq("project_id", projectId).eq("kind", "design").eq("is_build_safe", true).limit(1).maybeSingle(),
      supabase.from("batches").select("id").eq("project_id", projectId).limit(1).maybeSingle(),
    ]);
    if (!design) {
      navigate({ to: "/design/$projectId", params: { projectId } });
      return;
    }
    if (!batch) {
      navigate({ to: "/runway/$projectId", params: { projectId } });
      return;
    }
    navigate({ to: "/plan/$projectId", params: { projectId } });
    return;
  }
  if (status === "building" || status === "auditing") {
    navigate({ to: "/runway/$projectId", params: { projectId } });
    return;
  }
  navigate({ to: "/boardroom/$projectId", params: { projectId } });
}

function ProjectCard({
  project,
  onOpen,
  onDeleted,
}: {
  project: Project;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(project.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(project.id);
        }
      }}
      className="group relative flex cursor-pointer flex-col items-start rounded-xl border border-border bg-surface-1 p-6 text-left transition-colors hover:border-primary/40 hover:bg-surface-2 focus:outline-none focus-visible:border-primary/60"
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-display text-lg text-foreground">{project.name}</h3>
            {project.is_import && (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.22em] text-primary">
                Imported
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            {projectStatusLine(project)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MiniRing status={project.status} />
          <button
            type="button"
            aria-label="Delete project"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmOpen(true);
            }}
            className="rounded-md border border-transparent p-1.5 text-muted-foreground opacity-0 transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Created {new Date(project.created_at).toLocaleDateString()}
      </p>
      <div className="mt-5 w-full">
        <ProjectJourney stages={buildJourney(project)} />
      </div>
      <span className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition-all group-hover:brightness-110">
        Next: {nextActionLabel(project)}
        <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </span>
      {/* Confirmation dialog is a sibling to the card content so clicks
          inside it never bubble to the card's open handler. */}
      <div onClick={(e) => e.stopPropagation()}>
        <DeleteProjectDialog
          projectName={project.name}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={async () => {
            const { error } = await supabase.from("projects").delete().eq("id", project.id);
            if (error) throw new Error(error.message);
            toast.success("Project deleted.");
            onDeleted(project.id);
          }}
        />
      </div>
    </div>
  );
}

function ImportStrategyField({
  label,
  value,
  onChange,
  placeholder,
  recommendable,
  onRecommend,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  recommendable?: boolean;
  onRecommend?: () => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
      />
      {recommendable && onRecommend && (
        <button
          type="button"
          onClick={onRecommend}
          className="mt-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          Board should recommend
        </button>
      )}
    </label>
  );
}
