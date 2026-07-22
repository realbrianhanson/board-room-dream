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
  buyer?: string;
  pain?: string;
  money?: "one_time" | "subscription" | "service_enabler";
  paid_offer?: string;
  price_anchor?: string;
  upgrade_trigger?: string;
  inspiration?: string;
};

type Scores = Record<string, { score: number; evidence: string }>;
type ValidationScores = { scores: Scores; total: number; pivot: string | null };

const DIMS: { key: keyof Scores; label: string }[] = [
  { key: "painful_problem", label: "Painful problem" },
  { key: "reachable_buyer", label: "Reachable buyer" },
  { key: "monetization_path", label: "Monetization path" },
  { key: "buildable_scope", label: "Buildable scope" },
  { key: "differentiation", label: "Differentiation" },
];

const STEPS = [
  {
    field: "idea" as const,
    eyebrow: "Step 1 of 5 · The idea",
    title: "What does the app do, in plain words?",
    hint: "Two or three sentences. Say it like you'd say it to a friend at dinner.",
    kind: "textarea" as const,
  },
  {
    field: "buyer" as const,
    eyebrow: "Step 2 of 5 · The buyer",
    title: "Who pays for this?",
    hint: 'Name the kind of person — not "everyone." Be specific enough that you could DM ten of them tomorrow.',
    kind: "textarea" as const,
  },
  {
    field: "pain" as const,
    eyebrow: "Step 3 of 5 · The pain",
    title: "What painful problem does it kill?",
    hint: "What happens the week they DON'T have it? Concrete cost, missed money, or wasted hours.",
    kind: "textarea" as const,
  },
  {
    field: "money" as const,
    eyebrow: "Step 4 of 5 · Money",
    title: "How does it earn?",
    hint: "Pick the closest fit. You can refine with the board later.",
    kind: "money" as const,
  },
  {
    field: "inspiration" as const,
    eyebrow: "Step 5 of 5 · Inspiration",
    title: "Name 1–3 apps that feel like what you want.",
    hint: "Tone, model, or shape — whatever matches. Comma-separated is fine.",
    kind: "textarea" as const,
  },
];

const MONEY_OPTIONS = [
  {
    value: "one_time" as const,
    title: "One-time sale",
    body: "They pay once and own it.",
  },
  {
    value: "subscription" as const,
    title: "Subscription",
    body: "They pay monthly or yearly for ongoing value.",
  },
  {
    value: "service_enabler" as const,
    title: "Service-enabler",
    body: "It powers a service you sell for a bigger check.",
  },
];

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
  const currentValue = current ? (answers as Record<string, unknown>)[current.field] : undefined;
  const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const canProceed =
    current?.kind === "money"
      ? Boolean(answers.money) &&
        trimmed(answers.paid_offer).length > 2 &&
        trimmed(answers.price_anchor).length > 0 &&
        trimmed(answers.upgrade_trigger).length > 2
      : typeof currentValue === "string" && currentValue.trim().length > 3;

  async function persist(next: Answers) {
    setAnswers(next);
    setSaving(true);
    const { error } = await supabase
      .from("intakes")
      .update({ answers: next })
      .eq("id", intakeId);
    setSaving(false);
    if (error) toast.error(error.message);
  }

  async function next() {
    if (!canProceed) return;
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    // Run validation
    setRunning(true);
    setRunError(null);
    setNoKey(false);
    try {
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
      if (payload?.status === "no_key") {
        setNoKey(true);
        return;
      }
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

  function reviseIdea() {
    setVerdict(null);
    setScores(null);
    setStep(0);
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-6">
        <div className="h-32 w-full animate-pulse rounded-xl bg-surface-1" />
      </div>
    );
  }

  // Verdict view
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

  // No-key state
  if (noKey) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          Board unavailable
        </span>
        <h1 className="mt-3 font-display text-4xl leading-tight text-foreground">
          Seat the board first.
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The board needs your OpenRouter key to convene. Add it in Settings and we'll pick this
          intake back up — your answers are saved.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            to="/settings"
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            Open Settings
          </Link>
          <button
            onClick={() => setNoKey(false)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
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
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i <= step ? "bg-primary" : "bg-border"
            }`}
          />
        ))}
      </div>

      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        {current.eyebrow} · {projectName}
      </span>
      <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">
        {current.title}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">{current.hint}</p>

      <div className="mt-8">
        {current.kind === "textarea" ? (
          <textarea
            key={current.field}
            value={(answers[current.field] as string) ?? ""}
            onChange={(e) =>
              setAnswers((a) => ({ ...a, [current.field]: e.target.value } as Answers))
            }
            onBlur={() => persist(answers)}
            rows={current.field === "idea" || current.field === "pain" ? 6 : 4}
            placeholder="Type here…"
            className="w-full rounded-md border border-border bg-surface-1 px-4 py-3 text-base text-foreground outline-none focus:border-primary"
          />
        ) : (
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
                      active
                        ? "border-primary bg-surface-2"
                        : "border-border bg-surface-1 hover:bg-surface-2"
                    }`}
                  >
                    <p className="font-display text-lg text-foreground">{opt.title}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{opt.body}</p>
                  </button>
                );
              })}
            </div>
            <div className="space-y-4">
              <MoneyDetail
                label="What exactly do they pay for?"
                hint="One concrete deliverable — e.g. “access to the weekly research briefing PDF.”"
                value={answers.paid_offer ?? ""}
                onChange={(v) => setAnswers((a) => ({ ...a, paid_offer: v }))}
                onBlur={() => persist(answers)}
                required
                missing={!trimmed(answers.paid_offer)}
              />
              <MoneyDetail
                label="Best starting-price guess"
                hint='A number is best. If you truly don\'t know, type "not set — recommend one" and the board will propose one.'
                value={answers.price_anchor ?? ""}
                onChange={(v) => setAnswers((a) => ({ ...a, price_anchor: v }))}
                onBlur={() => persist(answers)}
                required
                missing={!trimmed(answers.price_anchor)}
              />
              <MoneyDetail
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
      </div>

      {runError && (
        <p className="mt-4 text-sm text-[hsl(8_60%_65%)]">{runError}</p>
      )}

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
            {running
              ? "The board is scoring…"
              : step === STEPS.length - 1
              ? "Submit to the board"
              : "Continue"}
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

function scoreColor(s: number) {
  if (s >= 8) return "hsl(160 45% 48%)"; // jade
  if (s <= 4) return "hsl(8 60% 55%)"; // oxblood
  return "hsl(38 65% 55%)"; // brass
}

function VerdictView({
  projectName,
  verdict,
  scores,
  onEnterBoardroom,
  onRevise,
}: {
  projectName: string;
  verdict: "pass" | "kill";
  scores: ValidationScores;
  onEnterBoardroom: () => void;
  onRevise: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Verdict · {projectName}
      </span>
      <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">
        {verdict === "pass"
          ? "The board will see you now."
          : "This one doesn't clear the bar."}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {verdict === "pass"
          ? "Total score sits above the bar with no blocking objections."
          : "Killing fast is a win — here's the pivot the board suggests:"}
      </p>

      {verdict === "kill" && scores.pivot && (
        <div className="mt-6 rounded-xl border border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.08)] p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(8_60%_65%)]">
            Suggested pivot
          </p>
          <p className="mt-2 text-base text-foreground">{scores.pivot}</p>
        </div>
      )}

      <div className="mt-10 space-y-5">
        {DIMS.map(({ key, label }) => {
          const entry = scores.scores[key];
          if (!entry) return null;
          const pct = (entry.score / 10) * 100;
          const color = scoreColor(entry.score);
          return (
            <div key={key}>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-sm text-foreground">{label}</span>
                <span className="font-mono text-sm" style={{ color }}>
                  {entry.score}/10
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${pct}%`, backgroundColor: color }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{entry.evidence}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-border pt-6">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Total
          </p>
          <p className="mt-1 font-mono text-2xl text-foreground">
            {scores.total}
            <span className="text-muted-foreground">/50</span>
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
