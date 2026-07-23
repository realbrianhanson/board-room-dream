import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import {
  ArrowRight,
  KeyRound,
  Gauge,
  ShieldCheck,
  Gavel,
  Compass,
  Swords,
  Search,
} from "lucide-react";
import { Reveal } from "@/components/landing/reveal";
import {
  TranscriptRotator,
  type TranscriptRun,
} from "@/components/landing/transcript-rotator";
import { StatsBand } from "@/components/landing/stats-band";
import { EvidenceTimeline } from "@/components/landing/evidence-timeline";
import { PromptCard } from "@/components/landing/prompt-card";

export const Route = createFileRoute("/")({
  component: Landing,
  head: () => ({
    meta: [
      { title: "App Blueprint — the quality layer between your idea and Lovable" },
      {
        name: "description",
        content:
          "App Blueprint runs a council of specialist models — the Boardroom — that disagree and challenge assumptions against your real code, then produces an evidence-backed Blueprint and safer step-by-step Lovable prompts.",
      },
      {
        property: "og:title",
        content: "App Blueprint — evidence-backed Blueprints for Lovable builds",
      },
      {
        property: "og:description",
        content:
          "Specialist models disagree against your real code. Get an evidence-backed Blueprint and safer step-by-step Lovable prompts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

// ---------------------------------------------------------------------------
// Content constants — realistic product copy, no lorem.
// ---------------------------------------------------------------------------

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#boardroom", label: "The Boardroom" },
  { href: "#security", label: "Security" },
];

const SEATS = [
  {
    tag: "SEAT 01",
    name: "Chair",
    Icon: Gavel,
    role: "Arbitrates the debate and can rule with dissent recorded on the run.",
    chair: true,
  },
  {
    tag: "SEAT 02",
    name: "Strategist",
    Icon: Compass,
    role: "Proposes the plan and defends the sequence of batches to ship.",
  },
  {
    tag: "SEAT 03",
    name: "Contrarian",
    Icon: Swords,
    role: "Attacks assumptions against the real code and cites the evidence.",
  },
  {
    tag: "SEAT 04",
    name: "Inspector",
    Icon: Search,
    role: "Verifies evidence, audits the implemented result, downgrades unsupported claims.",
  },
];

const CHAIN = [
  {
    step: "01",
    label: "Import",
    note: "Bring the real repo or start from an idea. The board reads code, not the pitch.",
  },
  {
    step: "02",
    label: "Audit",
    note: "Deterministic first scan grounds every later claim in files that actually exist.",
  },
  {
    step: "03",
    label: "Boardroom",
    note: "Specialist models disagree on record. Consensus or a Chair ruling with dissent.",
  },
  {
    step: "04",
    label: "Design",
    note: "One distinctive move, then tokens lock. No slop, no drift, no rework.",
  },
  {
    step: "05",
    label: "JIT prompts",
    note: "Every batch compiles against current HEAD before Copy unlocks.",
  },
  {
    step: "06",
    label: "Verify",
    note: "A separate verification prompt runs after each ship. Findings feed the next batch.",
  },
];

const TRANSCRIPTS: TranscriptRun[] = [
  {
    id: "run-0042",
    header: "RUN 0042 · PLAN SESSION · DISSENT ON RECORD",
    lines: [
      {
        seat: "Strategist",
        line: "Proposing batch 3: extract cohort join into a security-definer RPC. Additive migration, no data move.",
      },
      {
        seat: "Contrarian",
        line: "Reject batch 3 as scoped — the migration drops profiles.role check. Evidence: supabase/migrations/20260714_join_cohort.sql:42.",
      },
      {
        seat: "Chair",
        line: "Contrarian sustained. Rewrite batch 3 to keep the role guard. Strategist to revise.",
      },
    ],
    footerLeft: "CONSENSUS 3–1 · dissent recorded",
    footerRight: "batch 3 · rewrite",
  },
  {
    id: "run-0057",
    header: "RUN 0057 · DESIGN SESSION · TOKENS LOCK",
    lines: [
      {
        seat: "Strategist",
        line: "Locking tokens: brass primary at 38 65% 55%, Fraunces display, Inter body. One accent, calm surfaces.",
      },
      {
        seat: "Contrarian",
        line: "Reject the second gradient token. It reads like generic SaaS. Evidence: src/styles.css:71 introduces --accent-2.",
      },
      {
        seat: "Chair",
        line: "Contrarian sustained. Drop --accent-2. Brass remains the only decorative accent. Tokens locked.",
      },
    ],
    footerLeft: "CONSENSUS 3–1 · dissent recorded",
    footerRight: "design · locked",
  },
  {
    id: "run-0063",
    header: "RUN 0063 · AUDIT SESSION · RLS REVIEW",
    lines: [
      {
        seat: "Inspector",
        line: "Finding P1: cohorts SELECT policy uses instructor_id = auth.uid() but the join_cohort RPC bypasses it. Evidence: supabase/migrations/20260721_cohorts.sql:31.",
      },
      {
        seat: "Contrarian",
        line: "Concur. Add negative RLS test: unauth caller must fail. Do not weaken the assertion to make suite green.",
      },
      {
        seat: "Chair",
        line: "Ruling: P1 stands. Next batch adds pgTAP positive and negative cases before any policy edit.",
      },
    ],
    footerLeft: "CONSENSUS 3–0 · P1 confirmed",
    footerRight: "audit · fix-batch queued",
  },
];

const STATS = [
  { value: 4, label: "Seats per run" },
  { value: 3, suffix: "–1", label: "Consensus rule" },
  { value: 100, suffix: "%", label: "Dissent on record" },
  { value: 0, label: "Prompts shipped uncompiled" },
];

const IMPL_PROMPT = [
  "# Batch 4 · Cohort join RPC",
  "touch: supabase/migrations/20260714_join_cohort.sql",
  "touch: supabase/functions/_shared/cohort-join.ts",
  "add:   security-definer join_cohort(code text)",
  "keep:  profiles.role guard, RLS additive",
  "Acceptance: pgTAP + negative RLS case pass.",
];

const VERIFY_PROMPT = [
  "# Verification · Batch 4",
  "invoke: rpc.join_cohort('PUSHTEN1') as authed user",
  "expect: 200, cohort_id set on profiles row",
  "invoke: same rpc unauthenticated",
  "expect: 401 / permission denied",
  "Acceptance: both cases logged and green.",
];

const CONTROLS = [
  {
    Icon: KeyRound,
    title: "BYOK",
    body: "Bring your own OpenRouter key. Stored encrypted server-side. We never route board calls without it, and never return it to the browser.",
  },
  {
    Icon: Gauge,
    title: "Spend caps",
    body: "Per-run and per-day caps enforced server-side. Every board call is logged; a run that would breach the cap pauses before it spends.",
  },
  {
    Icon: ShieldCheck,
    title: "Owner-scoped data",
    body: "Row-level security on every table. Instructors see only their cohort. Keys stay encrypted server-side and never reach the browser.",
  },
];

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function Landing() {
  const [scrolled, setScrolled] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 8);
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setProgress(max > 0 ? Math.min(1, y / max) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduce) return;
    const root = document.documentElement;
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";
    return () => {
      root.style.scrollBehavior = prev;
    };
  }, []);

  return (
    <div className="relative min-h-dvh bg-background text-foreground">
      {/* dot-grid texture — very subtle */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-[0.035]"
        style={{
          backgroundImage:
            "radial-gradient(hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />
      {/* edge vignette */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 55%, hsl(var(--background)) 100%)",
        }}
      />
      {/* corner brass wash */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-[0.05]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 15% 10%, hsl(var(--primary)) 0, transparent 40%), radial-gradient(circle at 85% 90%, hsl(var(--primary)) 0, transparent 45%)",
        }}
      />

      <SiteHeader scrolled={scrolled} progress={progress} />

      <main className="relative z-10">
        <Hero />
        <BoardroomSection />
        <StatsBand stats={STATS} />
        <EvidenceChain />
        <Deliverable />
        <ControlSecurity />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function SiteHeader({
  scrolled,
  progress,
}: {
  scrolled: boolean;
  progress: number;
}) {
  return (
    <header
      className={
        "sticky top-0 z-40 backdrop-blur-md transition-colors " +
        (scrolled
          ? "bg-background/85 border-b border-primary/20"
          : "bg-background/40 border-b border-transparent")
      }
    >
      {/* scroll progress */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px] origin-left bg-primary/80"
        style={{ transform: `scaleX(${progress})` }}
      />
      <nav
        aria-label="Primary"
        className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 md:px-8"
      >
        <a
          href="#top"
          className="font-display text-sm tracking-[0.28em] text-foreground md:text-base"
        >
          APP BLUEPRINT
        </a>
        <ul className="hidden items-center gap-8 md:flex">
          {NAV.map((n) => (
            <li key={n.href}>
              <a
                href={n.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
              >
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4">
          <Link
            to="/auth"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded"
          >
            Sign in
          </Link>
          <Link
            to="/auth"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Start
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Eyebrow — brass rule + mono label
// ---------------------------------------------------------------------------

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Reveal as="div" className="flex items-center gap-3">
      <span aria-hidden className="h-px w-8 bg-primary" />
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        {children}
      </span>
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section
      id="top"
      aria-labelledby="hero-title"
      className="relative mx-auto max-w-6xl scroll-mt-24 px-6 pb-20 pt-16 md:grid md:grid-cols-[1.1fr_1fr] md:gap-14 md:px-8 md:pb-28 md:pt-24"
    >
      <div className="max-w-2xl">
        <Reveal
          as="span"
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface-1 px-3 py-1 text-xs uppercase tracking-[0.2em] text-muted-foreground"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Private beta
        </Reveal>
        <Reveal
          as="h1"
          delay={80}
          id="hero-title"
          className="font-display text-foreground"
          style={{
            fontSize: "clamp(2.5rem, 5vw + 1rem, 5.5rem)",
            lineHeight: 1.04,
            letterSpacing: "-0.01em",
          }}
        >
          The{" "}
          <span
            className="italic"
            style={{
              backgroundImage:
                "linear-gradient(90deg, hsl(var(--primary)), hsl(38 78% 72%))",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            quality layer
          </span>{" "}
          between your idea and Lovable.
        </Reveal>
        <Reveal
          as="p"
          delay={160}
          className="mt-8 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg"
        >
          App Blueprint runs a council of specialist models — the Boardroom.
          They disagree, challenge assumptions against your real code, and
          hand back an evidence-backed Blueprint plus safer step-by-step
          prompts you paste into Lovable.
        </Reveal>
        <Reveal as="div" delay={240} className="mt-10 flex flex-wrap items-center gap-5">
          <Link
            to="/auth"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-black/30 transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Start with an idea or import your app
            <ArrowRight className="h-4 w-4" />
          </Link>
          <a
            href="#how-it-works"
            className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded"
          >
            See how it works
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </Reveal>
        <Reveal
          as="p"
          delay={320}
          className="mt-4 font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
        >
          Private beta · create an account or sign in
        </Reveal>
      </div>

      {/* Transcript artifact */}
      <Reveal
        as="aside"
        delay={200}
        aria-label="Sample Boardroom transcript"
        className="mt-14 md:mt-2"
      >
        <TranscriptRotator runs={TRANSCRIPTS} />
      </Reveal>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Boardroom seats
// ---------------------------------------------------------------------------

function BoardroomSection() {
  return (
    <section
      id="boardroom"
      aria-labelledby="boardroom-title"
      className="relative border-t border-border/60 bg-background/60 px-6 py-20 md:px-8 md:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <Eyebrow>The Boardroom</Eyebrow>
        <Reveal
          as="h2"
          delay={80}
          id="boardroom-title"
          className="mt-3 max-w-2xl font-display text-4xl text-foreground md:text-5xl"
        >
          Four seats. Configured to disagree.
        </Reveal>
        <Reveal
          as="p"
          delay={140}
          className="mt-4 max-w-2xl text-base text-muted-foreground"
        >
          Specialist models take independent seats. They challenge each other
          against the real code. Consensus or a Chair ruling — dissent is
          always kept on record.
        </Reveal>

        <div className="relative mt-14">
          {/* horizontal brass line — seats-at-one-table */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 top-1/2 hidden h-px -translate-y-1/2 bg-primary/25 lg:block"
          />
          <ul className="relative grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {SEATS.map((s, i) => (
              <Reveal
                as="li"
                key={s.tag}
                delay={i * 80}
                className="group relative flex flex-col rounded-xl border border-border bg-surface-1 p-5 transition-all duration-300 hover:-translate-y-1 hover:border-primary/60 hover:shadow-[0_10px_40px_-15px_hsl(var(--primary)/0.35)]"
              >
                {s.chair && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute right-0 top-0 h-6 w-6"
                    style={{
                      background:
                        "linear-gradient(225deg, hsl(var(--primary) / 0.55) 0%, transparent 60%)",
                    }}
                  />
                )}
                <div className="mb-6 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                    {s.tag}
                  </span>
                  <s.Icon
                    className="h-4 w-4 text-primary/80 transition-all duration-300 group-hover:text-primary group-hover:drop-shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
                    aria-hidden
                  />
                </div>
                <h3 className="font-display text-xl text-foreground">{s.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.role}
                </p>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Evidence chain — vertical timeline
// ---------------------------------------------------------------------------

function EvidenceChain() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="chain-title"
      className="relative border-t border-border/60 px-6 py-20 md:px-8 md:py-28"
    >
      <div className="mx-auto max-w-4xl">
        <Eyebrow>The evidence chain</Eyebrow>
        <Reveal
          as="h2"
          delay={80}
          id="chain-title"
          className="mt-3 font-display text-4xl text-foreground md:text-5xl"
        >
          Six steps from idea to a verified Lovable build sequence.
        </Reveal>

        <EvidenceTimeline steps={CHAIN} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The deliverable — two prompt cards
// ---------------------------------------------------------------------------

function Deliverable() {
  return (
    <section
      aria-labelledby="deliverable-title"
      className="relative border-t border-border/60 bg-background/60 px-6 py-20 md:px-8 md:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <Eyebrow>The deliverable</Eyebrow>
        <Reveal
          as="h2"
          delay={80}
          id="deliverable-title"
          className="mt-3 max-w-3xl font-display text-4xl text-foreground md:text-5xl"
        >
          Two prompts per batch. Compiled just-in-time against your current
          code before Copy unlocks.
        </Reveal>

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <PromptCard title="Implementation prompt" lines={IMPL_PROMPT} />
          <PromptCard title="Verification prompt" lines={VERIFY_PROMPT} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Control & security — compressed horizontal band
// ---------------------------------------------------------------------------

function ControlSecurity() {
  return (
    <section
      id="security"
      aria-labelledby="security-title"
      className="relative border-t border-border/60 px-6 py-20 md:px-8 md:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <Eyebrow>Control & security</Eyebrow>
        <Reveal
          as="h2"
          delay={80}
          id="security-title"
          className="mt-3 max-w-2xl font-display text-4xl text-foreground md:text-5xl"
        >
          Your keys. Your data. Your cap.
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-8 rounded-xl border border-border bg-surface-1/60 p-8 md:grid-cols-3 md:gap-0 md:p-10">
          {CONTROLS.map((c, i) => (
            <Reveal
              as="div"
              key={c.title}
              delay={i * 80}
              className={
                "flex flex-col " +
                (i > 0 ? "md:border-l md:border-border/60 md:pl-8 " : "") +
                (i < CONTROLS.length - 1 ? "md:pr-8 " : "")
              }
            >
              <div className="mb-3 flex items-center gap-2">
                <c.Icon className="h-4 w-4 text-primary" aria-hidden />
                <span className="font-display text-base text-foreground">
                  {c.title}
                </span>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {c.body}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Final CTA band
// ---------------------------------------------------------------------------

function FinalCta() {
  return (
    <section
      aria-labelledby="final-cta-title"
      className="relative overflow-hidden border-t border-border/60 bg-surface-1 px-6 py-24 md:px-8 md:py-32"
    >
      {/* dot-grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "radial-gradient(hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />
      {/* centered brass glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, hsl(var(--primary) / 0.16) 0%, transparent 55%)",
        }}
      />
      <div className="relative mx-auto flex max-w-4xl flex-col items-center text-center">
        <Reveal
          as="h2"
          id="final-cta-title"
          className="max-w-3xl font-display text-4xl leading-[1.05] text-foreground md:text-6xl"
        >
          Bring the board to your{" "}
          <span
            className="italic"
            style={{
              backgroundImage:
                "linear-gradient(90deg, hsl(var(--primary)), hsl(38 78% 72%))",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            next build.
          </span>
        </Reveal>
        <Reveal as="div" delay={120} className="mt-10">
          <Link
            to="/auth"
            className="group inline-flex items-center justify-center gap-2 rounded-md bg-primary px-8 py-4 text-base font-medium text-primary-foreground shadow-lg shadow-black/40 transition-all hover:brightness-110 hover:shadow-[0_0_40px_hsl(var(--primary)/0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Start with an idea or import your app
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Private beta · create an account or sign in
          </p>
        </Reveal>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function SiteFooter() {
  return (
    <footer className="relative border-t border-border/60 bg-background px-6 py-12 md:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="font-display text-sm tracking-[0.28em] text-foreground">
            APP BLUEPRINT
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The quality layer between your idea and Lovable. A council of
            specialist models, evidence-backed Blueprints, safer prompts.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-8 gap-y-3">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded"
            >
              {n.label}
            </a>
          ))}
          <Link
            to="/auth"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded"
          >
            Sign in
          </Link>
        </nav>
      </div>
      <div className="mx-auto mt-10 max-w-6xl border-t border-border/60 pt-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          © 2026 App Blueprint
        </p>
      </div>
    </footer>
  );
}
