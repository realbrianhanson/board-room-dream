// Extract a human-readable error string from a supabase.functions.invoke error.
// FunctionsHttpError attaches the raw Response on `context`; the edge functions
// in this project reply with { error: string } as JSON, so try to surface that
// before falling back to a stable, non-leaking message.
//
// Contract:
//   1. If the response body parses as JSON with { error: "..." }, return that.
//   2. If the body is non-JSON (HTML SSR error page, empty, garbage) we do
//      NOT return raw bytes AND we do NOT log raw bytes. Non-JSON bodies can
//      contain sensitive upstream/debug content (stack traces, tokens echoed
//      by a reverse proxy, HTML fragments). Instead we log only safe metadata
//      from the Response — HTTP status/statusText, URL origin+path, content
//      type, and any upstream request-ID header (x-request-id, cf-ray, etc.).
//      If none of those exist, we mint a client-side correlation token so a
//      support user can still tie the console log to the returned UI message.
//   3. If we can't reach the Response at all, fall back to `err.message`.

const GENERIC = "Request failed";

// Header names commonly used by reverse proxies and edge platforms to expose a
// stable request identifier. Values are treated as opaque IDs and are safe to
// log — never bodies.
const REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-amzn-requestid",
  "x-amz-request-id",
  "cf-ray",
  "fly-request-id",
  "sb-request-id",
  "x-supabase-request-id",
];

function newCorrelationToken(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `cli-${Date.now().toString(36)}-${rand}`;
}

function safeUrlPath(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    // origin + pathname only — never search params or hash, which sometimes
    // carry tokens or IDs the browser console shouldn't retain.
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

export function stableStatusMessage(status: number | null | undefined): string {
  if (typeof status !== "number" || !Number.isFinite(status)) return GENERIC;
  if (status >= 500) return `Server error (HTTP ${status})`;
  if (status === 401 || status === 403) return `Not authorized (HTTP ${status})`;
  if (status === 404) return `Not found (HTTP ${status})`;
  if (status >= 400) return `Request rejected (HTTP ${status})`;
  return GENERIC;
}

// Exported for tests. Builds the metadata object we may hand to console.error;
// never reads or includes the body.
export function buildSafeErrorMeta(
  ctx: {
    status?: number;
    statusText?: string;
    url?: string;
    headers?: { get?: (name: string) => string | null };
  } | undefined,
): Record<string, string | number | undefined> {
  const meta: Record<string, string | number | undefined> = {};
  if (typeof ctx?.status === "number") meta.status = ctx.status;
  if (typeof ctx?.statusText === "string" && ctx.statusText) meta.statusText = ctx.statusText;
  const path = safeUrlPath(ctx?.url);
  if (path) meta.url = path;
  const getHeader = ctx?.headers?.get;
  if (typeof getHeader === "function") {
    const ct = getHeader.call(ctx?.headers, "content-type");
    if (ct) meta.contentType = ct;
    for (const name of REQUEST_ID_HEADERS) {
      const v = getHeader.call(ctx?.headers, name);
      if (v) {
        meta.requestId = v;
        meta.requestIdSource = name;
        break;
      }
    }
  }
  if (!meta.requestId) {
    meta.correlationToken = newCorrelationToken();
  }
  return meta;
}

export async function extractFunctionsErrorMessage(err: unknown): Promise<string> {
  if (!err || typeof err !== "object") return GENERIC;
  const anyErr = err as { message?: string; context?: unknown };
  const fallback = typeof anyErr.message === "string" && anyErr.message
    ? anyErr.message
    : GENERIC;

  const ctx = anyErr.context as
    | (Response & { json?: () => Promise<unknown>; clone?: () => Response; status?: number })
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
    // Non-JSON body — DO NOT read or log the body. Log only safe metadata so
    // support can still correlate a report with a server log entry.
    try {
      const meta = buildSafeErrorMeta({
        status: ctx.status,
        statusText: (ctx as Response).statusText,
        url: (ctx as Response).url,
        headers: (ctx as Response).headers,
      });
      // eslint-disable-next-line no-console
      console.error("[functions-error] non-JSON body", meta);
    } catch {
      /* swallow — logging is best-effort */
    }
    return stableStatusMessage(status);
  }
  return fallback;
}
