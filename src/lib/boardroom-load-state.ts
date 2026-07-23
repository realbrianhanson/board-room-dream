// Pure state model for boardroom-session load lifecycle. Extracted so tests
// can prove:
//   - initial load errors do not silently become "preparing…"
//   - a background refresh error preserves the last good data but marks it stale
//   - empty-success is distinct from error
//   - explicit retry clears stale/error and returns to loading

export type BoardroomLoadState<T> = {
  status: "idle" | "loading" | "ok" | "error";
  data: T | null;
  error: string | null;
  stale: boolean;
};

export type BoardroomLoadEvent<T> =
  | { type: "load_start" }
  | { type: "load_success"; data: T }
  | { type: "load_error"; error: string }
  | { type: "retry" };

export function initialBoardroomLoadState<T>(): BoardroomLoadState<T> {
  return { status: "idle", data: null, error: null, stale: false };
}

export function reduceBoardroomLoad<T>(
  state: BoardroomLoadState<T>,
  event: BoardroomLoadEvent<T>,
): BoardroomLoadState<T> {
  switch (event.type) {
    case "load_start":
      // Keep last good data on screen while re-loading; do not blank it.
      return { ...state, status: "loading", error: null };
    case "load_success":
      return { status: "ok", data: event.data, error: null, stale: false };
    case "load_error":
      if (state.data !== null) {
        // Background refresh failure: preserve last good data, mark stale so
        // the UI can label it and offer retry. Never silently swallow.
        return { status: "ok", data: state.data, error: event.error, stale: true };
      }
      return { status: "error", data: null, error: event.error, stale: false };
    case "retry":
      return { ...state, status: "loading", error: null };
  }
}
