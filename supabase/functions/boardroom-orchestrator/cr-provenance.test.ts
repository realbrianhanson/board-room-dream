// PROMPT-CONTRACT-AND-STATE-R4: static regression pin — the queues.ts
// ensureAuthority path MUST branch on the LIVE change_requests.status and
// route non-approved CRs to `proposedSources` under `proposed_change_request:<id>`.
// Only status='approved' may be exposed under the executable
// `approved_change_request:<id>` provenance identity.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));

Deno.test("ensureAuthority reads CR status and branches on it", () => {
  const idx = src.indexOf("async function ensureAuthority");
  assert(idx > -1, "ensureAuthority missing");
  const body = src.slice(idx, idx + 3000);
  assertStringIncludes(body, `.select("description, status")`);
  assertStringIncludes(body, `status === "approved"`);
  assertStringIncludes(body, "proposedSources");
});

Deno.test("ensureAuthority uses approved_change_request only for approved status", () => {
  const idx = src.indexOf("async function ensureAuthority");
  const body = src.slice(idx, idx + 3000);
  const approvedIdx = body.indexOf("approved_change_request:");
  const proposedIdx = body.indexOf("proposed_change_request:");
  const statusCheckIdx = body.indexOf('status === "approved"');
  assert(statusCheckIdx > -1, "status check missing");
  assert(approvedIdx > statusCheckIdx, "approved label must be gated by the status check");
  assert(proposedIdx > statusCheckIdx, "proposed label must be gated by the status check");
});
