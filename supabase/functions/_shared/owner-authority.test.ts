// Unit coverage for the deterministic owner-authority post-validator.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractProvenanceMarkers,
  findUnauthorizedHighImpact,
  injectOwnerAuthority,
  normalize,
  OWNER_AUTHORITY_RULES,
  ownerAuthorityError,
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

Deno.test("preservation / negation language does not trigger", () => {
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

Deno.test("disable of an existing edge function requires authorization", () => {
  const a = auth([{ source: "intake", text: "improvements only" }]);
  const err = ownerAuthorityError("Disable the flywheel-miner edge function and disable the instructor-digest edge function.", a);
  assert(err && /disable_or_retire_existing/.test(err));
});

Deno.test("$0 placeholder amount is skipped", () => {
  const a = auth([]);
  assertEquals(ownerAuthorityError("Charge the customer $0 as a placeholder for now.", a), null);
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
