## 1. Fix the "click Continue twice" bug on the intake wizard

**File:** `src/routes/_authenticated/intake.$intakeId.tsx`

**Cause:** Every text field has `onBlur={() => persist(answers)}`. `persist()` sets `saving=true`. The Continue button is `disabled={... || saving}` and `next()` early-returns when `saving` is true. So clicking Continue first blurs the field (starts a save), which disables/no-ops the button; only the second click lands after saving flips back to false.

**Fix (minimal, UI-only):**
- Remove `saving` from the Continue button's `disabled` (keep `!canProceed || running`).
- Remove the `saving` early-return in `next()` (keep the `running` guard against real double-submit of the validate-intake call).
- `next()` already `await`s its own `persist(answers)`, so the concurrent blur-save is harmless — Supabase update is idempotent for the same row/payload.
- Keep the "Saving…" label logic so users still see the transient state.

## 2. Give the "kill" verdict two real forward paths

**File:** `src/routes/_authenticated/intake.$intakeId.tsx` (`VerdictView` + parent)

Today `VerdictView` on `verdict === "kill"` shows the suggested pivot text and a single "Revise the idea" button that dumps the user back to step 0 with their old answers untouched — the pivot is read-only advice.

Add two explicit CTAs on the kill screen (keep pass path unchanged):

**A. "Take it to the Boardroom anyway"** — secondary button.
- Same handler as the pass path: `navigate({ to: "/boardroom/$projectId", params: { projectId } })`.
- The Boardroom gate/status logic is unchanged; if the project is still `intake` status the existing `CONVENE_BLOCKED.intake` copy will show there. To make this button meaningful, also flip the project forward: update `projects.status` to `validated` (same transition the pass path implicitly relies on via `validate-intake`) so the board can actually convene. Do this via a direct `supabase.from("projects").update({ status: "validated" }).eq("id", projectId)` before navigating; surface any error via toast and stay on the verdict screen on failure.
- Copy makes the trade-off clear, e.g. "The board flagged this. Convene anyway — they'll challenge it live."

**B. "Use the board's pivot"** — primary button, only rendered when `scores.pivot` is a non-empty string.
- Prefills `answers.idea` with the pivot text (replacing the previous idea), clears `verdict`/`scores`, jumps to step 0 so the user can edit and continue forward instead of retyping.
- Persists the new answers immediately (`persist({ ...answers, idea: scores.pivot })`) so a refresh keeps the prefill; on save failure show toast and don't clear the verdict.
- Leaves the other five answers intact — the pivot only rewrites the idea field, which is what the current pivot copy targets.

**C. Keep "Revise the idea"** as a tertiary link/button (unchanged behavior) so users who want to start from their own words still can.

**Layout:** On kill, render the three actions in one row (primary "Use the board's pivot" when available → secondary "Take to the Boardroom anyway" → tertiary "Revise"). When `scores.pivot` is missing, just show the two remaining actions.

## 3. Verification

- Manual: on the current failing intake, confirm Continue advances on the first click; on the kill screen confirm both new buttons appear, "Use the board's pivot" prefills step 1, and "Take to the Boardroom anyway" lands on the Boardroom for the project.
- Automated: run `bunx vitest run` (existing `intake-steps.test.ts` still covers step gating; no schema/logic change needed). Run `bunx tsgo --noEmit`.

## Non-goals

- No change to `validate-intake`, scoring, RLS, project status machine beyond the single `intake → validated` update triggered by the explicit "take to Boardroom anyway" action.
- No change to the greenfield vs import gates in the Boardroom route.
- No styling refactor beyond the new button row on the kill screen.
