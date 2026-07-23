import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractFunctionsErrorMessage, stableStatusMessage } from "./functions-error";

function makeJsonResponse(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("extractFunctionsErrorMessage", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns server error string from JSON body", async () => {
    const err = { message: "Edge Function returned a non-2xx status code", context: makeJsonResponse({ error: "All batches must be passed or skipped before the A-Z audit" }) };
    expect(await extractFunctionsErrorMessage(err)).toBe(
      "All batches must be passed or skipped before the A-Z audit",
    );
  });

  it("returns a stable HTTP-status message for non-JSON 5xx bodies (never raw HTML)", async () => {
    const sentinel = "SENTINEL_LEAK_TOKEN_9f3c1";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = {
      message: "Edge Function returned a non-2xx status code",
      context: new Response(`<html><body>gateway boom ${sentinel}</body></html>`, {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html", "x-request-id": "req_abc123" },
      }),
    };
    const out = await extractFunctionsErrorMessage(err);
    expect(out).toBe("Server error (HTTP 502)");
    expect(out).not.toContain("<html");
    expect(out).not.toContain(sentinel);
    // Every console.error call must be free of the raw body sentinel and of
    // any HTML fragment. Metadata (status, requestId) is allowed.
    for (const call of errSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain("<html");
      expect(serialized).not.toContain("gateway boom");
    }
    // Should have logged the upstream request id, not a generated token.
    const meta = errSpy.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(meta?.requestId).toBe("req_abc123");
    expect(meta?.status).toBe(502);
    expect(meta?.correlationToken).toBeUndefined();
  });

  it("logs a generated correlation token when no upstream request ID header exists", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = {
      message: "boom",
      context: new Response("not json", { status: 500, headers: { "Content-Type": "text/plain" } }),
    };
    await extractFunctionsErrorMessage(err);
    const meta = errSpy.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(typeof meta?.correlationToken).toBe("string");
    expect((meta?.correlationToken as string).length).toBeGreaterThan(4);
    expect(meta?.requestId).toBeUndefined();
    // Body ("not json") must not appear anywhere in the log.
    const serialized = JSON.stringify(errSpy.mock.calls);
    expect(serialized).not.toContain("not json");
  });

  it("returns a stable 500 message when body is empty non-JSON", async () => {
    const err = {
      message: "boom",
      context: new Response("", { status: 500, headers: { "Content-Type": "text/plain" } }),
    };
    expect(await extractFunctionsErrorMessage(err)).toBe("Server error (HTTP 500)");
  });

  it("falls back to err.message when there is no response context at all", async () => {
    expect(await extractFunctionsErrorMessage({ message: "nope" })).toBe("nope");
  });

  it("handles null", async () => {
    expect(await extractFunctionsErrorMessage(null)).toBe("Request failed");
  });

  it("stableStatusMessage classifies by band", () => {
    expect(stableStatusMessage(500)).toBe("Server error (HTTP 500)");
    expect(stableStatusMessage(401)).toBe("Not authorized (HTTP 401)");
    expect(stableStatusMessage(404)).toBe("Not found (HTTP 404)");
    expect(stableStatusMessage(422)).toBe("Request rejected (HTTP 422)");
    expect(stableStatusMessage(undefined)).toBe("Request failed");
    expect(stableStatusMessage(Number.NaN)).toBe("Request failed");
  });
});
