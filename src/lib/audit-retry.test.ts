import { describe, it, expect } from "vitest";
import {
  canOfferFullRescan,
  finalAudits,
  latestFinal,
  previousFinals,
  hasActiveFinal,
  canStartFinal,
  canResumeFinal,
  startCtaLabel,
  type AuditRow,
} from "./audit-retry";

const mk = (over: Partial<AuditRow>): AuditRow => ({
  id: over.id ?? crypto.randomUUID(),
  kind: over.kind ?? "final_az",
  status: over.status ?? "clean",
  created_at: over.created_at ?? new Date().toISOString(),
  run_id: over.run_id ?? null,
  head_sha: over.head_sha ?? null,
});

describe("audit-retry selectors", () => {
  it("finalAudits filters and sorts newest-first, retaining history", () => {
    const a = mk({ id: "a", status: "failed", created_at: "2026-07-20T00:00:00Z" });
    const b = mk({ id: "b", status: "clean", created_at: "2026-07-22T00:00:00Z" });
    const c = mk({ id: "c", kind: "batch", created_at: "2026-07-23T00:00:00Z" });
    const list = finalAudits([a, b, c]);
    expect(list.map((x) => x.id)).toEqual(["b", "a"]);
    expect(previousFinals([a, b, c]).map((x) => x.id)).toEqual(["a"]);
  });

  it("failed final still permits retry (button visible for owner)", () => {
    const failed = mk({ status: "failed" });
    expect(canStartFinal({ isOwner: true, audits: [failed], starting: false })).toBe(true);
    expect(startCtaLabel(failed)).toBe("Run final audit again");
  });

  it("running final blocks duplicate start even for owner", () => {
    const running = mk({ status: "running" });
    expect(hasActiveFinal([running])).toBe(true);
    expect(canStartFinal({ isOwner: true, audits: [running], starting: false })).toBe(false);
  });

  it("starting flag disables duplicate click", () => {
    expect(canStartFinal({ isOwner: true, audits: [], starting: true })).toBe(false);
  });

  it("read-only viewers can never start or retry", () => {
    const failed = mk({ status: "failed" });
    expect(canStartFinal({ isOwner: false, audits: [failed], starting: false })).toBe(false);
    expect(canStartFinal({ isOwner: false, audits: [], starting: false })).toBe(false);
  });

  it("clean/findings show 'Run a new final audit' as confirmation label", () => {
    expect(startCtaLabel(mk({ status: "clean" }))).toBe("Run a new final audit");
    expect(startCtaLabel(mk({ status: "findings" }))).toBe("Run a new final audit");
    expect(startCtaLabel(null)).toBe("Run the A–Z audit");
  });

  it("latest failed audit does not overwrite previous history", () => {
    const older = mk({ id: "old", status: "clean", created_at: "2026-07-10T00:00:00Z" });
    const newer = mk({ id: "new", status: "failed", created_at: "2026-07-22T00:00:00Z" });
    expect(latestFinal([older, newer])?.id).toBe("new");
    expect(previousFinals([older, newer]).map((x) => x.id)).toEqual(["old"]);
  });

  it("older running + newer failed still blocks a new start (duplicate guard)", () => {
    const olderRunning = mk({ id: "old", status: "running", created_at: "2026-07-20T00:00:00Z" });
    const newerFailed = mk({ id: "new", status: "failed", created_at: "2026-07-25T00:00:00Z" });
    expect(hasActiveFinal([olderRunning, newerFailed])).toBe(true);
    expect(canStartFinal({ isOwner: true, audits: [olderRunning, newerFailed], starting: false })).toBe(false);
  });

  it("older running + newer findings still blocks a new start", () => {
    const olderRunning = mk({ id: "old", status: "running", created_at: "2026-07-20T00:00:00Z" });
    const newerFindings = mk({ id: "new", status: "findings", created_at: "2026-07-25T00:00:00Z" });
    expect(hasActiveFinal([olderRunning, newerFindings])).toBe(true);
    expect(canStartFinal({ isOwner: true, audits: [olderRunning, newerFindings], starting: false })).toBe(false);
  });

  it("no running history permits start; empty history permits start", () => {
    expect(hasActiveFinal([mk({ status: "failed" }), mk({ status: "clean" })])).toBe(false);
    expect(hasActiveFinal([])).toBe(false);
    expect(canStartFinal({ isOwner: true, audits: [], starting: false })).toBe(true);
  });

  it("canResumeFinal: only a failed final with a run and completed seat work, owner-only", () => {
    const failed = mk({ status: "failed", run_id: "run-1" });
    expect(canResumeFinal({ isOwner: true, latest: failed, completedAuditSteps: 12, resuming: false })).toBe(true);
    // Nothing paid for yet: a fresh start costs the same, so no resume.
    expect(canResumeFinal({ isOwner: true, latest: failed, completedAuditSteps: 0, resuming: false })).toBe(false);
    // Request already in flight.
    expect(canResumeFinal({ isOwner: true, latest: failed, completedAuditSteps: 12, resuming: true })).toBe(false);
    // Read-only viewers never resume.
    expect(canResumeFinal({ isOwner: false, latest: failed, completedAuditSteps: 12, resuming: false })).toBe(false);
    // Only failed audits resume; a run-less audit row cannot be resumed.
    expect(canResumeFinal({ isOwner: true, latest: mk({ status: "running", run_id: "run-1" }), completedAuditSteps: 12, resuming: false })).toBe(false);
    expect(canResumeFinal({ isOwner: true, latest: mk({ status: "findings", run_id: "run-1" }), completedAuditSteps: 12, resuming: false })).toBe(false);
    expect(canResumeFinal({ isOwner: true, latest: mk({ status: "failed", run_id: null }), completedAuditSteps: 12, resuming: false })).toBe(false);
    expect(canResumeFinal({ isOwner: true, latest: null, completedAuditSteps: 12, resuming: false })).toBe(false);
  });

  it("canOfferFullRescan: only when a successful GitHub final audit (head_sha) exists to diff against", () => {
    expect(canOfferFullRescan([])).toBe(false);
    expect(canOfferFullRescan([mk({ status: "clean", head_sha: "abc" })])).toBe(true);
    expect(canOfferFullRescan([mk({ status: "findings", head_sha: "abc" })])).toBe(true);
    // Paste audits have no commit; failed and running ones are not a base.
    expect(canOfferFullRescan([mk({ status: "findings", head_sha: null })])).toBe(false);
    expect(canOfferFullRescan([mk({ status: "failed", head_sha: "abc" })])).toBe(false);
    expect(canOfferFullRescan([mk({ status: "running", head_sha: "abc" })])).toBe(false);
    // Batch audits never seed an incremental final audit.
    expect(canOfferFullRescan([mk({ kind: "batch", status: "clean", head_sha: "abc" })])).toBe(false);
  });
});
