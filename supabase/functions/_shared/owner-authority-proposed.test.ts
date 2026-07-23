// PROMPT-CONTRACT-AND-STATE-R4: change-request provenance may only be
// asserted as "approved_change_request" after the Chair has recorded an
// approving verdict AND change_requests.status transitioned to 'approved'.
// Pending / rejected / revision / unknown must be exposed only as an
// untrusted PROPOSED source ("proposed_change_request:<id>"). Any marker
// citing a proposed source fails the deterministic post-validator by
// construction because proposed sources are NOT in `allowed`.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadOwnerAuthority, validateProvenance } from "../_shared/owner-authority.ts";

function fakeAdmin(cr?: { description?: string | null }) {
  return {
    from(table: string) {
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({ data: null }),
        then: undefined,
      };
      if (table === "change_requests") {
        // Loader also does a plain SELECT for approved CRs — return [].
        chain.select = () => ({
          eq: () => ({ eq: () => ({ then: (res: any) => Promise.resolve({ data: [] }).then(res) }) }),
        });
      }
      if (table === "intakes") {
        chain.maybeSingle = async () => ({ data: null });
      }
      return chain;
    },
  } as any;
}

Deno.test("proposed CR is rendered in block but not in allowed sources", async () => {
  const admin = fakeAdmin();
  const auth = await loadOwnerAuthority(admin, {
    projectId: "p1",
    proposedSources: [
      { source: "proposed_change_request:cr-abc", text: "Add Stripe checkout for $49." },
    ],
  });

  // NOT allowed → cannot be cited via [OWNER-AUTHORIZED].
  assertEquals(auth.allowed.length, 0);
  assertEquals(auth.perSourceNormalized.length, 0);

  // Rendered in the block under the PROPOSED — NOT YET AUTHORIZED section.
  assertStringIncludes(auth.block, "PROPOSED — NOT YET AUTHORIZED");
  assertStringIncludes(auth.block, "source=proposed_change_request:cr-abc");
  assertStringIncludes(auth.block, "Add Stripe checkout for $49.");
});

Deno.test("marker citing a proposed_change_request source is rejected", async () => {
  const auth = await loadOwnerAuthority(fakeAdmin(), {
    projectId: "p1",
    proposedSources: [
      { source: "proposed_change_request:cr-abc", text: "Add Stripe checkout for $49." },
    ],
  });

  const modelOutput = `Enable Stripe checkout for $49.\n[OWNER-AUTHORIZED: source="proposed_change_request:cr-abc" quote="Add Stripe checkout for $49."]`;
  const report = validateProvenance(modelOutput, auth);
  assert(
    report.unauthorized.length > 0,
    "proposed_change_request must not authorize a $49/Stripe directive",
  );
  // Explicit: the marker's source is not present in `allowed`.
  const markerOk = report.markers?.some((m) => m.ok) ?? false;
  assert(!markerOk, "no marker should validate against a proposed source");
});

Deno.test("approved CR provenance still authorizes when routed as extraFounderNotes", async () => {
  const auth = await loadOwnerAuthority(fakeAdmin(), {
    projectId: "p1",
    extraFounderNotes: [
      { source: "approved_change_request:cr-abc", text: "Add Stripe checkout for $49." },
    ],
  });
  const modelOutput = `Enable Stripe checkout for $49.\n[OWNER-AUTHORIZED: source="approved_change_request:cr-abc" quote="Add Stripe checkout for $49."]`;
  const report = validateProvenance(modelOutput, auth);
  assertEquals(report.unauthorized.length, 0, JSON.stringify(report.unauthorized));
});
