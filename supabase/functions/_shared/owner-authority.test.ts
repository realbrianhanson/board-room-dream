// Unit coverage for the deterministic owner-authority post-validator.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractProvenanceMarkers,
  findUnauthorizedHighImpact,
  injectOwnerAuthority,
  normalize,
  OWNER_AUTHORITY_RULES,
  ownerAuthorityError,
  preLockAuthorityError,
  renderBlock,
  type OwnerAuthority,
} from "./owner-authority.ts";

function auth(sources: { source: string; text: string }[]): OwnerAuthority {
  const perSourceNormalized = sources.map((s) => ({ source: s.source, text: normalize(s.text) }));
  return {
    allowed: sources,
    perSourceNormalized,
    allowedNormalized: perSourceNormalized.map((s) => s.text).join(" \n\n "),
    block: renderBlock(sources),
  };
}

Deno.test("empty authority sources — every high-impact directive fails", () => {
  const a = auth([]);
  const err = ownerAuthorityError(
    "1. Add a hosted Stripe payment link and charge $49 per project.",
    a,
  );
  assert(err && /OWNER AUTHORITY VIOLATION/.test(err));
});

Deno.test("verbatim provenance marker allows the directive", () => {
  const a = auth([
    { source: "intake", text: 'I want to charge $49 per reviewed project via a hosted Stripe payment link.' },
  ]);
  const text = `1. Add a hosted Stripe payment link so the founder can charge $49 per reviewed project. [OWNER-AUTHORIZED: source="intake" quote="charge $49 per reviewed project via a hosted Stripe payment link"]`;
  const markers = extractProvenanceMarkers(text, a);
  assertEquals(markers.length, 1);
  assert(markers[0].ok, "quote should match owner source");
  assertEquals(ownerAuthorityError(text, a), null);
});

Deno.test("fabricated quote (not in owner source) fails", () => {
  const a = auth([{ source: "intake", text: "I want a lightweight planning tool." }]);
  const text = `1. Integrate Stripe checkout. [OWNER-AUTHORIZED: source="intake" quote="please add Stripe checkout"]`;
  const markers = extractProvenanceMarkers(text, a);
  assertEquals(markers[0].ok, false);
  assert(ownerAuthorityError(text, a));
});

Deno.test("marker citing an unknown source fails", () => {
  const a = auth([{ source: "intake", text: "code audit only." }]);
  const text = `1. Add Stripe. [OWNER-AUTHORIZED: source="approved_change_request:zzz" quote="add Stripe"]`;
  assert(ownerAuthorityError(text, a));
});

Deno.test("preservation / negation language does not trigger on own line", () => {
  const a = auth([{ source: "intake", text: "improvements only" }]);
  const cases = [
    "Preserve the existing Stripe integration and fix a bug in the webhook signature check.",
    "Do not add Stripe or any payment provider.",
    "Never introduce a paywall.",
    "Keep existing Paddle integration untouched.",
    "The audit found that Stripe already exists — do not remove it.",
  ];
  for (const t of cases) {
    assertEquals(ownerAuthorityError(t, a), null, `false positive on: ${t}`);
  }
});

Deno.test("REGRESSION: 'Do not add X' on one line does NOT authorize an 'Add X' on the next line", () => {
  const a = auth([]);
  const text = "Do not add Stripe.\nAdd Stripe checkout for $49.";
  const issues = findUnauthorizedHighImpact(text, a);
  // Should catch both the payment_provider directive and the $49.
  assert(issues.length >= 1, `expected at least one issue, got ${JSON.stringify(issues)}`);
  assert(issues.some((i) => i.category === "payment_provider_or_checkout"));
});

Deno.test("ordinary RLS hardening does not trigger broaden_auth", () => {
  const a = auth([{ source: "intake", text: "improvements only" }]);
  const t = "Add an owner-scoped RLS policy on public.projects so auth.uid() = user_id. Revoke the public grants that shouldn't exist.";
  assertEquals(ownerAuthorityError(t, a), null);
});

Deno.test("destructive SQL fires regardless of verb", () => {
  const a = auth([{ source: "intake", text: "code audit" }]);
  const err = ownerAuthorityError("Then DROP TABLE public.projects;", a);
  assert(err && /destructive_sql/.test(err));
});

Deno.test("expanded destructive SQL: DROP COLUMN / DROP FUNCTION / TRUNCATE / DELETE FROM WHERE", () => {
  const a = auth([]);
  const cases = [
    "ALTER TABLE foo DROP COLUMN bar;",
    "DROP FUNCTION public.has_role;",
    "DROP POLICY p_owner ON projects;",
    "DROP VIEW v_summary;",
    "DROP SCHEMA private CASCADE;",
    "TRUNCATE TABLE audit_findings;",
    "DELETE FROM boardroom_runs WHERE created_at < now() - interval '30 days';",
  ];
  for (const t of cases) {
    const err = ownerAuthorityError(t, a);
    assert(err && /destructive_sql/.test(err), `no destructive_sql for: ${t}`);
  }
});

Deno.test("disable of an existing edge function requires authorization", () => {
  const a = auth([{ source: "intake", text: "improvements only" }]);
  const err = ownerAuthorityError("Disable the flywheel-miner edge function and disable the instructor-digest edge function.", a);
  assert(err && /disable_or_retire_existing/.test(err));
});

Deno.test("$0 placeholder amount is skipped", () => {
  const a = auth([]);
  assertEquals(ownerAuthorityError("Charge the customer $0 as a placeholder for now.", a), null);
});

Deno.test("payment verbs expanded: use/wire/connect/set up/migrate to", () => {
  const a = auth([]);
  const cases = [
    "Use Stripe payment link.",
    "Wire up Stripe checkout session.",
    "Connect Stripe billing portal.",
    "Set up Stripe subscription billing.",
    "Migrate to Paddle payment link.",
  ];
  for (const t of cases) {
    const err = ownerAuthorityError(t, a);
    assert(err && /payment_provider_or_checkout/.test(err), `no payment hit for: ${t}`);
  }
});

Deno.test("new_external_integration detects new third-party providers", () => {
  const a = auth([]);
  const cases = [
    "Add SendGrid for transactional email.",
    "Integrate Twilio for SMS.",
    "Set up Sentry for error tracking.",
    "Connect Intercom for support chat.",
    "Add a new external provider for analytics.",
  ];
  for (const t of cases) {
    const err = ownerAuthorityError(t, a);
    assert(err && /new_external_integration/.test(err), `no external-integration hit for: ${t}`);
  }
});

Deno.test("preserving/fixing a repo-proven integration does not count as new_external_integration", () => {
  const a = auth([]);
  const cases = [
    "Preserve the existing SendGrid integration and fix the retry loop.",
    "Do not add Twilio; keep the current provider.",
    "Keep existing Sentry setup; only fix the release tag.",
  ];
  for (const t of cases) {
    assertEquals(ownerAuthorityError(t, a), null, `false positive on: ${t}`);
  }
});

Deno.test("REGRESSION: marker quote of one category cannot cover a different category", () => {
  // Intake authorizes "$49" only. It must NOT authorize "disable instructor-digest".
  const a = auth([
    { source: "intake", text: "charge $49 per reviewed project via a hosted Stripe payment link" },
  ]);
  const text = `1. Disable the instructor-digest edge function. [OWNER-AUTHORIZED: source="intake" quote="charge $49 per reviewed project via a hosted Stripe payment link"]`;
  const err = ownerAuthorityError(text, a);
  assert(err && /disable_or_retire_existing/.test(err), `cross-category authorization should fail: ${err}`);
});

Deno.test("REGRESSION: Stripe quote cannot authorize DROP TABLE", () => {
  const a = auth([{ source: "intake", text: "add a hosted Stripe payment link" }]);
  const text = `DROP TABLE public.projects; [OWNER-AUTHORIZED: source="intake" quote="add a hosted Stripe payment link"]`;
  const err = ownerAuthorityError(text, a);
  assert(err && /destructive_sql/.test(err));
});

Deno.test("REGRESSION: marker on same line covers the directive; marker on line+2 does not", () => {
  const a = auth([{ source: "intake", text: "add stripe checkout for $49" }]);
  const sameLine = `Add Stripe checkout for $49. [OWNER-AUTHORIZED: source="intake" quote="add stripe checkout for $49"]`;
  assertEquals(ownerAuthorityError(sameLine, a), null);
  const nextLine = `Add Stripe checkout for $49.\n[OWNER-AUTHORIZED: source="intake" quote="add stripe checkout for $49"]`;
  assertEquals(ownerAuthorityError(nextLine, a), null);
  const twoLines = `Add Stripe checkout for $49.\n\n[OWNER-AUTHORIZED: source="intake" quote="add stripe checkout for $49"]`;
  assert(ownerAuthorityError(twoLines, a), "marker two lines away must NOT cover");
});

Deno.test("REGRESSION: exact live bad case is blocked and not paste-ready", () => {
  const a = auth([
    { source: "intake", text: "please audit the code, review the design, and suggest improvements only." },
  ]);
  const lockedPlan = `1. Add a hosted Stripe payment link so the founder can charge $49 per reviewed project.
2. Disable the flywheel-miner edge function.
3. Disable the instructor-digest edge function.`;
  const err = preLockAuthorityError([{ label: "plan.content_md", text: lockedPlan }], a);
  assert(err && /proposal_requires_owner_approval/.test(err));
  assert(/monetary_amount/.test(err));
  assert(/payment_provider_or_checkout/.test(err));
  assert(/disable_or_retire_existing/.test(err));
});

Deno.test("REGRESSION: paraphrased provenance still fails; verbatim passes", () => {
  const a = auth([
    { source: "intake", text: "I want to charge fifty bucks per reviewed project via a hosted Stripe payment link." },
  ]);
  const paraphrased = `1. Add a hosted Stripe payment link and charge $50 per reviewed project. [OWNER-AUTHORIZED: source="intake" quote="charge $50 via hosted Stripe payment link"]`;
  assert(ownerAuthorityError(paraphrased, a));
});

Deno.test("injectOwnerAuthority prepends rules to system and block to string user", () => {
  const a = auth([{ source: "intake", text: "hello" }]);
  const { system, user } = injectOwnerAuthority("You are the Chair.", "Do the thing.", a);
  assert(system.startsWith(OWNER_AUTHORITY_RULES));
  assert(system.endsWith("You are the Chair."));
  assert(typeof user === "string" && (user as string).includes("OWNER AUTHORITY SOURCES") && (user as string).endsWith("Do the thing."));
});

Deno.test("injectOwnerAuthority handles multi-part (image) user content", () => {
  const a = auth([]);
  const { user } = injectOwnerAuthority(
    "sys",
    [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: "x" } }],
    a,
  );
  assert(Array.isArray(user));
  const first = (user as any[]).find((p) => p.type === "text");
  assert(first.text.includes("OWNER AUTHORITY SOURCES"));
});

Deno.test("findUnauthorizedHighImpact dedupes identical snippets across categories", () => {
  const a = auth([]);
  const t = "Add Stripe checkout. Add Stripe checkout. Add Stripe checkout.";
  const issues = findUnauthorizedHighImpact(t, a);
  assertEquals(issues.length, 1);
});

Deno.test("preLockAuthorityError returns null when all artifacts are clean", () => {
  const a = auth([{ source: "intake", text: "improvements only" }]);
  const artifacts = [
    { label: "plan", text: "Add an owner-scoped RLS policy on public.projects." },
    { label: "prd", text: "Preserve the existing Sentry integration and fix the release tag." },
  ];
  assertEquals(preLockAuthorityError(artifacts, a), null);
});

Deno.test("preLockAuthorityError aggregates violations across artifacts", () => {
  const a = auth([]);
  const artifacts = [
    { label: "plan.content_md", text: "1. Add Stripe checkout for $49." },
    { label: "batch[3].prompt_md", text: "Disable the flywheel-miner edge function." },
  ];
  const err = preLockAuthorityError(artifacts, a);
  assert(err && /plan\.content_md/.test(err) && /batch\[3\]\.prompt_md/.test(err));
});
