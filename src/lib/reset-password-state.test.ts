import { describe, it, expect } from "vitest";
import {
  initialResetPasswordState,
  reduceResetPassword,
} from "./reset-password-state";

describe("reset-password state machine", () => {
  it("starts pending", () => {
    expect(initialResetPasswordState()).toBe("pending");
  });

  it("does NOT flip to invalid after a slow threshold (slow success still succeeds)", () => {
    let s = initialResetPasswordState();
    // 5s+ passes and the UI fires its "taking longer" hint. This must stay
    // non-destructive: no invalid, only pending_slow.
    s = reduceResetPassword(s, { type: "slow_threshold" });
    expect(s).toBe("pending_slow");
    // Supabase eventually delivers the recovery session; success wins.
    s = reduceResetPassword(s, { type: "session_ready" });
    expect(s).toBe("ok");
  });

  it("PASSWORD_RECOVERY / SIGNED_IN mark the link as valid", () => {
    for (const ev of ["PASSWORD_RECOVERY", "SIGNED_IN"] as const) {
      const s = reduceResetPassword("pending", { type: "auth_event", event: ev });
      expect(s).toBe("ok");
    }
  });

  it("only an explicit auth error proves the link invalid", () => {
    const s = reduceResetPassword("pending_slow", {
      type: "auth_error",
      message: "Token expired",
    });
    expect(s).toBe("invalid");
  });

  it("unrelated auth events do not corrupt state", () => {
    const s = reduceResetPassword("ok", { type: "auth_event", event: "TOKEN_REFRESHED" });
    expect(s).toBe("ok");
  });

  it("recheck clears the slow hint but stays pending until a real signal", () => {
    let s: ReturnType<typeof reduceResetPassword> = "pending_slow";
    s = reduceResetPassword(s, { type: "recheck" });
    expect(s).toBe("pending");
  });

  it("session_ready wins even after a slow hint (regression: no 5s auto-expire)", () => {
    let s = initialResetPasswordState();
    s = reduceResetPassword(s, { type: "slow_threshold" });
    s = reduceResetPassword(s, { type: "session_ready" });
    expect(s).toBe("ok");
  });
});
