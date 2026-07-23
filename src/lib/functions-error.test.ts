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
    const err = {
      message: "Edge Function returned a non-2xx status code",
      context: new Response("<html><body>gateway boom</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    };
    const out = await extractFunctionsErrorMessage(err);
    expect(out).toBe("Server error (HTTP 502)");
    expect(out).not.toContain("<html");
    expect(out).not.toContain("gateway boom");
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
