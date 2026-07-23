import { describe, it, expect } from "vitest";
import { classifyAudits, parseTimestamp } from "./audit-classification";

const iso = (ms: number) => new Date(ms).toISOString();

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const H = 3_600_000;

describe("classifyAudits — pre-plan audit signal", () => {
  it("counts a successful final_az before plan lock as has_import_audit only", () => {
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(T0) }],
      planLockedAt: T0 + 2 * H,
      batches: [],
    });
    expect(r.has_import_audit).toBe(true);
    expect(r.has_final_audit).toBe(false);
  });

  it("counts any successful final_az when no plan is locked yet", () => {
    const r = classifyAudits({
      audits: [{ status: "findings", created_at: iso(T0) }],
      planLockedAt: null,
      batches: [],
    });
    expect(r.has_import_audit).toBe(true);
    expect(r.has_final_audit).toBe(false);
  });

  it("ignores non-terminal audits (running/failed)", () => {
    const r = classifyAudits({
      audits: [
        { status: "running", created_at: iso(T0) },
        { status: "failed", created_at: iso(T0) },
      ],
      planLockedAt: null,
      batches: [],
    });
    expect(r.has_import_audit).toBe(false);
    expect(r.has_final_audit).toBe(false);
  });
});

describe("classifyAudits — post-plan-but-batches-pending must NOT count as final", () => {
  it("six main batches + one fix batch all pending: audit after plan lock does not finalize", () => {
    // Reproduces the exact live regression: the latest audit is after the
    // plan lock, but the batches are still pending. Historic code marked
    // has_final_audit true and lit the Ship stage; classifier must refuse.
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 5 * H) }],
      planLockedAt,
      batches: [
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" }, // fix batch
      ],
    });
    expect(r.has_final_audit).toBe(false);
    expect(r.has_import_audit).toBe(false);
  });

  it("mix of passed and one still-pending is not final", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 10 * H) }],
      planLockedAt,
      batches: [
        { status: "passed", built_at: iso(planLockedAt + H) },
        { status: "passed", built_at: iso(planLockedAt + 2 * H) },
        { status: "fix_needed" },
      ],
    });
    expect(r.has_final_audit).toBe(false);
  });

  it("fix batch pending after otherwise passed set is not final", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 10 * H) }],
      planLockedAt,
      batches: [
        { status: "passed", built_at: iso(planLockedAt + H) },
        { status: "passed", built_at: iso(planLockedAt + 2 * H) },
        { status: "pending" }, // fix batch queued
      ],
    });
    expect(r.has_final_audit).toBe(false);
  });
});

describe("classifyAudits — all batches terminal + audit ordering", () => {
  it("all passed, audit BEFORE latest built_at ⇒ not final", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 2 * H) }],
      planLockedAt,
      batches: [
        { status: "passed", built_at: iso(planLockedAt + H) },
        { status: "passed", built_at: iso(planLockedAt + 5 * H) },
      ],
    });
    expect(r.has_final_audit).toBe(false);
  });

  it("all passed, audit AFTER latest built_at ⇒ final", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 6 * H) }],
      planLockedAt,
      batches: [
        { status: "passed", built_at: iso(planLockedAt + H) },
        { status: "passed", built_at: iso(planLockedAt + 5 * H) },
      ],
    });
    expect(r.has_final_audit).toBe(true);
    expect(r.has_import_audit).toBe(false);
  });

  it("skipped uses built_at → sent_at → created_at fallback", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "findings", created_at: iso(planLockedAt + 4 * H) }],
      planLockedAt,
      batches: [
        // No built_at, no sent_at — created_at wins as skipped fallback.
        { status: "skipped", created_at: iso(planLockedAt + H) },
        { status: "passed", built_at: iso(planLockedAt + 3 * H) },
      ],
    });
    expect(r.has_final_audit).toBe(true);
  });
});

describe("classifyAudits — fail-closed on invalid timestamps", () => {
  it("passed batch with missing built_at ⇒ not final (never epoch/NaN truth)", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 10 * H) }],
      planLockedAt,
      batches: [{ status: "passed", built_at: null }],
    });
    expect(r.has_final_audit).toBe(false);
  });

  it("passed batch with garbage built_at ⇒ not final", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 10 * H) }],
      planLockedAt,
      batches: [{ status: "passed", built_at: "not-a-date" }],
    });
    expect(r.has_final_audit).toBe(false);
  });

  it("audit with missing created_at is ignored", () => {
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: null }],
      planLockedAt: null,
      batches: [],
    });
    expect(r.has_import_audit).toBe(false);
    expect(r.has_final_audit).toBe(false);
  });

  it("skipped with all three timestamps invalid ⇒ not final", () => {
    const planLockedAt = T0;
    const r = classifyAudits({
      audits: [{ status: "clean", created_at: iso(planLockedAt + 10 * H) }],
      planLockedAt,
      batches: [
        { status: "skipped", built_at: null, sent_at: "", created_at: "nope" },
      ],
    });
    expect(r.has_final_audit).toBe(false);
  });
});

describe("parseTimestamp helper", () => {
  it("rejects null, undefined, empty string, non-string", () => {
    expect(parseTimestamp(null)).toBe(null);
    expect(parseTimestamp(undefined)).toBe(null);
    expect(parseTimestamp("")).toBe(null);
    expect(parseTimestamp(123 as unknown)).toBe(null);
  });
  it("returns finite ms for valid ISO", () => {
    const t = parseTimestamp(iso(T0));
    expect(t).toBe(T0);
  });
  it("returns null for unparsable string", () => {
    expect(parseTimestamp("garbage")).toBe(null);
  });
});
