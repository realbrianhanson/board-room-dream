// Test-only fixture builders for the batches validator. Not imported by any
// deployed module.

// A code batch prompt padded to EXACTLY `len` characters (the validator's
// skeleton rules — acceptance checks, closing lines — all satisfied).
export function codePrompt(n: number, len: number): string {
  const head = `Batch ${n} — Slice ${n}. Numbered items only, no scope creep.\n\n`;
  const items = Array.from({ length: 3 }, (_, i) =>
    `${i + 1}. Implement item ${i + 1} of batch ${n}: add the route /slice-${n}-${i + 1} and the Slice${n}${i + 1} component under src/components.`
  ).join("\n");
  const tail = `\n\nAcceptance checks:\n1. Open the preview, navigate to the new route and confirm the screen renders.\n2. Submit the form on that screen and confirm the new row appears without a console error.\n\nKeep everything else identical.\nTypecheck when done.`;
  const base = head + items + tail;
  if (len < base.length) throw new Error(`codePrompt: ${len} is shorter than the ${base.length}-char skeleton`);
  const pad = "\n4. " + "x".repeat(len - base.length - 4);
  return head + items + pad + tail;
}

export function humanPrompt(n: number, len: number): string {
  const base = `Batch ${n} — human step.\n\n1. Step one is a plain-language action the student takes in an external console.`;
  if (len < base.length) throw new Error(`humanPrompt: ${len} is shorter than the ${base.length}-char skeleton`);
  return base + " " + "y".repeat(len - base.length - 1);
}
