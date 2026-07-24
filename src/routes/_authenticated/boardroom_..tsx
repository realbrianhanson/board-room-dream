
// -------- Needs-repo card --------
//
// Improvements IS in scope for this import, but the project has no
// GitHub repo linked yet. The board compiles against live code, so it
// cannot convene until the owner links a repo in Audit Center.
function BoardroomNeedsRepoCard({
  projectId,
  scopeLabel,
}: {
  projectId: string;
  scopeLabel: string;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface-1/60 px-8 py-10">
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Link your GitHub repo first · {scopeLabel}
      </p>
      <h2 className="mt-3 font-display text-2xl text-foreground">
        The board reads live code before it convenes.
      </h2>
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
        Improvement plans are compiled against your real repo at HEAD.
        Link your GitHub repository in the Audit Center, then return here
        to convene the improvement board.
      </p>
      <div className="mt-6">
        <Link
          to="/audits/$projectId"
          params={{ projectId }}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
        >
          Link the repo in Audit Center <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
