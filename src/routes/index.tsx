import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <main className="relative min-h-screen bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 20%, hsl(var(--primary)) 0, transparent 40%), radial-gradient(circle at 80% 70%, hsl(var(--primary)) 0, transparent 45%)",
        }}
      />
      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <span className="font-display text-lg tracking-[0.28em] text-foreground">
          APP BLUEPRINT
        </span>
        <Link
          to="/auth"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <section className="relative z-10 mx-auto flex max-w-3xl flex-col items-start px-8 pb-24 pt-32">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface-1 px-3 py-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          In session
        </span>
        <h1 className="font-display text-6xl leading-[1.05] text-foreground md:text-7xl">
          The board is in session.
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          Four frontier models sit as your board of directors — taking a raw idea
          from concept to a locked plan, to a batch-by-batch build, to audited
          and polished code.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            to="/auth"
            className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-black/30 transition-all hover:brightness-110"
          >
            Enter the boardroom
          </Link>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Invite only · Cohort 1
          </span>
        </div>
      </section>
    </main>
  );
}
