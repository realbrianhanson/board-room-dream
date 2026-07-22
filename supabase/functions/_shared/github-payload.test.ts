// Byte-correct base64 decode for GitHub Contents API payloads.
// Regression cover for the "false mojibake findings" incident where atob() +
// binary-string handoff corrupted every multi-byte UTF-8 codepoint.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decodeGithubBase64 } from "./github-payload.ts";

function encodeUtf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

Deno.test("decodeGithubBase64 round-trips ASCII exactly", () => {
  const src = "export const x = 1;\nconsole.log('hi');\n";
  assertEquals(decodeGithubBase64(encodeUtf8Base64(src)), src);
});

Deno.test("decodeGithubBase64 round-trips non-ASCII punctuation exactly (mojibake regression)", () => {
  const src = "Legacy session — Reconvening… Paused · →";
  assertEquals(decodeGithubBase64(encodeUtf8Base64(src)), src);
});

Deno.test("decodeGithubBase64 tolerates the newlines GitHub embeds in its base64", () => {
  const src = "Fraunces · JetBrains Mono → Inter";
  const b64 = encodeUtf8Base64(src);
  // GitHub inserts \n every ~60 chars; also handle whitespace defensively.
  const chunked = b64.match(/.{1,10}/g)!.join("\n");
  assertEquals(decodeGithubBase64(chunked), src);
});

Deno.test("decodeGithubBase64 returns empty string for empty/blank input", () => {
  assertEquals(decodeGithubBase64(""), "");
  assertEquals(decodeGithubBase64("\n  \n"), "");
});
