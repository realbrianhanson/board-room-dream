// Pure reducer for a fail-closed "load a settings row" flow. Save must be
// disabled until the source values loaded successfully; a failure must
// surface a Retry state, not a blank editable form.

export type SettingsLoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };

export type SettingsLoadAction<T> =
  | { type: "retry" }
  | { type: "success"; value: T }
  | { type: "failure"; message: string };

export function initialSettingsLoadState<T>(): SettingsLoadState<T> {
  return { kind: "loading" };
}

export function settingsLoadReducer<T>(
  state: SettingsLoadState<T>,
  action: SettingsLoadAction<T>,
): SettingsLoadState<T> {
  switch (action.type) {
    case "retry":
      return { kind: "loading" };
    case "success":
      return { kind: "ready", value: action.value };
    case "failure":
      return {
        kind: "error",
        message: action.message?.trim() || "Failed to load settings",
      };
  }
}

export function isSaveEnabled<T>(state: SettingsLoadState<T>): boolean {
  return state.kind === "ready";
}
