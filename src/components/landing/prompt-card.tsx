import * as React from "react";
import { Reveal } from "@/components/landing/reveal";

const KEYWORD_RE = /^(touch|add|keep|invoke|expect|Acceptance):/;

function renderLine(line: string, i: number) {
  if (line.startsWith("#")) {
    return (
      <div key={i} className="text-muted-foreground">
        {line}
      </div>
    );
  }
  const m = line.match(KEYWORD_RE);
  if (m) {
    const kw = m[0];
    const rest = line.slice(kw.length);
    return (
      <div key={i}>
        <span className="text-primary">{kw}</span>
        <span className="text-foreground/90">{rest}</span>
      </div>
    );
  }
  return (
    <div key={i} className="text-foreground/90">
      {line}
    </div>
  );
}

export function PromptCard({
  title,
  lines,
}: {
  title: string;
  lines: string[];
}) {
  return (
    <Reveal
      as="article"
      className="group relative overflow-hidden rounded-xl border border-border bg-surface-1 shadow-xl shadow-black/30"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, hsl(var(--primary) / 0.4), transparent)",
        }}
      />
      <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-4 py-2.5">
        <span className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full border border-border bg-background" />
          <span className="h-2.5 w-2.5 rounded-full border border-border bg-background" />
          <span className="h-2.5 w-2.5 rounded-full border border-border bg-background" />
        </span>
        <span className="flex-1 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {title}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary/80">
          .md
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-relaxed">
        {lines.map(renderLine)}
      </pre>
      <div className="relative overflow-hidden border-t border-border bg-surface-2 px-4 py-2.5">
        <span className="relative inline-flex items-center gap-2 rounded-full border border-border bg-background px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Copy locked · compiles at HEAD
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 motion-reduce:hidden"
          style={{
            background:
              "linear-gradient(90deg, transparent, hsl(var(--primary) / 0.14), transparent)",
            animation: "prompt-shimmer 4.5s ease-in-out infinite",
          }}
        />
      </div>
      <style>{`
        @keyframes prompt-shimmer {
          0% { transform: translateX(0); }
          60% { transform: translateX(400%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </Reveal>
  );
}
