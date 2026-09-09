// deno-lint-ignore-file no-explicit-any
// The one JSON acceptance pipeline for a step's model output: strict parse ->
// trailing-redundant-closer recovery -> wrapped-JSON extraction -> tail-closer
// rescue, then normalize-and-validate under the current rules. executeStep
// runs it on a fresh answer; resume_failed / retry_step run it on the text a
// step stored when it failed validation, so a draft the rules now accept
// (live run dd1e502e: a 2,675-char batch rejected by the old 2,600 cap) is
// completed from the row instead of being bought again. Pure: no I/O.

import { tryCloseJsonTail, tryRecoverTrailingRedundantCloser } from "../_shared/audit-findings.ts";
import { extractJsonCandidate, truncationRepairPolicy } from "../_shared/json-extract.ts";
import { batchPromptLengthWarnings, normalizeStepJson } from "./protocol.ts";

export type LengthWarning = { batch_no: number; chars: number };

export type AcceptStepJsonResult = {
  // The parsed (pre-normalize) value, or null when nothing parsed. Callers
  // use its absence as the "unparseable" signal for truncation heuristics.
  candidate: any | null;
  // The normalized value validateStepJson judged (null when nothing parsed).
  value: any | null;
  error: string | null;
  tailClosed: string | null;
  recoveryMode: string | null;
  lengthWarning: LengthWarning[];
};

const UNPARSEABLE = "Response was not parseable JSON.";

function rescueShapeFor(stepKey: string): "merge" | "map" | "generic" {
  if (stepKey === "audit_chair_merge") return "merge";
  if (/^audit_(chair|strategist|contrarian|inspector|reserve)(_c\d+)?$/.test(stepKey)) return "map";
  return "generic";
}

export function acceptStepJson(
  stepKey: string,
  content: string,
  kind: string,
  opts: { attempt: number },
): AcceptStepJsonResult {
  const text = String(content ?? "");
  let candidate: any = null;
  let tailClosed: string | null = null;
  let recoveryMode: string | null = null;
  try { candidate = JSON.parse(text); } catch { candidate = null; }
  if (!candidate) {
    // AUDIT-JSON-RECOVERY-R5: valid top-level JSON followed only by
    // whitespace and redundant same-kind closers (e.g. extra "}" after
    // an object) is machine-recoverable without repair. Runs strictly
    // after JSON.parse and before the tail-closer rescue.
    const rec = tryRecoverTrailingRedundantCloser(text);
    if (rec.ok) {
      candidate = rec.value;
      recoveryMode = "trailing_redundant_closer";
    }
  }
  if (!candidate) {
    // Tolerant extraction (RC-3): the answer IS the right JSON but wrapped
    // — ``` fences, a "Here is the JSON:" preamble, a "Note: done" trailer.
    // Parses the first balanced top-level value as-is and ignores the
    // rest; nothing is repaired. Sits between the redundant-closer rescue
    // and the tail-closer so a complete-but-wrapped answer never reaches
    // the closer heuristics. Still validated below like any other parse.
    const ext = extractJsonCandidate(text);
    if (ext.ok) {
      candidate = ext.value;
      recoveryMode = ext.mode;
    }
  }
  if (!candidate) {
    // Conservative tail-closure rescue: the audit-map path repeatedly
    // truncates one token short of the outer "]}" (run e2c5faf3). The
    // helper appends ONLY the missing "}"/"]" needed to balance and re-
    // parses; refuses on unterminated strings, dangling commas, or any
    // other ambiguity. Rescued output must still pass validateStepJson.
    // Shape selection: audit merge → strict "merge"; audit seat maps →
    // "map"; every other JSON step (Round-4 vote, cr_exam_*, batches_*,
    // etc.) → "generic". Generic still bounds the appended-closer count
    // and passes the rescued value through validateStepJson downstream.
    const rescued = tryCloseJsonTail(text, { shape: rescueShapeFor(stepKey) });
    if (rescued.ok) {
      candidate = rescued.value;
      tailClosed = rescued.closed;
    }
  }
  // Normalize-then-validate: mechanical schema deviations (7.5 scores,
  // seat labels, a "resolved" objection with no quote, nine review
  // issues, misnumbered batches) are coerced deterministically and the
  // coerced value is what gets validated AND persisted.
  const normalized = candidate
    ? normalizeStepJson(stepKey, candidate, kind, { attempt: opts.attempt })
    : { value: null as any, error: UNPARSEABLE as string | null };
  const lengthWarning = !normalized.error
    ? batchPromptLengthWarnings(stepKey, normalized.value, opts.attempt)
    : [];
  return {
    candidate,
    value: normalized.value,
    error: normalized.error,
    tailClosed,
    recoveryMode,
    lengthWarning,
  };
}

// Step errors whose stored response_text is worth re-judging on resume: the
// model answered, only validation (or a truncation heuristic) refused it.
export const REVALIDATE_ON_RESUME_ERRORS: ReadonlySet<string> = new Set([
  "invalid_json_after_correction",
  "truncated_after_correction",
]);

export type RevalidateStoredStepResult =
  | { ok: true; response_json: Record<string, unknown> }
  | { ok: false; reason: string };

// Pure. Re-judge a failed step's stored output under the CURRENT rules at
// attempt = 1 (the soft-length treatment the correction pass would get).
// On success the returned response_json is the normalized value with
// _meta.revalidated = true merged over whatever _meta the failed row kept
// (finish_reason, tokens, fallback). Anything else falls through to the
// caller's normal requeue.
export function revalidateStoredStep(
  step: { step_key?: string | null; error?: string | null; response_text?: string | null; response_json?: any; request?: any },
  kind: string,
): RevalidateStoredStepResult {
  const error = String(step?.error ?? "");
  if (!REVALIDATE_ON_RESUME_ERRORS.has(error)) return { ok: false, reason: `error ${error || "(none)"} is not a validation failure` };
  const text = String(step?.response_text ?? "");
  if (!text.trim()) return { ok: false, reason: "no stored response_text" };
  const stepKey = String(step?.step_key ?? "");
  const acc = acceptStepJson(stepKey, text, kind, { attempt: 1 });
  if (acc.error || !acc.value || typeof acc.value !== "object") {
    return { ok: false, reason: acc.error ?? UNPARSEABLE };
  }
  if (error === "truncated_after_correction" && acc.tailClosed) {
    // The proxy said the budget was exhausted AND the text needed closers:
    // the tail-closed value is a partial list (a batch plan cut after its
    // third batch balances to a valid 3-item plan). Hold it to the same
    // allow-list and minimum-count guard executeStep's truncation repair
    // applies, so a cut draft never completes below the contract minimum.
    const policy = truncationRepairPolicy(stepKey, { isImport: step?.request?._is_import === true });
    if (!policy.allowed) return { ok: false, reason: `truncated ${stepKey} cannot be completed in part` };
    const list = (acc.value as any)?.[policy.listKey];
    const count = Array.isArray(list) ? list.length : 0;
    if (count < policy.minCount) {
      return { ok: false, reason: `truncated ${policy.listKey} has ${count} complete entries — minimum ${policy.minCount}` };
    }
  }
  const priorMeta = step?.response_json && typeof step.response_json === "object" && step.response_json._meta && typeof step.response_json._meta === "object"
    ? step.response_json._meta
    : {};
  const response_json: Record<string, unknown> = {
    ...acc.value,
    _meta: {
      ...priorMeta,
      ...(acc.value._meta && typeof acc.value._meta === "object" ? acc.value._meta : {}),
      ...(acc.tailClosed ? { tail_closed: acc.tailClosed } : {}),
      ...(acc.recoveryMode ? { recovery_mode: acc.recoveryMode } : {}),
      ...(acc.lengthWarning.length ? { length_warning: acc.lengthWarning } : {}),
      revalidated: true,
    },
  };
  return { ok: true, response_json };
}
