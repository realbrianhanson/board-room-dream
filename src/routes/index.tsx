import { createFileRoute, Link } from "@tanstack/react-router";

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
          Private beta
        </span>
        <h1 className="font-display text-5xl leading-[1.05] text-foreground md:text-6xl">
          The quality layer between your idea and Lovable.
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          App Blueprint runs a council of specialist models — the Boardroom.
          They disagree, challenge assumptions against your real code, and
          hand back an evidence-backed Blueprint plus safer step-by-step
          prompts you paste into Lovable.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            to="/auth"
            className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-black/30 transition-all hover:brightness-110"
          >
            Get started or sign in
          </Link>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Private beta · create an account or sign in
          </span>
        </div>
      </section>
    </main>
  );
}
