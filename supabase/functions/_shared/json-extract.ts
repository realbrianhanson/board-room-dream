// deno-lint-ignore-file no-explicit-any
// Tolerant JSON extraction and last-resort truncation repair for model
// output. Pure — no I/O, never throws.
//
// Two tiers, used by the orchestrator in this order (after strict
// JSON.parse and the redundant-closer rescue, before the tail-closer):
//
//   extractJsonCandidate  — the model answered with the right JSON but wrapped
//                           it (``` fences, a "Here is the JSON:" preamble, a
//                           "Note: done" trailer). Nothing is repaired: the
//                           first balanced top-level value is parsed as-is and
//                           everything after it is ignored.
//
//   repairTruncatedJson   — the output was cut by the token budget. Cut back
//                           to the last COMPLETE element boundary at depth
//                           <= 2, append the closers still open at that point,
//                           parse. Loses the partial tail on purpose; the
//                           caller decides whether a partial answer is
//                           acceptable (see repairTruncatedStepJson, which
//                           allow-lists the count-tolerant steps and enforces
//                           a minimum-count guard).

import { batchPromptPolicy } from "./batch-count-policy.ts";

export type ExtractMode = "strict" | "fenced" | "embedded";

export type ExtractResult =
  | { ok: true; value: unknown; mode: ExtractMode }
  | { ok: false; reason: string };

export type RepairResult =
  | { ok: true; value: unknown; dropped_chars: number }
  | { ok: false; reason: string };

const WS = new Set([" ", "\t", "\n", "\r"]);

// Strip a leading ``` / ```json fence line and a trailing ``` fence, each
// independently (a truncated answer may carry only the opening fence).
export function stripJsonFences(text: string): string {
  let s = String(text ?? "").trim();
  const open = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?/.exec(s);
  if (open) s = s.slice(open[0].length);
  const close = /\r?\n?[ \t]*```[ \t]*$/.exec(s);
  if (close) s = s.slice(0, s.length - close[0].length);
  return s.trim();
}

// Index of the closer that balances the "{" or "[" at `start`, scanning
// string- and escape-aware. -1 when the value never closes (truncation) or
// a mismatched closer is met.
function findBalancedEnd(s: string, start: number): number {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); continue; }
    if (c === "}" || c === "]") {
      const open = stack.pop();
      if (!open || (open === "{" && c !== "}") || (open === "[" && c !== "]")) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function parseContainer(s: string): unknown | undefined {
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

const MAX_EMBEDDED_STARTS = 64;

export function extractJsonCandidate(text: string): ExtractResult {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, reason: "empty" };

  if (raw[0] === "{" || raw[0] === "[") {
    const strict = parseContainer(raw);
    if (strict !== undefined) return { ok: true, value: strict, mode: "strict" };
  }

  const unfenced = stripJsonFences(raw);
  if (unfenced !== raw && (unfenced[0] === "{" || unfenced[0] === "[")) {
    const fenced = parseContainer(unfenced);
    if (fenced !== undefined) return { ok: true, value: fenced, mode: "fenced" };
  }

  // Embedded: the first "{" / "[" that opens a balanced, parseable value.
  // A brace inside a prose preamble does not balance into valid JSON, so
  // the scan moves on to the next opener (bounded).
  let attempts = 0;
  for (let i = 0; i < unfenced.length && attempts < MAX_EMBEDDED_STARTS; i++) {
    const c = unfenced[i];
    if (c !== "{" && c !== "[") continue;
    attempts++;
    const end = findBalancedEnd(unfenced, i);
    if (end < 0) continue;
    const value = parseContainer(unfenced.slice(i, end + 1));
    if (value !== undefined) return { ok: true, value, mode: "embedded" };
  }
  return { ok: false, reason: "no balanced JSON object or array found" };
}

// Cut a budget-truncated JSON document back to its last complete element
// (a "}" or "]" that closes a value living at depth <= 2, outside strings),
// append the closers still open there, and parse. Walks back through
// earlier boundaries if the latest one does not parse. Refuses when the
// document nests deeper than maxDepth, has no boundary, or nothing parses.
export function repairTruncatedJson(
  text: string,
  opts: { maxDepth?: number } = {},
): RepairResult {
  const maxDepth = opts.maxDepth ?? 6;
  const s = stripJsonFences(text);
  if (!s) return { ok: false, reason: "empty" };
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") { start = i; break; }
  }
  if (start < 0) return { ok: false, reason: "no JSON opener" };

  const stack: Array<"{" | "["> = [];
  // Each boundary: index of the closer + the closers still open after it.
  const boundaries: Array<{ end: number; closers: string }> = [];
  let inString = false;
  let escape = false;
  let rootClosed = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (WS.has(c)) continue;
    if (c === "{" || c === "[") {
      stack.push(c);
      if (stack.length > maxDepth) return { ok: false, reason: `nesting deeper than ${maxDepth}` };
      continue;
    }
    if (c === "}" || c === "]") {
      const open = stack.pop();
      if (!open || (open === "{" && c !== "}") || (open === "[" && c !== "]")) {
        return { ok: false, reason: "mismatched delimiter" };
      }
      if (stack.length === 0) { rootClosed = i; break; }
      if (stack.length <= 2) {
        let closers = "";
        for (let k = stack.length - 1; k >= 0; k--) closers += stack[k] === "{" ? "}" : "]";
        boundaries.push({ end: i, closers });
      }
    }
  }

  if (rootClosed >= 0) {
    const value = parseContainer(s.slice(start, rootClosed + 1));
    if (value === undefined) return { ok: false, reason: "balanced root does not parse" };
    return { ok: true, value, dropped_chars: s.length - (rootClosed + 1) };
  }
  if (!boundaries.length) return { ok: false, reason: "no complete element boundary" };

  const MAX_WALK_BACK = 8;
  for (let b = boundaries.length - 1, tries = 0; b >= 0 && tries < MAX_WALK_BACK; b--, tries++) {
    const { end, closers } = boundaries[b];
    const value = parseContainer(s.slice(start, end + 1) + closers);
    if (value !== undefined) return { ok: true, value, dropped_chars: s.length - (end + 1) };
  }
  return { ok: false, reason: "no boundary parsed after appending closers" };
}

// ============================== Step policy ==============================

// Steps whose answer is a LIST whose partial form is still honest: a seat
// map chunk with fewer findings, a merge with fewer findings, a batch plan
// with fewer batches (subject to the contract minimum). Everything else —
// reviews, votes, exams, change-request steps — is a single judgment and
// must never be accepted in part.
const AUDIT_MAP_RE = /^audit_(chair|strategist|contrarian|inspector|reserve)(_c\d+)?$/;

export function truncationRepairPolicy(
  stepKey: string,
  opts: { isImport?: boolean } = {},
): { allowed: false } | { allowed: true; listKey: "findings" | "batches"; minCount: number } {
  const key = String(stepKey ?? "");
  if (key === "batches_chair" || key === "batches_revise_chair") {
    // Unknown import flag -> greenfield minimum (the stricter guard).
    return { allowed: true, listKey: "batches", minCount: batchPromptPolicy(opts.isImport === true).minBatches };
  }
  if (key === "audit_chair_merge" || AUDIT_MAP_RE.test(key)) {
    // Never repair a cut that left zero complete findings: an empty list
    // would read as a clean chunk, which the model never said.
    return { allowed: true, listKey: "findings", minCount: 1 };
  }
  return { allowed: false };
}

// Last-resort repair for one step: allow-list, cut/close/parse, then the
// minimum-count guard. The caller must still run validateStepJson on the
// returned value.
export function repairTruncatedStepJson(
  stepKey: string,
  text: string,
  opts: { isImport?: boolean; maxDepth?: number } = {},
): RepairResult {
  const policy = truncationRepairPolicy(stepKey, { isImport: opts.isImport });
  if (!policy.allowed) return { ok: false, reason: `truncation repair not allowed for ${stepKey}` };
  const repaired = repairTruncatedJson(text, { maxDepth: opts.maxDepth });
  if (!repaired.ok) return repaired;
  const list = (repaired.value as any)?.[policy.listKey];
  if (!Array.isArray(list)) return { ok: false, reason: `repaired value has no ${policy.listKey} array` };
  if (list.length < policy.minCount) {
    return { ok: false, reason: `repaired ${policy.listKey} has ${list.length} complete entries — minimum ${policy.minCount}` };
  }
  return repaired;
}
