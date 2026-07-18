import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_authenticated/design")({
  component: DesignPage,
});

function DesignPage() {
  return (
    <PlaceholderPage
      eyebrow="Design"
      title="The house style."
      description="Tokens, type, motion — the visual language the board will hold every build to."
      actionLabel="Open the system"
    />
  );
}
