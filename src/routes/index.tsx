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

const TRANSCRIPT: {
  seat: "Chair" | "Strategist" | "Contrarian";
  line: string;
}[] = [
  {
    seat: "Strategist",
    line: "Proposing batch 3: extract cohort join into a security-definer RPC. Additive migration, no data move.",
  },
  {
    seat: "Contrarian",
    line: 'Reject batch 3 as scoped — the migration drops profiles.role check. Evidence: supabase/migrations/20260714_join_cohort.sql:42.',
  },
  {
    seat: "Chair",
    line: "Contrarian sustained. Rewrite batch 3 to keep the role guard. Strategist to revise.",
  },
];

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function Landing() {
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative min-h-dvh bg-background text-foreground">
      {/* soft brass corner wash — the only decorative flourish */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 15% 10%, hsl(var(--primary)) 0, transparent 40%), radial-gradient(circle at 85% 90%, hsl(var(--primary)) 0, transparent 45%)",
        }}
      />

      <SiteHeader scrolled={scrolled} />

      <main className="relative z-10">
        <Hero />
        <BoardroomSection />
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

function SiteHeader({ scrolled }: { scrolled: boolean }) {
  return (
    <header
      className={
        "sticky top-0 z-40 backdrop-blur-md transition-colors " +
        (scrolled
          ? "bg-background/85 border-b border-border"
          : "bg-background/40 border-b border-transparent")
      }
    >
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
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section
      id="top"
      aria-labelledby="hero-title"
      className="relative mx-auto max-w-6xl scroll-mt-24 px-6 pb-20 pt-16 md:grid md:grid-cols-[1.15fr_1fr] md:gap-14 md:px-8 md:pb-28 md:pt-24"
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
          className="font-display text-5xl leading-[1.02] text-foreground sm:text-6xl md:text-[5.25rem] lg:text-[6.25rem]"
        >
          The{" "}
          <span className="italic text-primary/95">quality layer</span>{" "}
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
        <div className="overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl shadow-black/40">
          <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              RUN 0042 · PLAN SESSION · DISSENT ON RECORD
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="h-1.5 w-1.5 rounded-full bg-border" />
              <span className="h-1.5 w-1.5 rounded-full bg-border" />
            </span>
          </div>
          <ol className="divide-y divide-border">
            {TRANSCRIPT.map((t, i) => (
              <li key={i} className="flex gap-4 px-4 py-4">
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
              CONSENSUS 3–1 · dissent recorded
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              batch 3 · rewrite
            </span>
          </div>
        </div>
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
        <Reveal
          as="p"
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground"
        >
          The Boardroom
        </Reveal>
        <Reveal
          as="h2"
          delay={80}
          id="boardroom-title"
          className="mt-3 max-w-2xl font-display text-3xl text-foreground md:text-4xl"
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

        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SEATS.map((s, i) => (
            <Reveal
              as="li"
              key={s.tag}
              delay={i * 80}
              className="group relative flex flex-col rounded-xl border border-border bg-surface-1 p-5 transition-colors hover:border-primary/40"
            >
              <div className="mb-6 flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  {s.tag}
                </span>
                <s.Icon
                  className="h-4 w-4 text-primary/80 transition-colors group-hover:text-primary"
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
        <Reveal
          as="p"
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground"
        >
          The evidence chain
        </Reveal>
        <Reveal
          as="h2"
          delay={80}
          id="chain-title"
          className="mt-3 font-display text-3xl text-foreground md:text-4xl"
        >
          Six steps from idea to a verified Lovable build sequence.
        </Reveal>

        <ol className="relative mt-14 space-y-10 border-l border-border pl-8 md:pl-12">
          {CHAIN.map((c, i) => (
            <Reveal as="li" key={c.step} delay={i * 60} className="relative">
              <span
                aria-hidden
                className="absolute -left-[41px] top-1 flex h-8 w-8 items-center justify-center rounded-full border border-primary/60 bg-background font-mono text-[10px] tracking-widest text-primary md:-left-[49px]"
              >
                {c.step}
              </span>
              <h3 className="font-display text-xl text-foreground md:text-2xl">
                {c.label}
              </h3>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
                {c.note}
              </p>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The deliverable — two prompt cards
// ---------------------------------------------------------------------------

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

function Deliverable() {
  return (
    <section
      aria-labelledby="deliverable-title"
      className="relative border-t border-border/60 bg-background/60 px-6 py-20 md:px-8 md:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal
          as="p"
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground"
        >
          The deliverable
        </Reveal>
        <Reveal
          as="h2"
          delay={80}
          id="deliverable-title"
          className="mt-3 max-w-3xl font-display text-3xl text-foreground md:text-4xl"
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

function PromptCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <Reveal
      as="article"
      className="overflow-hidden rounded-xl border border-border bg-surface-1"
    >
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {title}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary/80">
          .md
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-relaxed text-foreground/90">
        {lines.join("\n")}
      </pre>
      <div className="border-t border-border bg-surface-2 px-4 py-2.5">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Compiled against HEAD a1b2c3d
        </span>
      </div>
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// Control & security
// ---------------------------------------------------------------------------

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

function ControlSecurity() {
  return (
    <section
      id="security"
      aria-labelledby="security-title"
      className="relative border-t border-border/60 px-6 py-20 md:px-8 md:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal
          as="p"
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground"
        >
          Control & security
        </Reveal>
        <Reveal
          as="h2"
          delay={80}
          id="security-title"
          className="mt-3 max-w-2xl font-display text-3xl text-foreground md:text-4xl"
        >
          Your keys. Your data. Your cap.
        </Reveal>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {CONTROLS.map((c, i) => (
            <Reveal
              as="div"
              key={c.title}
              delay={i * 80}
              className="rounded-xl border border-border bg-surface-1 p-6"
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
      className="relative border-t border-border/60 bg-surface-1 px-6 py-24 md:px-8 md:py-32"
    >
      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        <Reveal
          as="h2"
          id="final-cta-title"
          className="max-w-3xl font-display text-4xl leading-[1.05] text-foreground md:text-6xl"
        >
          Bring the board to your{" "}
          <span className="italic text-primary/95">next build.</span>
        </Reveal>
        <Reveal as="div" delay={120} className="mt-10">
          <Link
            to="/auth"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-black/30 transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Start with an idea or import your app
            <ArrowRight className="h-4 w-4" />
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
