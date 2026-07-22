import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decodeStateEnvelope,
  encodeStatePayload,
  isAllowedOrigin,
  normalizeOrigin,
} from "./origin.ts";

const ALLOWED = [
  "https://board-room-dream.lovable.app",
  "https://id-preview--887503f1-4c18-4b48-87f8-05674e6d8964.lovable.app",
  "https://appblueprint.com",
  "https://www.appblueprint.com",
];

Deno.test("normalizeOrigin accepts bare https origin", () => {
  assertEquals(normalizeOrigin("https://appblueprint.com"), "https://appblueprint.com");
  assertEquals(normalizeOrigin("https://appblueprint.com/"), "https://appblueprint.com");
});

Deno.test("normalizeOrigin rejects http, credentials, path, query, hash", () => {
  assertEquals(normalizeOrigin("http://appblueprint.com"), null);
  assertEquals(normalizeOrigin("https://user:pw@appblueprint.com"), null);
  assertEquals(normalizeOrigin("https://appblueprint.com/foo"), null);
  assertEquals(normalizeOrigin("https://appblueprint.com/?x=1"), null);
  assertEquals(normalizeOrigin("https://appblueprint.com/#h"), null);
  assertEquals(normalizeOrigin(""), null);
  assertEquals(normalizeOrigin(null), null);
  assertEquals(normalizeOrigin(123), null);
});

Deno.test("isAllowedOrigin exact-matches", () => {
  assertEquals(
    isAllowedOrigin("https://appblueprint.com", ALLOWED),
    "https://appblueprint.com",
  );
  assertEquals(
    isAllowedOrigin("https://www.appblueprint.com", ALLOWED),
    "https://www.appblueprint.com",
  );
});

Deno.test("isAllowedOrigin rejects attacker + deceptive suffix + http + path", () => {
  assertEquals(isAllowedOrigin("https://evil.com", ALLOWED), null);
  // suffix match trap
  assertEquals(isAllowedOrigin("https://appblueprint.com.evil.com", ALLOWED), null);
  assertEquals(isAllowedOrigin("https://xappblueprint.com", ALLOWED), null);
  // subdomain not on list
  assertEquals(isAllowedOrigin("https://foo.appblueprint.com", ALLOWED), null);
  assertEquals(isAllowedOrigin("http://appblueprint.com", ALLOWED), null);
  assertEquals(isAllowedOrigin("https://appblueprint.com/callback", ALLOWED), null);
  assertEquals(isAllowedOrigin("https://appblueprint.com?x", ALLOWED), null);
  assertEquals(isAllowedOrigin(undefined, ALLOWED), null);
  assertEquals(isAllowedOrigin("https://appblueprint.com", null), null);
});

Deno.test("encodeStatePayload + decodeStateEnvelope round-trip", () => {
  const p = encodeStatePayload("u1", "12345", "https://appblueprint.com");
  const envelope = `${p}|sig123`;
  const d = decodeStateEnvelope(envelope);
  assertEquals(d, {
    uid: "u1",
    ts: "12345",
    origin: "https://appblueprint.com",
    payload: "u1|12345|https://appblueprint.com",
    sig: "sig123",
  });
});

Deno.test("decodeStateEnvelope rejects wrong shape (legacy 3-part or tampered)", () => {
  assertEquals(decodeStateEnvelope("u1|12345|sig"), null);
  assertEquals(decodeStateEnvelope("u1|12345|https://a.com|sig|extra"), null);
  assertEquals(decodeStateEnvelope(""), null);
});
