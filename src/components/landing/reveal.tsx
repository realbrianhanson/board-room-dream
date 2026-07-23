import * as React from "react";

/**
 * Landing-only scroll reveal. Adds `data-revealed="true"` when the element
 * enters the viewport so CSS can transition opacity/transform. Falls back
 * immediately for users with prefers-reduced-motion.
 */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className = "",
  children,
  ...rest
}: {
  as?: React.ElementType;
  delay?: number;
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [revealed, setRevealed] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setRevealed(true);
      return;
    }
    // If already in view or scrolled past on mount (fast-scroll / anchor jump),
    // reveal immediately so we don't get stuck at opacity 0.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      setRevealed(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting || e.boundingClientRect.top < 0) {
            setRevealed(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      data-revealed={revealed ? "true" : "false"}
      style={{ transitionDelay: `${delay}ms` }}
      className={
        "opacity-0 translate-y-3 transition-all duration-700 ease-out " +
        "data-[revealed=true]:opacity-100 data-[revealed=true]:translate-y-0 " +
        "motion-reduce:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none " +
        className
      }
      {...rest}
    >
      {children}
    </Tag>
  );
}
