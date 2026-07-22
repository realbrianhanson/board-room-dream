import { describe, it, expect } from "vitest";
import { extractFunctionsErrorMessage } from "./functions-error";

function makeJsonResponse(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("extractFunctionsErrorMessage", () => {
  it("returns server error string from JSON body", async () => {
    const err = { message: "Edge Function returned a non-2xx status code", context: makeJsonResponse({ error: "All batches must be passed or skipped before the A-Z audit" }) };
    expect(await extractFunctionsErrorMessage(err)).toBe(
      "All batches must be passed or skipped before the A-Z audit",
    );
  });

  it("falls back to err.message when body is not JSON", async () => {
    const err = {
      message: "Boom",
      context: new Response("<html>bad</html>", { status: 500, headers: { "Content-Type": "text/html" } }),
    };
    expect(await extractFunctionsErrorMessage(err)).toBe("Boom");
  });

  it("handles missing context", async () => {
    expect(await extractFunctionsErrorMessage({ message: "nope" })).toBe("nope");
  });

  it("handles null", async () => {
    expect(await extractFunctionsErrorMessage(null)).toBe("Request failed");
  });
});
