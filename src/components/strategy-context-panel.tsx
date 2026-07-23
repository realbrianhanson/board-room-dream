import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Check, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  RECOMMENDABLE_FIELDS,
  RECOMMEND_PLACEHOLDER,
  STRATEGY_FIELDS,
  STRATEGY_FIELD_LABELS,
  strategyCompleteness,
  normalizeStrategyForPersist,
  validateImportStrategy,
  type ImportStrategyInput,
  type StrategyField,
} from "@/lib/import-strategy";

import { strategyPanelPhase } from "@/lib/strategy-panel-phase";

export type StrategyPanelHandle = {
  focus: () => void;
};

export type StrategyPanelValidity = {
  valid: boolean;
  missingLabels: string[];
  missingFields: StrategyField[];
};

type Props = {
  projectId: string;
  isOwner: boolean;
  onValidityChange?: (v: StrategyPanelValidity) => void;
};


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

export const StrategyContextPanel = forwardRef<StrategyPanelHandle, Props>(function StrategyContextPanel(
  { projectId, isOwner, onValidityChange },
  ref,
) {
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState<ImportStrategyInput | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const requestSeqRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      setOpen(true);
      containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      // Focus the first input once the panel has expanded.
      requestAnimationFrame(() => firstInputRef.current?.focus());
    },
  }), []);

  const load = useCallback(async () => {
    const ticket = ++requestSeqRef.current;
    setLoading(true);
    setLoadError(null);
    const { data, error: err } = await supabase
      .from("intakes")
      .select("id, answers")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ticket !== requestSeqRef.current) return;
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
    void load();
    return () => {
      requestSeqRef.current++;
    };
  }, [load]);

  // Compute + publish validity to any parent that needs to gate audit start.
  // Uses the canonical validateImportStrategy so we cannot drift from the
  // server gate.
  const validity: StrategyPanelValidity = useMemo(() => {
    if (!values) return { valid: false, missingLabels: [], missingFields: [] };
    const problems = validateImportStrategy(values);
    const missingFields = problems.map((p) => p.field);
    return {
      valid: problems.length === 0,
      missingFields,
      missingLabels: missingFields.map((f) => STRATEGY_FIELD_LABELS[f]),
    };
  }, [values]);

  useEffect(() => {
    if (!onValidityChange) return;
    // Only publish when the load actually resolved to a state that reflects
    // real intake data (or its absence). Skip while loading so the parent
    // doesn't briefly see a false "invalid" snapshot.
    if (loading) return;
    onValidityChange(validity);
  }, [validity, loading, onValidityChange]);

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
    <div ref={containerRef} className="mt-6 rounded-lg border border-border bg-surface-1 p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
        data-testid="strategy-panel-toggle"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Strategy context
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
              validity.valid
                ? "border-[hsl(160_45%_48%/0.4)] bg-[hsl(160_45%_28%/0.15)] text-[hsl(160_45%_72%)]"
                : "border-border bg-surface-2 text-muted-foreground"
            }`}
          >
            {validity.valid ? <Check className="h-3 w-3" /> : null}
            {filled}/{total}
          </span>
          {!validity.valid && (
            <span className="text-xs text-muted-foreground">
              Required before the A–Z audit. Blanks stay blank; the board never invents answers.
            </span>
          )}
        </div>
        {isOwner ? (
          <span className="inline-flex items-center gap-1 text-xs text-foreground/80">
            {open ? "Hide" : validity.valid ? "Edit" : "Fill in"}
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </span>
        ) : null}
      </button>

      {open && isOwner && (
        <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
          {STRATEGY_FIELDS.map((k, idx) => {
            const meta = FIELD_LABEL[k];
            return (
              <label key={k} className="block">
                <span className="text-xs text-muted-foreground">{meta.label}</span>
                <input
                  ref={idx === 0 ? firstInputRef : undefined}
                  type="text"
                  value={readyValues[k]}
                  onChange={(e) =>
                    setValues((prev) => ({ ...(prev as ImportStrategyInput), [k]: e.target.value }))
                  }
                  placeholder={meta.placeholder}
                  className="mt-1 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                {RECOMMENDABLE_FIELDS.includes(k) && (
                  <button
                    type="button"
                    aria-label={`Set ${meta.label} to Board should recommend`}
                    onClick={() =>
                      setValues((prev) => ({
                        ...(prev as ImportStrategyInput),
                        [k]: RECOMMEND_PLACEHOLDER,
                      }))
                    }
                    className="mt-1.5 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    Board should recommend
                  </button>
                )}
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
});

