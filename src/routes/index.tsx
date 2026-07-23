import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, KeyRound, Gauge } from "lucide-react";

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
      { property: "og:title", content: "App Blueprint — evidence-backed Blueprints for Lovable builds" },
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

const CHAIN: { step: string; label: string; note: string }[] = [
  { step: "01", label: "Import", note: "Bring the real repo or start a new idea." },
  { step: "02", label: "Audit", note: "The board reads the code, not the pitch." },
  { step: "03", label: "Boardroom", note: "Specialist models disagree on record." },
  { step: "04", label: "Design", note: "One distinctive move, then locked tokens." },
  { step: "05", label: "JIT prompts", note: "Compiled against current HEAD, per batch." },
  { step: "06", label: "Verify", note: "A separate verification prompt after each ship." },
];

function Landing() {
  return (
    <main className="relative min-h-dvh bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 20%, hsl(var(--primary)) 0, transparent 40%), radial-gradient(circle at 80% 70%, hsl(var(--primary)) 0, transparent 45%)",
        }}
      />
      <header className="relative z-10 flex items-center justify-between px-6 py-6 md:px-8">
        <span className="font-display text-base tracking-[0.28em] text-foreground md:text-lg">
          APP BLUEPRINT
        </span>
        <Link
          to="/auth"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <section className="relative z-10 mx-auto flex max-w-3xl flex-col items-start px-6 pb-16 pt-24 md:px-8 md:pt-32">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface-1 px-3 py-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Private beta
        </span>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl md:text-6xl">
          The quality layer between your idea and Lovable.
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          App Blueprint runs a council of specialist models — the Boardroom.
          They disagree, challenge assumptions against your real code, and
          hand back an evidence-backed Blueprint plus safer step-by-step
          prompts you paste into Lovable.
        </p>
        <div className="mt-10">
          <Link
            to="/auth"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-black/30 transition-all hover:brightness-110"
          >
            Start with an idea or import your app
            <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Private beta · create an account or sign in
          </p>
        </div>
      </section>

      {/* Evidence chain — the six-step proof spine visible on the marketing page. */}
      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-16 md:px-8 md:pb-24">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          The evidence chain
        </p>
        <h2 className="mt-3 font-display text-2xl text-foreground md:text-3xl">
          Six steps from idea to a verified Lovable build sequence.
        </h2>
        <ol className="mt-8 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          {CHAIN.map((c) => (
            <li
              key={c.step}
              className="rounded-xl border border-border bg-surface-1 p-4"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary/80">
                  {c.step}
                </span>
                <span className="font-display text-base text-foreground">{c.label}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{c.note}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* BYOK + spend-cap control */}
      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-24 md:px-8">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="mb-2 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <span className="font-display text-base text-foreground">BYOK</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Bring your own OpenRouter key. Stored encrypted server-side.
              We never route board calls without it, and never return it to
              the browser.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="mb-2 flex items-center gap-2">
              <Gauge className="h-4 w-4 text-primary" />
              <span className="font-display text-base text-foreground">Spend caps</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Per-run and per-day caps enforced server-side. Every board
              call is logged; a run that would breach the cap pauses
              before it spends.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
