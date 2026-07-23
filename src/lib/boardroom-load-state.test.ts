import { describe, it, expect } from "vitest";
import {
  initialBoardroomLoadState,
  reduceBoardroomLoad,
} from "./boardroom-load-state";

type Run = { id: string };

describe("boardroom load state", () => {
  it("initial error surfaces error, not empty transcript", () => {
    let s = initialBoardroomLoadState<Run>();
    s = reduceBoardroomLoad(s, { type: "load_start" });
    s = reduceBoardroomLoad(s, { type: "load_error", error: "boom" });
    expect(s.status).toBe("error");
    expect(s.data).toBeNull();
    expect(s.error).toBe("boom");
    expect(s.stale).toBe(false);
  });

  it("retry after error goes back to loading and clears error", () => {
    let s = initialBoardroomLoadState<Run>();
    s = reduceBoardroomLoad(s, { type: "load_error", error: "boom" });
    s = reduceBoardroomLoad(s, { type: "retry" });
    expect(s.status).toBe("loading");
    expect(s.error).toBeNull();
    s = reduceBoardroomLoad(s, { type: "load_success", data: { id: "r1" } });
    expect(s.status).toBe("ok");
    expect(s.data).toEqual({ id: "r1" });
  });

  it("background refresh error preserves last good data and marks stale", () => {
    let s = initialBoardroomLoadState<Run>();
    s = reduceBoardroomLoad(s, { type: "load_success", data: { id: "r1" } });
    s = reduceBoardroomLoad(s, { type: "load_start" });
    s = reduceBoardroomLoad(s, { type: "load_error", error: "network" });
    expect(s.status).toBe("ok");
    expect(s.data).toEqual({ id: "r1" });
    expect(s.stale).toBe(true);
    expect(s.error).toBe("network");
  });

  it("empty success is distinct from error (null data with status=ok)", () => {
    let s = initialBoardroomLoadState<Run | null>();
    s = reduceBoardroomLoad(s, { type: "load_success", data: null });
    expect(s.status).toBe("ok");
    expect(s.data).toBeNull();
    expect(s.error).toBeNull();
    expect(s.stale).toBe(false);
  });
});
