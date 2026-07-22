// Extract a human-readable error string from a supabase.functions.invoke error.
// FunctionsHttpError attaches the raw Response on `context`; the edge functions
// in this project reply with { error: string } as JSON, so try to surface that
// before falling back to the generic message.

export async function extractFunctionsErrorMessage(err: unknown): Promise<string> {
  if (!err || typeof err !== "object") return "Request failed";
  const anyErr = err as { message?: string; context?: unknown };
  const fallback = typeof anyErr.message === "string" && anyErr.message
    ? anyErr.message
    : "Request failed";

  const ctx = anyErr.context as { json?: () => Promise<unknown>; clone?: () => Response } | undefined;
  if (!ctx || typeof ctx !== "object") return fallback;

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
    // Non-JSON body (HTML error page, empty, etc.) — never expose raw HTML.
  }
  return fallback;
}
