import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Landing readability regression: the Reveal component must never apply
 * a blur filter. A prior version applied blur-[4px] with a
 * data-[revealed=true]:blur-0 counterpart that failed to win in the built
 * app, leaving hero text visibly fogged. This test locks in the "no blur
 * anywhere" contract at the source level.
 */
describe("Reveal class contract", () => {
  const src = readFileSync(
    resolve(__dirname, "../components/landing/reveal.tsx"),
    "utf8",
  );

  it("contains no blur utility class", () => {
    expect(src).not.toMatch(/blur-\[4px\]/);
    expect(src).not.toMatch(/blur-0/);
  });

  it("still applies opacity + translate reveal", () => {
    expect(src).toMatch(/opacity-0/);
    expect(src).toMatch(/translate-y-5/);
    expect(src).toMatch(/data-\[revealed=true\]:opacity-100/);
    expect(src).toMatch(/data-\[revealed=true\]:translate-y-0/);
  });

  it("keeps reduced-motion fallback", () => {
    expect(src).toMatch(/motion-reduce:opacity-100/);
    expect(src).toMatch(/motion-reduce:translate-y-0/);
    expect(src).toMatch(/motion-reduce:transition-none/);
  });
});
