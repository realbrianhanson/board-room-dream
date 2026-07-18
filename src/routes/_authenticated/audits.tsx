import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_authenticated/audits")({
  component: AuditsPage,
});

function AuditsPage() {
  return (
    <PlaceholderPage
      eyebrow="Audits"
      title="Every decision, on record."
      description="Independent review of the board's calls, the code that shipped, and the reasons behind both."
      actionLabel="Open the ledger"
    />
  );
}
