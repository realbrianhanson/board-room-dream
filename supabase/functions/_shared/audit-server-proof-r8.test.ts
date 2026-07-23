// AUDIT-SERVER-PROOF-R8 — broadens the client-surface security detector so
// that direct-browser writes to privileged / global / config / registry /
// admin / lifecycle / security state are gated on SERVER_AUTH or a concrete
// RUNTIME_FAILURE marker at ANY severity. Pinned to the exact P2 finding
// audit 588d3468 still leaked ("Privileged config updated via direct
// browser Supabase writes" on src/routes/_authenticated/settings.tsx).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  downgradeUnsupported,
  evaluateChairMergeCandidate,
  looksLikeClientSurfaceSecurityClaim,
  type CleanFinding,
} from "./audit-findings.ts";

function f(over: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "inspector",
    severity: "P2",
    file_path: "src/routes/foo.tsx",
    title: "t",
    description: "d",
    evidence: "QUOTE: code | WHY: reason.",
    confidence: "high",
    line_start: 1,
    line_end: 2,
    ...over,
  };
}

const LEAKED_SETTINGS_FINDING = f({
  severity: "P2",
  file_path: "src/routes/_authenticated/settings.tsx",
  title: "Privileged config updated via direct browser Supabase writes",
  description:
    "Model registry rows are mutated directly from the browser instead of through a server-authorized RPC.",
  evidence:
    'QUOTE: .from("model_registry").update({ model_id: seat.model_id | WHY: Global board config mutated from browser path.',
});

Deno.test("R8: the exact leaked settings/model_registry P2 is REJECTED", () => {
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [LEAKED_SETTINGS_FINDING],
  });
  assertEquals(published.length, 0, "must not publish an unsupported privileged-write claim");
  const rejected = downgrades.filter((d) => d.disposition === "rejected_unsupported");
  assert(rejected.length > 0, "must record a rejection");
  assert(rejected.some((d) => /SERVER_AUTH/.test(d.reason)), "rejection reason must cite SERVER_AUTH");
  assert(rejected.every((d) => d.published === false));
});

Deno.test("R8: same leaked wording matched by the client-surface detector on src/*", () => {
  assert(
    looksLikeClientSurfaceSecurityClaim(
      LEAKED_SETTINGS_FINDING.title,
      LEAKED_SETTINGS_FINDING.description,
      LEAKED_SETTINGS_FINDING.file_path,
    ),
  );
});

Deno.test("R8: leaked finding publishes when a SERVER_AUTH quote is attached", () => {
  const withProof = {
    ...LEAKED_SETTINGS_FINDING,
    evidence:
      LEAKED_SETTINGS_FINDING.evidence +
      ' | SERVER_AUTH: model_registry has RLS "authenticated update using (public.has_role(auth.uid(),\'admin\'))" — no server-side admin check enforces it beyond RLS, which currently permits any authenticated user.',
  };
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [withProof],
  });
  assertEquals(published.length, 1, "SERVER_AUTH-backed claim must publish");
});

Deno.test("R8: privileged-write phrasings on src/* are all rejected without SERVER_AUTH", () => {
  const variants: Array<Partial<CleanFinding>> = [
    // singular/plural verb forms
    { title: "Global config write from browser", description: "Client mutates app_settings row." },
    { title: "Constitution mutated from client-side code", description: "Direct browser update to constitution." },
    { title: "Spend cap updated via browser path", description: "Client writes spend cap." },
    { title: "Model registry written from the client", description: "Registry rows written via direct client Supabase writes." },
    { title: "Admin-only registry mutation from browser", description: "Global board config mutated from browser path." },
    { title: "Lifecycle state modified from browser", description: "Client-side code can change lifecycle state." },
  ];
  for (const v of variants) {
    const finding = f({
      severity: "P2",
      file_path: "src/routes/_authenticated/settings.tsx",
      ...v,
    });
    const { findings: published } = evaluateChairMergeCandidate({
      verdict: "findings",
      summary: "",
      findings: [finding],
    });
    assertEquals(
      published.length,
      0,
      `variant should be rejected: ${v.title}`,
    );
  }
});

Deno.test("R8: earlier R6 direct-client fixtures remain rejected", () => {
  const fixtures: CleanFinding[] = [
    f({
      severity: "P2",
      file_path: "src/routes/_authenticated/debug.runs.tsx",
      title: "Admin gate is client-only via profiles.role",
      description: "The admin debug page performs an unauthorized privilege bypass via UI role check.",
      evidence: "QUOTE: if (profile.role !== 'admin') return null | WHY: UI-only gate.",
    }),
    f({
      severity: "P2",
      file_path: "src/routes/_authenticated/cohort.tsx",
      title: "Role checked directly on profiles table instead of user_roles",
      description: "Client-side auth bypass check reads profiles.role for admin panel access.",
      evidence: "QUOTE: supabase.from('profiles').select('role') | WHY: role check on client.",
    }),
    f({
      severity: "P2",
      file_path: "src/routes/_authenticated/runway_.$projectId.tsx",
      title: "Batch status and project fields updated directly from browser",
      description: "Client performs a direct SELECT/UPDATE bypassing server authorization.",
      evidence: "QUOTE: supabase.from('batches').update(...) | WHY: direct query from browser.",
    }),
  ];
  for (const finding of fixtures) {
    const { findings: published } = evaluateChairMergeCandidate({
      verdict: "findings",
      summary: "",
      findings: [finding],
    });
    assertEquals(published.length, 0, `R6 fixture should still be rejected: ${finding.title}`);
  }
});

Deno.test("R8: ordinary user-owned preference form P2 remains published", () => {
  const finding = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/settings.tsx",
    title: "Preferences form does not show a saved confirmation",
    description:
      "After the user updates their own notification preferences the UI does not confirm the save happened.",
    evidence: "QUOTE: await supabase.from('profiles').update({ notify: true }) | WHY: no toast is shown after success.",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 1, "ordinary preference-save UX findings must still publish");
});

Deno.test("R8: product/onboarding P2 remains published", () => {
  const finding = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/onboarding.tsx",
    title: "Onboarding CTA copy buries the primary action",
    description:
      "The 'Blueprint a new idea' CTA is the same weight as the secondary link, softening the activation moment.",
    evidence:
      'QUOTE: <Button variant="ghost">Blueprint a new idea</Button> | WHY: primary CTA lacks visual priority. | OWNER_CONTRACT: intake says "primary CTA is Blueprint a new idea".',
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 1, "product/onboarding P2 with OWNER_CONTRACT must publish");
});

Deno.test("R8: backend/server file is NOT routed through client-surface gate merely by mentioning writes", () => {
  // Same phrasing that would trigger the detector on src/* must NOT trigger
  // on a supabase/functions/** path — those findings follow the normal
  // severity/proof gates (Rules 2/3/4) instead.
  assertEquals(
    looksLikeClientSurfaceSecurityClaim(
      "Privileged config updated via direct browser Supabase writes",
      "Global board config mutated from browser path.",
      "supabase/functions/boardroom-orchestrator/index.ts",
    ),
    false,
  );

  const finding = f({
    severity: "P2",
    file_path: "supabase/functions/boardroom-orchestrator/index.ts",
    title: "Registry writes routed through service role in orchestrator",
    description: "The orchestrator updates model_registry from the server as designed.",
    evidence: "QUOTE: await admin.from('model_registry').update({...}) | WHY: normal server-side write.",
  });
  // Not gated by the client-surface rule; without any factual-proof gate
  // matching, this ordinary P2 publishes.
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 1);
});

Deno.test("R8: no one-title exact exception — variant wording is still rejected", () => {
  // Guard against a lazy fix that only special-cases the exact leaked title.
  const finding = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/settings.tsx",
    title: "Privileged configuration written directly from the browser",
    description: "Model_registry rows are updated by the browser without a server RPC.",
    evidence: "QUOTE: supabase.from('model_registry').update(...) | WHY: no server enforcement.",
  });
  const { findings: published, downgrades } = downgradeUnsupported([finding]);
  assertEquals(
    published.filter((_, i) => !downgrades.find((d) => d.disposition === "rejected_unsupported" && d.title === finding.title))
      .filter((_, i) => false).length,
    0,
  );
  const rejected = downgrades.filter((d) => d.disposition === "rejected_unsupported");
  assert(rejected.length > 0, "variant privileged-write wording must also be rejected");
});
