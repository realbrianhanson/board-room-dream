// Pure state machine for the reset-password page. Extracted so we can prove
// two rules with tests:
//   1. A slow-but-successful Supabase callback (beyond any UI threshold) must
//      never be classified as invalid/expired. The link is only "invalid"
//      after an explicit auth error signal.
//   2. A "taking longer" hint is non-destructive: it does not claim
//      expiration, it only offers a recheck / request-a-new-link path.
//
// Kept intentionally free of React and Supabase imports so it is trivially
// testable and cannot regress via UI refactors.

export type ResetPasswordUiState =
  | "pending"          // waiting for Supabase to hydrate the recovery session
  | "pending_slow"     // still waiting, but past the "taking longer" threshold
  | "ok"               // recovery session ready; form is safe to render
  | "invalid";         // proven-expired / proven-invalid by explicit signal

export type ResetPasswordEvent =
  | { type: "session_ready" }                 // getSession returned a session
  | { type: "auth_event"; event: string }     // supabase.auth.onAuthStateChange
  | { type: "auth_error"; message: string }   // explicit failure signal
  | { type: "slow_threshold" }                // UI hint timer fired
  | { type: "recheck" };                      // user pressed "recheck"

export function initialResetPasswordState(): ResetPasswordUiState {
  return "pending";
}

export function reduceResetPassword(
  state: ResetPasswordUiState,
  event: ResetPasswordEvent,
): ResetPasswordUiState {
  switch (event.type) {
    case "session_ready":
      return "ok";
    case "auth_event":
      // Supabase raises PASSWORD_RECOVERY when the recovery link is consumed
      // and SIGNED_IN once the recovery session is in place. Both mean the
      // form is safe to render; nothing else proves invalidity by itself.
      if (event.event === "PASSWORD_RECOVERY" || event.event === "SIGNED_IN") {
        return "ok";
      }
      return state;
    case "auth_error":
      // Only an explicit auth failure demotes the link to invalid. This
      // deliberately never fires from a UI timer.
      return "invalid";
    case "slow_threshold":
      // A slow callback stays pending; we only surface a softer "taking
      // longer" copy without ever asserting expiration.
      return state === "pending" ? "pending_slow" : state;
    case "recheck":
      // Recheck resets the slow hint but keeps us pending until a real
      // signal (session_ready / auth_event / auth_error) arrives.
      return state === "pending_slow" ? "pending" : state;
  }
}
