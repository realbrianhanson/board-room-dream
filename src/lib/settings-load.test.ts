import { describe, expect, it } from "vitest";
import {
  initialSettingsLoadState,
  isSaveEnabled,
  settingsLoadReducer,
} from "./settings-load";

describe("settingsLoadReducer", () => {
  it("starts loading with Save disabled", () => {
    const s = initialSettingsLoadState<{ text: string }>();
    expect(s.kind).toBe("loading");
    expect(isSaveEnabled(s)).toBe(false);
  });

  it("success -> ready enables Save", () => {
    const s = settingsLoadReducer(
      initialSettingsLoadState<{ text: string }>(),
      { type: "success", value: { text: "v1" } },
    );
    expect(s).toEqual({ kind: "ready", value: { text: "v1" } });
    expect(isSaveEnabled(s)).toBe(true);
  });

  it("failure -> error keeps Save disabled and preserves message", () => {
    const s = settingsLoadReducer(
      initialSettingsLoadState<{ text: string }>(),
      { type: "failure", message: "network down" },
    );
    expect(s).toEqual({ kind: "error", message: "network down" });
    expect(isSaveEnabled(s)).toBe(false);
  });

  it("failure with blank message falls back to human default", () => {
    const s = settingsLoadReducer(
      initialSettingsLoadState<{ text: string }>(),
      { type: "failure", message: "   " },
    );
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.message).toBe("Failed to load settings");
  });

  it("retry from error returns to loading with Save disabled", () => {
    const err = settingsLoadReducer(
      initialSettingsLoadState<{ text: string }>(),
      { type: "failure", message: "x" },
    );
    const loading = settingsLoadReducer(err, { type: "retry" });
    expect(loading).toEqual({ kind: "loading" });
    expect(isSaveEnabled(loading)).toBe(false);
  });

  it("retry -> later success re-enables Save", () => {
    let s = settingsLoadReducer(
      initialSettingsLoadState<{ text: string }>(),
      { type: "failure", message: "x" },
    );
    s = settingsLoadReducer(s, { type: "retry" });
    s = settingsLoadReducer(s, { type: "success", value: { text: "v2" } });
    expect(s).toEqual({ kind: "ready", value: { text: "v2" } });
    expect(isSaveEnabled(s)).toBe(true);
  });
});
