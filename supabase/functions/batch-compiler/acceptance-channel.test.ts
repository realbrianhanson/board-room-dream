// PROMPT-CONTRACT-R4: acceptance-check contract must be channel-appropriate.
// supabase-only batches can't validate with preview clicks alone; lovable
// batches keep observable UI interactions; mixed layers keep both.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { skeletonError } from "./validators.ts";

const CLOSE = "\n\nKeep everything else identical.\nTypecheck when done.";
const HEADER = (n: number, t: string) => `Batch ${n} — ${t}. Numbered items only, no scope creep.`;
const filler = "x. ".repeat(0) + "\n" + "1. Do the thing scoped to this batch.\n2. Do the second thing scoped to this batch.\n" + "narrative filler to pad to 900 chars ".repeat(20);

function build(header: string, accept: string[]): string {
  return `${header}\n\n${filler}\n\nAcceptance:\n${accept.join("\n")}${CLOSE}`;
}

Deno.test("skeleton: lovable batch — click-only acceptance is accepted", () => {
  const compiled = build(
    HEADER(3, "Add project card actions"),
    ["1. Click the New project button and see the modal open.", "2. Submit and see the toast."],
  );
  const err = skeletonError(compiled, { title: "Add project card actions", batch_no: 3, channel: "lovable" });
  assertEquals(err, null);
});

Deno.test("skeleton: supabase batch — click-only acceptance is REJECTED", () => {
  const compiled = build(
    HEADER(2, "Add profiles RLS"),
    ["1. Click on Settings and see profile row.", "2. Click Save and see toast."],
  );
  const err = skeletonError(compiled, { title: "Add profiles RLS", batch_no: 2, channel: "supabase" });
  assertEquals(typeof err, "string");
  if (typeof err === "string") assertEquals(err.includes("preview clicks alone"), true);
});

Deno.test("skeleton: supabase batch — backend checks (RLS positive+negative, edge invoke) pass", () => {
  const compiled = build(
    HEADER(2, "Add profiles RLS"),
    [
      "1. Run migration; SELECT from public.profiles as owner succeeds (RLS positive).",
      "2. SELECT from public.profiles as another user returns zero rows (RLS negative).",
      "3. Invoke the key-vault edge function and see HTTP 200 in the response.",
    ],
  );
  const err = skeletonError(compiled, { title: "Add profiles RLS", batch_no: 2, channel: "supabase" });
  assertEquals(err, null);
});

Deno.test("skeleton: mixed UI-wired-to-backend batch on lovable channel still allows preview + network checks", () => {
  const compiled = build(
    HEADER(4, "Wire settings save"),
    [
      "1. Click Save on Settings and see the toast.",
      "2. Reload the page and see the saved value persist (network 200).",
    ],
  );
  const err = skeletonError(compiled, { title: "Wire settings save", batch_no: 4, channel: "lovable" });
  assertEquals(err, null);
});
