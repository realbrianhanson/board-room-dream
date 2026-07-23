import * as React from "react";

export type TranscriptLine = {
  seat: "Chair" | "Strategist" | "Contrarian" | "Inspector";
  line: string;
};

export type TranscriptRun = {
  id: string;
  header: string;
  lines: TranscriptLine[];
  footerLeft: string;
  footerRight: string;
};

export function TranscriptRotator({ runs }: { runs: TranscriptRun[] }) {
  const [active, setActive] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const [reduce, setReduce] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReduce(!!mq?.matches);
    const onChange = () => setReduce(!!mq?.matches);
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  React.useEffect(() => {
    if (reduce || paused) return;
    const t = window.setInterval(() => {
      setActive((i) => (i + 1) % runs.length);
    }, 6000);
    return () => window.clearInterval(t);
  }, [reduce, paused, runs.length]);

  const run = runs[active];

  return (
    <div className="relative">
      {/* soft brass glow behind card */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 -z-10 opacity-60"
        style={{
          background:
            "radial-gradient(ellipse at 60% 40%, hsl(var(--primary) / 0.18) 0%, transparent 60%)",
          filter: "blur(20px)",
        }}
      />
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="relative overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl shadow-black/50"
      >
        {/* top edge highlight */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent, hsl(var(--primary) / 0.55), transparent)",
          }}
        />
        <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-2.5">
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            {run.header}
            {!reduce && (
              <span
                aria-hidden
                className="inline-block h-3 w-[2px] bg-primary/80 animate-pulse"
              />
            )}
          </span>
          <span className="flex items-center gap-1.5" aria-hidden>
            {runs.map((_, i) => (
              <span
                key={i}
                className={
                  "h-1.5 w-1.5 rounded-full transition-colors " +
                  (i === active ? "bg-primary" : "bg-border")
                }
              />
            ))}
          </span>
        </div>
        <ol key={run.id} className="divide-y divide-border">
          {run.lines.map((t, i) => (
            <li
              key={i}
              className="flex gap-4 px-4 py-4 opacity-0 translate-y-1 animate-[transcript-in_500ms_ease-out_forwards] motion-reduce:opacity-100 motion-reduce:translate-y-0 motion-reduce:animate-none"
              style={{ animationDelay: reduce ? "0ms" : `${i * 150}ms` }}
            >
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-primary/80">
                {t.seat}
              </span>
              <p className="text-sm leading-relaxed text-foreground/90">
                {t.line}
              </p>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-between border-t border-border bg-surface-2 px-4 py-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary">
            {run.footerLeft}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {run.footerRight}
          </span>
        </div>
      </div>
      <style>{`
        @keyframes transcript-in {
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
