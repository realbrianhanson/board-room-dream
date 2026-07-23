import * as React from "react";

export type ChainStep = { step: string; label: string; note: string };

export function EvidenceTimeline({ steps }: { steps: ChainStep[] }) {
  const containerRef = React.useRef<HTMLOListElement | null>(null);
  const [activeCount, setActiveCount] = React.useState(0);
  const [reduce, setReduce] = React.useState(false);
  const itemRefs = React.useRef<(HTMLLIElement | null)[]>([]);

  React.useEffect(() => {
    setReduce(!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }, []);

  React.useEffect(() => {
    const els = itemRefs.current.filter(Boolean) as HTMLLIElement[];
    if (els.length === 0) return;
    const activated = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = els.indexOf(e.target as HTMLLIElement);
            if (idx >= 0) activated.add(idx);
          }
        }
        const highest = Math.max(-1, ...Array.from(activated));
        setActiveCount(highest + 1);
      },
      { rootMargin: "0px 0px -30% 0px", threshold: 0.1 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [steps.length]);

  const progress = reduce ? 1 : steps.length === 0 ? 0 : activeCount / steps.length;

  return (
    <ol
      ref={containerRef}
      className="relative mt-14 space-y-10 pl-8 md:pl-12"
    >
      {/* spine base */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-px bg-border"
      />
      {/* spine draw */}
      <span
        aria-hidden
        className="absolute left-0 top-0 w-px origin-top bg-primary/70 transition-transform duration-700 ease-out"
        style={{ height: "100%", transform: `scaleY(${progress})` }}
      />
      {steps.map((c, i) => {
        const active = reduce || i < activeCount;
        return (
          <li
            key={c.step}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="relative"
          >
            <span
              aria-hidden
              className={
                "absolute -left-[41px] top-1 flex h-8 w-8 items-center justify-center rounded-full font-mono text-[10px] tracking-widest transition-all duration-500 md:-left-[49px] " +
                (active
                  ? "border border-primary bg-primary/10 text-primary shadow-[0_0_20px_hsl(var(--primary)/0.35)]"
                  : "border border-border bg-background text-muted-foreground")
              }
            >
              {c.step}
            </span>
            <h3 className="font-display text-xl text-foreground md:text-2xl">
              {c.label}
            </h3>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
              {c.note}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
