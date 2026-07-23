import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/intake/$intakeId")({
  component: IntakePage,
});

type Answers = {
  idea?: string;
  positioning?: string;
  buyer?: string;
  acquisition_channel?: string;
  pain?: string;
  money?: "one_time" | "subscription" | "service_enabler";
  paid_offer?: string;
  price_anchor?: string;
  upgrade_trigger?: string;
  inspiration?: string;
  activation_moment?: string;
  wow_moment?: string;
};

type Scores = Record<string, { score: number; evidence: string }>;
type ValidationScores = { scores: Scores; total: number; pivot: string | null };

const DIM_LABELS: Record<string, string> = {
  painful_problem: "Painful problem",
  reachable_buyer: "Reachable buyer",
  monetization_path: "Monetization path",
  buildable_scope: "Buildable scope",
  differentiation: "Differentiation",
  activation_value: "Activation & wow",
};

// Ordered list used for new six-dimension results. Legacy five-dim intakes
// are rendered from whatever keys the stored `scores` object actually has,
// so they never crash by requesting the missing sixth key.
const DIM_ORDER: string[] = [
  "painful_problem",
  "reachable_buyer",
  "monetization_path",
  "buildable_scope",
  "differentiation",
  "activation_value",
];

type StepDef = {
  id: string;
  eyebrow: string;
  title: string;
  hint: string;
  kind: "idea" | "buyer" | "pain" | "money" | "inspiration";
};

const STEPS: StepDef[] = [
  {
    id: "idea",
    eyebrow: "Step 1 of 5 · The idea",
    title: "What does the app do, in plain words?",
    hint: "Two or three sentences. Say it like you'd say it to a friend at dinner.",
    kind: "idea",
  },
  {
    id: "buyer",
    eyebrow: "Step 2 of 5 · The buyer",
    title: "Who pays for this — and how do you reach them?",
    hint: 'Name the kind of person — not "everyone." Then tell us where you can actually reach them.',
    kind: "buyer",
  },
  {
    id: "pain",
    eyebrow: "Step 3 of 5 · The pain",
    title: "What painful problem does it kill?",
    hint: "What happens the week they DON'T have it? Concrete cost, missed money, or wasted hours.",
    kind: "pain",
  },
  {
    id: "money",
    eyebrow: "Step 4 of 5 · Money",
    title: "How does it earn?",
    hint: "Pick the closest fit. You can refine with the board later.",
    kind: "money",
  },
  {
    id: "inspiration",
    eyebrow: "Step 5 of 5 · Inspiration & first result",
    title: "What should feel familiar — and what should wow them?",
    hint: "Reference apps that share the tone, then say what a new user gets in the first 90 seconds and what would make them show a friend.",
    kind: "inspiration",
  },
];

const MONEY_OPTIONS = [
  { value: "one_time" as const, title: "One-time sale", body: "They pay once and own it." },
  { value: "subscription" as const, title: "Subscription", body: "They pay monthly or yearly for ongoing value." },
  { value: "service_enabler" as const, title: "Service-enabler", body: "It powers a service you sell for a bigger check." },
];

const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function canProceedFromStep(kind: StepDef["kind"], a: Answers): boolean {
  switch (kind) {
    case "idea":
      return trimmed(a.idea).length > 3 && trimmed(a.positioning).length > 1;
    case "buyer":
      return trimmed(a.buyer).length > 3 && trimmed(a.acquisition_channel).length > 1;
    case "pain":
      return trimmed(a.pain).length > 3;
    case "money":
      return (
        !!a.money &&
        trimmed(a.paid_offer).length > 2 &&
        trimmed(a.price_anchor).length > 0 &&
        trimmed(a.upgrade_trigger).length > 2
      );
    case "inspiration":
      return (
        trimmed(a.inspiration).length > 3 &&
        trimmed(a.activation_moment).length > 1 &&
        trimmed(a.wow_moment).length > 1
      );
  }
}

function IntakePage() {
  const { intakeId } = Route.useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<Answers>({});
  const [projectId, setProjectId] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");
  const [projectStatus, setProjectStatus] = useState<string>("intake");
  const [verdict, setVerdict] = useState<"pass" | "kill" | null>(null);
  const [scores, setScores] = useState<ValidationScores | null>(null);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [noKey, setNoKey] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: intake, error } = await supabase
        .from("intakes")
        .select("id, project_id, answers, validation_scores, verdict, projects(name, status)")
        .eq("id", intakeId)
        .maybeSingle();
      if (error || !intake) {
        toast.error(error?.message ?? "Intake not found");
        navigate({ to: "/dashboard" });
        return;
      }
      setAnswers((intake.answers ?? {}) as Answers);
      setProjectId(intake.project_id);
      const p = (intake as unknown as { projects: { name: string; status: string } | null }).projects;
      setProjectName(p?.name ?? "Untitled");
      setProjectStatus(p?.status ?? "intake");
      if (intake.verdict === "pass" || intake.verdict === "kill") {
        setVerdict(intake.verdict);
        setScores((intake.validation_scores as ValidationScores) ?? null);
      }
      setLoading(false);
    })();
  }, [intakeId, navigate]);

  const progress = useMemo(() => (step + 1) / STEPS.length, [step]);
  const current = STEPS[step];
  const canProceed = canProceedFromStep(current.kind, answers);

  // Persist returns an explicit success result. On failure we surface the
  // exact server error, keep the user's answers on screen (they're already in
  // React state), and let the caller decide NOT to advance/validate/navigate.
  async function persist(next: Answers): Promise<{ ok: true } | { ok: false; error: string }> {
    setAnswers(next);
    setSaving(true);
    try {
      const { error } = await supabase.from("intakes").update({ answers: next }).eq("id", intakeId);
      if (error) {
        toast.error(`Couldn't save — ${error.message}. Your answers are still here; try again.`);
        return { ok: false, error: error.message };
      }
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      toast.error(`Couldn't save — ${msg}. Your answers are still here; try again.`);
      return { ok: false, error: msg };
    } finally {
      setSaving(false);
    }
  }

  async function next() {
    // Guard against double-click/double-submit: saving or running already in flight.
    if (!canProceed || saving || running) return;
    if (step < STEPS.length - 1) {
      const result = await persist(answers);
      if (!result.ok) return; // do not advance on save failure
      setStep(step + 1);
      return;
    }
    setRunning(true);
    setRunError(null);
    setNoKey(false);
    try {
      const saveResult = await persist(answers);
      if (!saveResult.ok) {
        // Do not run validation or navigate when the final save failed.
        setRunError(`Couldn't save your answers — ${saveResult.error}. Try again.`);
        return;
      }
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const { data, error } = await supabase.functions.invoke("validate-intake", {
        body: { intake_id: intakeId },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      const payload = data as {
        status: string;
        verdict?: "pass" | "kill";
        scores?: Scores;
        total?: number;
        pivot?: string | null;
        error?: string;
      };
      if (payload?.status === "no_key") { setNoKey(true); return; }
      if (payload?.error) throw new Error(payload.error);
      if (payload?.verdict && payload.scores && typeof payload.total === "number") {
        setVerdict(payload.verdict);
        setScores({ scores: payload.scores, total: payload.total, pivot: payload.pivot ?? null });
        if (payload.verdict === "pass") setProjectStatus("validated");
      }
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function reviseIdea() { setVerdict(null); setScores(null); setStep(0); }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-6">
        <div className="h-32 w-full animate-pulse rounded-xl bg-surface-1" />
      </div>
    );
  }

  if (verdict && scores) {
    return (
      <VerdictView
        projectName={projectName}
        verdict={verdict}
        scores={scores}
        onEnterBoardroom={() => navigate({ to: "/boardroom/$projectId", params: { projectId } })}
        onRevise={reviseIdea}
      />
    );
  }

  if (noKey) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          Board unavailable
        </span>
        <h1 className="mt-3 font-display text-4xl leading-tight text-foreground">Seat the board first.</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The board needs your OpenRouter key to convene. Add it in Settings and we'll pick this
          intake back up — your answers are saved.
        </p>
        <div className="mt-6 flex gap-3">
          <Link to="/settings" className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110">
            Open Settings
          </Link>
          <button onClick={() => setNoKey(false)} className="text-sm text-muted-foreground hover:text-foreground">
            Back to intake
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-16">
      <div className="mb-10 flex items-center gap-1.5">
        {STEPS.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? "bg-primary" : "bg-border"}`}
          />
        ))}
      </div>

      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        {current.eyebrow} · {projectName}
      </span>
      <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{current.title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{current.hint}</p>

      <div className="mt-8 space-y-5">
        {current.kind === "idea" && (
          <>
            <TextArea
              label="The idea, in plain words"
              value={answers.idea ?? ""}
              rows={6}
              onChange={(v) => setAnswers((a) => ({ ...a, idea: v }))}
              onBlur={() => persist(answers)}
              placeholder="Type here…"
            />
            <TextInput
              label="Unlike what alternative, why this?"
              hint="Name the closest thing they'd use today and why yours is different. A best guess is fine."
              value={answers.positioning ?? ""}
              onChange={(v) => setAnswers((a) => ({ ...a, positioning: v }))}
              onBlur={() => persist(answers)}
              placeholder='e.g. "Unlike a generic PDF report, this flags the client-specific risk in one glance."'
              required
              missing={!trimmed(answers.positioning)}
            />
          </>
        )}
        {current.kind === "buyer" && (
          <>
            <TextArea
              label="Who pays for this?"
              value={answers.buyer ?? ""}
              rows={4}
              onChange={(v) => setAnswers((a) => ({ ...a, buyer: v }))}
              onBlur={() => persist(answers)}
              placeholder="Type here…"
            />
            <TextInput
              label="Where can you reach your first 10 buyers in 30 days?"
              hint="One concrete channel you can actually use. Best guess is allowed."
              value={answers.acquisition_channel ?? ""}
              onChange={(v) => setAnswers((a) => ({ ...a, acquisition_channel: v }))}
              onBlur={() => persist(answers)}
              placeholder='e.g. "LinkedIn DMs to advisers I already follow" or "a niche subreddit"'
              required
              missing={!trimmed(answers.acquisition_channel)}
            />
          </>
        )}
        {current.kind === "pain" && (
          <TextArea
            label="The painful problem"
            value={answers.pain ?? ""}
            rows={6}
            onChange={(v) => setAnswers((a) => ({ ...a, pain: v }))}
            onBlur={() => persist(answers)}
            placeholder="Type here…"
          />
        )}
        {current.kind === "money" && (
          <div className="space-y-6">
            <div className="grid gap-3 md:grid-cols-3">
              {MONEY_OPTIONS.map((opt) => {
                const active = answers.money === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => persist({ ...answers, money: opt.value })}
                    className={`rounded-xl border p-5 text-left transition-all ${
                      active ? "border-primary bg-surface-2" : "border-border bg-surface-1 hover:bg-surface-2"
                    }`}
                  >
                    <p className="font-display text-lg text-foreground">{opt.title}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{opt.body}</p>
                  </button>
                );
              })}
            </div>
            <div className="space-y-4">
              <TextInput
                label="What exactly do they pay for?"
                hint="One concrete deliverable — e.g. “access to the weekly research briefing PDF.”"
                value={answers.paid_offer ?? ""}
                onChange={(v) => setAnswers((a) => ({ ...a, paid_offer: v }))}
                onBlur={() => persist(answers)}
                required
                missing={!trimmed(answers.paid_offer)}
              />
              <TextInput
                label="Best starting-price guess"
                hint={'A number is best. If you truly don\'t know, type "not set — recommend one" and the board will propose one.'}
                value={answers.price_anchor ?? ""}
                onChange={(v) => setAnswers((a) => ({ ...a, price_anchor: v }))}
                onBlur={() => persist(answers)}
                required
                missing={!trimmed(answers.price_anchor)}
              />
              <TextInput
                label="What makes them buy now, renew, or move up?"
                hint="One trigger — a deadline, an outcome they hit, a moment of pain."
                value={answers.upgrade_trigger ?? ""}
                onChange={(v) => setAnswers((a) => ({ ...a, upgrade_trigger: v }))}
                onBlur={() => persist(answers)}
                required
                missing={!trimmed(answers.upgrade_trigger)}
              />
            </div>
          </div>
        )}
        {current.kind === "inspiration" && (
          <>
            <TextArea
              label="Name 1–3 apps that feel like what you want."
              value={answers.inspiration ?? ""}
              rows={4}
              onChange={(v) => setAnswers((a) => ({ ...a, inspiration: v }))}
              onBlur={() => persist(answers)}
              placeholder="Comma-separated is fine."
            />
            <TextInput
              label="What useful result should a new user get in the first 90 seconds?"
              hint="One concrete result — not a feature list. A best guess is fine."
              value={answers.activation_moment ?? ""}
              onChange={(v) => setAnswers((a) => ({ ...a, activation_moment: v }))}
              onBlur={() => persist(answers)}
              placeholder='e.g. "They paste one client scenario and see the flagged risks."'
              required
              missing={!trimmed(answers.activation_moment)}
            />
            <TextInput
              label="What result would make them immediately show someone?"
              hint="The screenshot-worthy moment. A best guess is fine."
              value={answers.wow_moment ?? ""}
              onChange={(v) => setAnswers((a) => ({ ...a, wow_moment: v }))}
              onBlur={() => persist(answers)}
              placeholder='e.g. "The one-page risk summary they show a client."'
              required
              missing={!trimmed(answers.wow_moment)}
            />
          </>
        )}
      </div>

      {runError && <p className="mt-4 text-sm text-[hsl(8_60%_65%)]">{runError}</p>}

      <div className="mt-10 flex items-center justify-between">
        <button
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0 || running}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <div className="flex items-center gap-4">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {saving ? "Saving…" : `${Math.round(progress * 100)}%`}
          </span>
          <button
            onClick={next}
            disabled={!canProceed || running}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
          >
            {running ? "The board is scoring…" : step === STEPS.length - 1 ? "Submit to the board" : "Continue"}
            {!running && <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {projectStatus !== "intake" && (
        <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Project status · {projectStatus}
        </p>
      )}
    </div>
  );
}

function TextArea({
  label, value, onChange, onBlur, rows, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; onBlur: () => void; rows: number; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-sm text-foreground">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        rows={rows}
        placeholder={placeholder}
        className="mt-2 w-full rounded-md border border-border bg-surface-1 px-4 py-3 text-base text-foreground outline-none focus:border-primary"
      />
    </label>
  );
}

function TextInput({
  label, hint, value, onChange, onBlur, required, missing, placeholder,
}: {
  label: string; hint?: string; value: string; onChange: (v: string) => void;
  onBlur: () => void; required?: boolean; missing?: boolean; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm text-foreground">
        {label}
        {required && <span className="ml-1 text-primary">*</span>}
      </span>
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder ?? "Type here…"}
        className={`mt-2 w-full rounded-md border bg-surface-1 px-3 py-2 text-sm text-foreground outline-none focus:border-primary ${
          missing ? "border-[hsl(8_60%_45%)]" : "border-border"
        }`}
      />
    </label>
  );
}

function scoreColor(s: number) {
  if (s >= 8) return "hsl(160 45% 48%)";
  if (s <= 4) return "hsl(8 60% 55%)";
  return "hsl(38 65% 55%)";
}

// Legacy stored intakes may have exactly the five original dimensions and a
// total capped at 50. New intakes have six dimensions and total /60. Choose
// the displayed dimensions and denominator from what's actually present so
// legacy results still render cleanly.
export function pickDisplayedDimensions(scores: Scores | null | undefined): string[] {
  if (!scores) return [];
  const present = Object.keys(scores).filter((k) => scores[k] && Number.isFinite(scores[k].score));
  // Preserve canonical order; append any unknown-but-present keys at the end.
  const ordered = DIM_ORDER.filter((k) => present.includes(k));
  const extras = present.filter((k) => !ordered.includes(k));
  return [...ordered, ...extras];
}

export function displayedMaxTotal(scores: Scores | null | undefined): number {
  return pickDisplayedDimensions(scores).length * 10;
}

function VerdictView({
  projectName, verdict, scores, onEnterBoardroom, onRevise,
}: {
  projectName: string;
  verdict: "pass" | "kill";
  scores: ValidationScores;
  onEnterBoardroom: () => void;
  onRevise: () => void;
}) {
  const dims = pickDisplayedDimensions(scores.scores);
  const maxTotal = dims.length * 10;
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Verdict · {projectName}
      </span>
      <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">
        {verdict === "pass" ? "The board will see you now." : "This one doesn't clear the bar."}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {verdict === "pass"
          ? "Total score sits above the bar with no blocking objections."
          : "Killing fast is a win — here's the pivot the board suggests:"}
      </p>

      {verdict === "kill" && scores.pivot && (
        <div className="mt-6 rounded-xl border border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.08)] p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(8_60%_65%)]">Suggested pivot</p>
          <p className="mt-2 text-base text-foreground">{scores.pivot}</p>
        </div>
      )}

      <div className="mt-10 space-y-5">
        {dims.map((key) => {
          const entry = scores.scores[key];
          if (!entry) return null;
          const pct = (entry.score / 10) * 100;
          const color = scoreColor(entry.score);
          const label = DIM_LABELS[key] ?? key.replace(/_/g, " ");
          return (
            <div key={key}>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-sm text-foreground">{label}</span>
                <span className="font-mono text-sm" style={{ color }}>{entry.score}/10</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{entry.evidence}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-border pt-6">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Total</p>
          <p className="mt-1 font-mono text-2xl text-foreground">
            {scores.total}
            <span className="text-muted-foreground">/{maxTotal}</span>
          </p>
        </div>
        {verdict === "pass" ? (
          <button
            onClick={onEnterBoardroom}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            Enter the Boardroom
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            onClick={onRevise}
            className="inline-flex items-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm text-foreground transition-colors hover:bg-surface-2"
          >
            Revise the idea
          </button>
        )}
      </div>
    </div>
  );
}
