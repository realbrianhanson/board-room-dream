import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Check, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  STRATEGY_FIELDS,
  strategyCompleteness,
  normalizeStrategyForPersist,
  type ImportStrategyInput,
  type StrategyField,
} from "@/lib/import-strategy";
import { strategyPanelPhase } from "@/lib/strategy-panel-phase";

type Props = { projectId: string; isOwner: boolean };

const FIELD_LABEL: Record<StrategyField, { label: string; placeholder: string }> = {
  buyer: {
    label: "Buyer — who uses and pays",
    placeholder: "Independent finance advisers running solo practices",
  },
  acquisition_channel: {
    label: "Acquisition channel — where can you reach the first 10 buyers in 30 days?",
    placeholder: "LinkedIn DMs · niche subreddit · industry Slack",
  },
  paid_offer: {
    label: "Paid offer — what is paid for",
    placeholder: "Weekly compliance briefing PDF · or 'internal/free'",
  },
  price_anchor: {
    label: "Price anchor",
    placeholder: '$29/mo · or "not set — recommend one"',
  },
  upgrade_trigger: {
    label: "Upgrade trigger — buy, renew, or move up",
    placeholder: "Monthly regulator update lands",
  },
  activation_moment: {
    label: "Activation moment — first 90 seconds",
    placeholder: "They paste one client scenario and see the flagged risks",
  },
  wow_moment: {
    label: "Wow moment — the screenshot-worthy one",
    placeholder: "The one-page risk summary they show a client",
  },
  positioning: {
    label: 'Positioning — "Unlike ___, this app ___"',
    placeholder: "Unlike compliance PDFs, this app flags the client-specific risk in one glance.",
  },
};

function readStrategy(answers: Record<string, unknown> | null): ImportStrategyInput {
  const out = {} as ImportStrategyInput;
  for (const k of STRATEGY_FIELDS) {
    const v = answers?.[k];
    out[k] = typeof v === "string" ? v : "";
  }
  return out;
}

export function StrategyContextPanel({ projectId, isOwner }: Props) {
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState<ImportStrategyInput | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error: err } = await supabase
      .from("intakes")
      .select("id, answers")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (err) {
      setLoadError(err.message);
      setLoading(false);
      return;
    }
    const row = data as { id: string; answers: Record<string, unknown> | null } | null;
    setIntakeId(row?.id ?? null);
    setAnswers(row?.answers ?? {});
    setValues(readStrategy(row?.answers ?? {}));
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const phase = strategyPanelPhase({ loading, error: loadError, intakeId });

  if (phase === "loading") {
    return (
      <div
        className="mt-4 h-12 animate-pulse rounded-lg border border-border bg-surface-1"
        role="status"
        aria-label="Loading strategy context"
      />
    );
  }

  if (phase === "error") {
    return (
      <div
        role="alert"
        className="mt-4 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Couldn't load strategy context.</p>
          <p className="mt-1 break-words text-destructive/80">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (phase === "missing") {
    if (!isOwner) return null;
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border bg-surface-1/60 p-4 text-sm text-muted-foreground">
        No intake yet — strategy context appears here once you finish the project intake.
      </div>
    );
  }

  // phase === "ready" — values is non-null here.
  const readyValues = values as ImportStrategyInput;
  const { filled, total } = strategyCompleteness(readyValues);



  async function save() {
    if (!intakeId) {
      setError("No intake found for this project.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const normalized = normalizeStrategyForPersist(values!);
      const merged = { ...(answers ?? {}), ...normalized };
      // Only answers is updated — DB triggers reject any client-side change
      // to verdict/validation_scores, so those cannot be touched here.
      const { error: err } = await supabase
        .from("intakes")
        .update({ answers: merged })
        .eq("id", intakeId);
      if (err) throw err;
      setAnswers(merged);
      toast.success("Strategy context saved.");
      setOpen(false);
    } catch (err) {
      const msg = (err as Error).message ?? "Failed to save";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-border bg-surface-1 p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Strategy context
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
              filled === total
                ? "border-[hsl(160_45%_48%/0.4)] bg-[hsl(160_45%_28%/0.15)] text-[hsl(160_45%_72%)]"
                : "border-border bg-surface-2 text-muted-foreground"
            }`}
          >
            {filled === total ? <Check className="h-3 w-3" /> : null}
            {filled}/{total}
          </span>
          {filled < total && (
            <span className="text-xs text-muted-foreground">
              Optional — sharpens the plan later. Blanks stay blank; the board never invents answers.
            </span>
          )}
        </div>
        {isOwner ? (
          <span className="inline-flex items-center gap-1 text-xs text-foreground/80">
            {open ? "Hide" : filled < total ? "Fill in" : "Edit"}
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </span>
        ) : null}
      </button>

      {open && isOwner && (
        <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
          {STRATEGY_FIELDS.map((k) => {
            const meta = FIELD_LABEL[k];
            return (
              <label key={k} className="block">
                <span className="text-xs text-muted-foreground">{meta.label}</span>
                <input
                  type="text"
                  value={values[k]}
                  onChange={(e) =>
                    setValues((prev) => ({ ...(prev as ImportStrategyInput), [k]: e.target.value }))
                  }
                  placeholder={meta.placeholder}
                  className="mt-1 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
            );
          })}
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save strategy context"}
            </button>
            <button
              type="button"
              onClick={() => {
                setValues(readStrategy(answers));
                setOpen(false);
                setError(null);
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
