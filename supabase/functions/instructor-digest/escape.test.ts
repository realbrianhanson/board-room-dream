import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { escapeHtml } from "./escape.ts";

Deno.test("escapeHtml: plain text passes through", () => {
  assertEquals(escapeHtml("Founders Cohort 1"), "Founders Cohort 1");
});

Deno.test("escapeHtml: script/img/event-handler payloads are neutralized", () => {
  const script = "<script>alert('xss')</script>";
  const out = escapeHtml(script);
  assertEquals(out.includes("<script"), false);
  assertEquals(out.includes("</script>"), false);
  assertStringIncludes(out, "&lt;script");

  const img = `<img src=x onerror="steal()">`;
  const outImg = escapeHtml(img);
  assertEquals(outImg.includes("<img"), false);
  assertEquals(outImg.includes("onerror=\""), false);
  assertStringIncludes(outImg, "&lt;img");
  assertStringIncludes(outImg, "&quot;");

  const handler = `\" onclick=alert(1) x=\"`;
  const outHandler = escapeHtml(handler);
  assertEquals(outHandler.includes('"'), false);
  assertStringIncludes(outHandler, "&quot;");
});

Deno.test("escapeHtml: ampersand escapes FIRST so entities don't double-escape", () => {
  assertEquals(escapeHtml("Tom & Jerry <b>"), "Tom &amp; Jerry &lt;b&gt;");
  assertEquals(escapeHtml("&lt;script&gt;"), "&amp;lt;script&amp;gt;");
});

Deno.test("escapeHtml: covers single quote", () => {
  assertEquals(escapeHtml("O'Brien"), "O&#39;Brien");
});

Deno.test("escapeHtml: nullish inputs become empty string", () => {
  assertEquals(escapeHtml(null), "");
  assertEquals(escapeHtml(undefined), "");
});
