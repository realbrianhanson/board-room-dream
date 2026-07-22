// Fail-closed behaviour for KEY_ENCRYPTION_SECRET. The previous code hashed
// the literal string "undefined" whenever the env var was missing, which
// silently minted a stable, attacker-guessable AES key.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateEncryptionSecret } from "./crypto.ts";

Deno.test("validateEncryptionSecret throws when the env var is undefined/null/blank", () => {
  for (const v of [undefined, null, "", "   ", "\n"]) {
    assertThrows(
      () => validateEncryptionSecret(v as any),
      Error,
      "KEY_ENCRYPTION_SECRET is not configured",
    );
  }
});

Deno.test("validateEncryptionSecret throws for the literal strings 'undefined' and 'null'", () => {
  for (const v of ["undefined", "null", "  undefined  "]) {
    assertThrows(
      () => validateEncryptionSecret(v),
      Error,
      "KEY_ENCRYPTION_SECRET is not configured",
    );
  }
});

Deno.test("validateEncryptionSecret returns the trimmed secret when valid", () => {
  assertEquals(validateEncryptionSecret("  my-strong-secret  "), "my-strong-secret");
  assertEquals(validateEncryptionSecret("abcdef"), "abcdef");
});
