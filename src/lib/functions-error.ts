// Extract a human-readable error string from a supabase.functions.invoke error.
// FunctionsHttpError attaches the raw Response on `context`; the edge functions
// in this project reply with { error: string } as JSON, so try to surface that
// before falling back to a stable, non-leaking message.
//
// Contract:
//   1. If the response body parses as JSON with { error: "..." }, return that.
//   2. If the body is non-JSON (HTML SSR error page, empty, garbage) we do
//      NOT return raw bytes — instead we return a stable message that
//      includes the HTTP status when we know it, and log the raw body to
//      the console for debugging (so a correlation path exists without
//      leaking HTML into the UI).
//   3. If we can't reach the Response at all, fall back to `err.message`.

const GENERIC = "Request failed";

export function stableStatusMessage(status: number | null | undefined): string {
  if (typeof status !== "number" || !Number.isFinite(status)) return GENERIC;
  if (status >= 500) return `Server error (HTTP ${status})`;
  if (status === 401 || status === 403) return `Not authorized (HTTP ${status})`;
  if (status === 404) return `Not found (HTTP ${status})`;
  if (status >= 400) return `Request rejected (HTTP ${status})`;
  return GENERIC;
}

export async function extractFunctionsErrorMessage(err: unknown): Promise<string> {
  if (!err || typeof err !== "object") return GENERIC;
  const anyErr = err as { message?: string; context?: unknown };
  const fallback = typeof anyErr.message === "string" && anyErr.message
    ? anyErr.message
    : GENERIC;

  const ctx = anyErr.context as
    | { json?: () => Promise<unknown>; clone?: () => Response; status?: number; text?: () => Promise<string> }
    | undefined;
  if (!ctx || typeof ctx !== "object") return fallback;

  const status: number | undefined = typeof ctx.status === "number" ? ctx.status : undefined;

  try {
    let parsed: unknown = null;
    if (typeof ctx.json === "function") {
      // Response.json() can only be read once; clone when possible.
      const source = typeof ctx.clone === "function" ? ctx.clone() : (ctx as unknown as Response);
      parsed = await (source as Response).json();
    }
    if (parsed && typeof parsed === "object") {
      const msg = (parsed as { error?: unknown }).error;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
  } catch {
    // Non-JSON body (HTML error page, empty, etc.).
    // Log for debugging so a correlation trail exists, then return a
    // stable, non-leaking message. Never surface raw HTML in the UI.
    try {
      if (typeof ctx.clone === "function" && typeof ctx.text === "function") {
        const body = await (ctx as unknown as Response).clone().text();
        // eslint-disable-next-line no-console
        console.error("[functions-error] non-JSON body", { status, body: body.slice(0, 500) });
      }
    } catch {
      /* swallow — logging is best-effort */
    }
    return stableStatusMessage(status);
  }
  return fallback;
}
