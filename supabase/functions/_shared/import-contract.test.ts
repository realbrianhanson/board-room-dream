// Tests for the shared IMPORT audit contract renderer. Covers a full
// modern intake and a legacy import with only description + goals.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderImportContract } from "./import-contract.ts";

Deno.test("renderImportContract serializes every owner-supplied field for a full modern intake", () => {
  const out = renderImportContract({
    imported: true,
    description: "A tiny CRM for one-person consulting shops.",
    goals: ["code_audit", "improvements"],
    buyer: "solo consultants billing hourly",
    paid_offer: "monthly workspace subscription",
    price_anchor: "$19/mo",
    upgrade_trigger: "second client added",
    activation_moment: "creating the first client and logging one entry",
    wow_moment: "generating a signable weekly invoice in one click",
    positioning: "Unlike HubSpot, this app fits on one page",
  });
  assertStringIncludes(out, "IMPORTED APP");
  assertStringIncludes(out, "Description: A tiny CRM");
  assertStringIncludes(out, "Buyer: solo consultants");
  assertStringIncludes(out, "Paid offer: monthly workspace subscription");
  assertStringIncludes(out, "Price anchor: $19/mo");
  assertStringIncludes(out, "Upgrade trigger: second client added");
  assertStringIncludes(out, "First-90-second activation moment: creating");
  assertStringIncludes(out, "Wow moment: generating a signable weekly invoice");
  assertStringIncludes(out, "Positioning (Unlike ___, this app ___): Unlike HubSpot");
  assertStringIncludes(out, "Stated goals for the board: code_audit, improvements");
  // Every owner-supplied field must render as "Label: value", not the
  // "(not supplied by owner — …)" placeholder used for missing fields.
  // The renderer's header text also mentions the placeholder, so match on
  // the placeholder used at the start of a field line instead.
  assert(!/:\s\(not supplied by owner/.test(out));
});

Deno.test("renderImportContract marks legacy import missing fields as not supplied", () => {
  const out = renderImportContract({
    imported: true,
    description: "Old import.",
    goals: ["code_audit"],
  });
  assertStringIncludes(out, "Description: Old import.");
  assertStringIncludes(out, "Buyer: (not supplied by owner");
  assertStringIncludes(out, "Paid offer: (not supplied by owner");
  assertStringIncludes(out, "Price anchor: (not supplied by owner");
  assertStringIncludes(out, "Upgrade trigger: (not supplied by owner");
  assertStringIncludes(out, "First-90-second activation moment: (not supplied by owner");
  assertStringIncludes(out, "Wow moment: (not supplied by owner");
  assertStringIncludes(out, "Positioning (Unlike ___, this app ___): (not supplied by owner");
});

Deno.test("renderImportContract instructs the board never to invent missing context", () => {
  const out = renderImportContract({ imported: true, description: "x" });
  assertStringIncludes(out, "MUST NOT invent");
});
