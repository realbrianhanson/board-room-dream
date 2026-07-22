// TECH-HARDEN-R1: static-source guarantees for github-oauth.
// Verifies redirect_uri parity between start and callback, presence in the
// GitHub token-exchange body, and that origin is not accepted from body at
// callback time.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("start derives redirect_uri from verified origin", () => {
  assertStringIncludes(src, "const verifiedOrigin = isAllowedOrigin(body?.origin, allowed)");
  assertStringIncludes(src, "const redirect_uri = `${verifiedOrigin}/auth/github/callback`");
});

Deno.test("callback derives redirect_uri from state origin (same suffix as start)", () => {
  assertStringIncludes(src, "const redirect_uri = `${stateResult.origin}/auth/github/callback`");
});

Deno.test("callback passes redirect_uri to GitHub token exchange", () => {
  const idx = src.indexOf("login/oauth/access_token");
  assert(idx > 0, "token exchange call not found");
  const window = src.slice(idx, idx + 500);
  assertStringIncludes(window, "redirect_uri");
});

Deno.test("callback does NOT accept origin from request body", () => {
  const cbIdx = src.indexOf('action === "callback"');
  const disIdx = src.indexOf('action === "disconnect"');
  assert(cbIdx > 0 && disIdx > cbIdx);
  const cbBlock = src.slice(cbIdx, disIdx);
  // No body?.origin lookups inside the callback branch.
  assert(!/body\?\.origin/.test(cbBlock), "callback must not read body.origin");
});

Deno.test("origin allow-list is loaded from app_settings, not env or wildcard", () => {
  assertStringIncludes(src, `.eq("key", "allowed_oauth_origins")`);
  assert(!/\*\.\w/.test(src.split("\n").filter(l => l.includes("Origin")).join("\n")));
});
