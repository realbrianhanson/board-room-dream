// Design Round-3 input diet (RC-4): draftsBlock can bound each Round-1 draft
// so the Chair's synthesis prompt stays inside the proxy abort. Unset cap =
// full drafts (Round 2 exams need them whole).
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { draftsBlock } from "./protocol.ts";
import { DESIGN_R3_ARTIFACT_CAP, DESIGN_R3_DRAFT_CAP } from "./queues.ts";

const steps = [
  { step_key: "r1_draft_chair", status: "completed", response_text: "C".repeat(9_000) },
  { step_key: "r1_draft_strategist", status: "completed", response_text: "short strategist draft" },
  { step_key: "r1_draft_contrarian", status: "failed", response_text: "ignored" },
  { step_key: "r1_draft_inspector", status: "completed", response_text: "I".repeat(6_000) },
];

Deno.test("draftsBlock: no cap keeps every draft whole (Round 2 behaviour unchanged)", () => {
  const out = draftsBlock(steps);
  assertStringIncludes(out, "C".repeat(9_000));
  assertStringIncludes(out, "(no draft)");
  assert(!out.includes("[draft truncated"));
});

Deno.test("draftsBlock: a per-draft cap bounds long drafts with a note and leaves short ones alone", () => {
  const out = draftsBlock(steps, undefined, 6_000);
  assert(!out.includes("C".repeat(6_001)), "chair draft is cut at the cap");
  assertStringIncludes(out, "C".repeat(6_000));
  assertStringIncludes(out, "[draft truncated at 6000 chars of 9000]");
  assertStringIncludes(out, "I".repeat(6_000), "a draft exactly at the cap is untouched");
  assert(!out.includes("of 6000]"));
  assertStringIncludes(out, "short strategist draft");
  // forSeat still excludes the seat's own draft.
  assert(!draftsBlock(steps, "chair", 6_000).includes("(chair) DRAFT"));
});

Deno.test("draftsBlock: the cap never splits a surrogate pair", () => {
  const emoji = "\u{1F600}"; // two UTF-16 code units
  const text = "x".repeat(99) + emoji + "tail";
  const out = draftsBlock([{ step_key: "r1_draft_chair", status: "completed", response_text: text }], undefined, 100);
  assert(!out.includes("\uD83D\n"), "no dangling high surrogate before the note");
  assertStringIncludes(out, "x".repeat(99) + "\n\n[draft truncated at 100 chars");
});

Deno.test("design R3 caps: 8,000-char artifact excerpts and 6,000-char drafts", () => {
  assertEquals(DESIGN_R3_ARTIFACT_CAP, 8_000);
  assertEquals(DESIGN_R3_DRAFT_CAP, 6_000);
});
