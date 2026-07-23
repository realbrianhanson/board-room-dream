import { describe, it, expect } from "vitest";
import { groupOpenFindingsByAudit } from "./audit-findings-grouping";

const audits = [
  { id: "af-new", batch_id: null, kind: "final_az" as const, status: "findings", created_at: "2026-07-20T00:00:00Z", head_sha: "abcdef1234567" },
  { id: "af-old", batch_id: null, kind: "final_az" as const, status: "clean",    created_at: "2026-07-01T00:00:00Z", head_sha: "9999999" },
  { id: "ab-1",   batch_id: "b1", kind: "batch" as const,    status: "findings", created_at: "2026-07-10T00:00:00Z" },
];
const batches = [{ id: "b1", batch_no: 3 }];

describe("groupOpenFindingsByAudit", () => {
  it("labels and orders groups", () => {
    const findings = [
      { id: "f1", audit_id: "af-new", status: "open" },
      { id: "f2", audit_id: "af-old", status: "open" },
      { id: "f3", audit_id: "ab-1",   status: "fix_drafted" },
      { id: "f4", audit_id: "af-new", status: "resolved" }, // filtered out
    ];
    const groups = groupOpenFindingsByAudit(audits, findings, batches);
    expect(groups.map((g) => g.label)).toEqual([
      "Current final audit",
      expect.stringMatching(/^Batch 3 ·/),
      expect.stringMatching(/^Previous final audit ·/),
    ]);
    expect(groups[0].findings.map((f) => f.id)).toEqual(["f1"]);
  });

  it("returns empty when no openable findings", () => {
    expect(groupOpenFindingsByAudit(audits, [], batches)).toEqual([]);
  });

  it("falls back gracefully for orphaned findings", () => {
    const groups = groupOpenFindingsByAudit(audits, [
      { id: "x", audit_id: "missing", status: "open" },
    ], batches);
    expect(groups[0].label).toBe("Unknown audit");
  });

  it("does not let a newer failed final displace the latest successful final", () => {
    // A newer failed/running final MUST NOT be labeled 'Current final audit'.
    // The successful older one keeps that label; the failed newer one, if it
    // has open findings, is labeled 'Previous final audit · …'.
    const withFailedNewer = [
      { id: "af-fail", batch_id: null, kind: "final_az" as const, status: "failed",   created_at: "2026-07-22T00:00:00Z", head_sha: "deadbee" },
      { id: "af-good", batch_id: null, kind: "final_az" as const, status: "findings", created_at: "2026-07-20T00:00:00Z", head_sha: "abcdef1" },
    ];
    const groups = groupOpenFindingsByAudit(withFailedNewer, [
      { id: "g1", audit_id: "af-good", status: "open" },
      { id: "g2", audit_id: "af-fail", status: "open" },
    ], []);
    const good = groups.find((g) => g.auditId === "af-good")!;
    const fail = groups.find((g) => g.auditId === "af-fail")!;
    expect(good.label).toBe("Current final audit");
    expect(fail.label).toMatch(/^Previous final audit ·/);
  });

  it("chooses no current final when every final is non-terminal", () => {
    const running = [
      { id: "af-run", batch_id: null, kind: "final_az" as const, status: "running", created_at: "2026-07-22T00:00:00Z", head_sha: "abcdef1" },
    ];
    const groups = groupOpenFindingsByAudit(running, [
      { id: "r1", audit_id: "af-run", status: "open" },
    ], []);
    expect(groups[0].label).toMatch(/^Previous final audit ·/);
  });
});

