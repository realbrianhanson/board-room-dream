import * as React from "react";

export type Stat = { value: number; suffix?: string; label: string };

export function StatsBand({ stats }: { stats: Stat[] }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [start, setStart] = React.useState(false);
  const [reduce, setReduce] = React.useState(false);

  React.useEffect(() => {
    setReduce(!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setStart(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section
      aria-label="At a glance"
      className="relative border-t border-border/60 px-6 py-14 md:px-8 md:py-16"
    >
      <div
        ref={ref}
        className="mx-auto grid max-w-6xl grid-cols-2 gap-y-8 md:grid-cols-4 md:gap-y-0"
      >
        {stats.map((s, i) => (
          <div
            key={s.label}
            className={
              "flex flex-col items-start px-6 md:px-8 " +
              (i > 0 ? "md:border-l md:border-border/60 " : "") +
              (i === 2 ? "border-t border-border/60 pt-8 md:border-t-0 md:pt-0 " : "") +
              (i === 3 ? "border-t border-border/60 pt-8 md:border-t-0 md:pt-0 " : "")
            }
          >
            <CountUp
              target={s.value}
              suffix={s.suffix}
              start={start}
              reduce={reduce}
              delay={i * 120}
            />
            <span className="mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CountUp({
  target,
  suffix,
  start,
  reduce,
  delay,
}: {
  target: number;
  suffix?: string;
  start: boolean;
  reduce: boolean;
  delay: number;
}) {
  const [n, setN] = React.useState(reduce ? target : 0);

  React.useEffect(() => {
    if (!start) return;
    if (reduce) {
      setN(target);
      return;
    }
    const duration = 1200;
    let raf = 0;
    let t0 = 0;
    const startTimer = window.setTimeout(() => {
      const tick = (t: number) => {
        if (!t0) t0 = t;
        const p = Math.min(1, (t - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        setN(Math.round(target * eased));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      window.clearTimeout(startTimer);
      cancelAnimationFrame(raf);
    };
  }, [start, reduce, target, delay]);

  return (
    <span className="font-display text-4xl leading-none text-foreground md:text-5xl">
      {n}
      {suffix ? (
        <span className="text-primary">{suffix}</span>
      ) : null}
    </span>
  );
}
