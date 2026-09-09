// `KeyUsage` is a lib.dom alias that @cloudflare/workers-types does not
// declare; the shared executor-auth.ts (also compiled by Deno, where the
// alias exists) uses it for crypto.subtle.importKey / deriveKey usages.
// Same union as lib.dom.d.ts.
type KeyUsage = "decrypt" | "deriveBits" | "deriveKey" | "encrypt" | "sign" | "unwrapKey" | "verify" | "wrapKey";
