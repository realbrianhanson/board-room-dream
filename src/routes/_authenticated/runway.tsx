import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_authenticated/runway")({
  component: RunwayPage,
});

function RunwayPage() {
  return (
    <PlaceholderPage
      eyebrow="Runway"
      title="Batch by batch, take flight."
      description="Approved plans move here as sequenced build batches you can watch, pause, and ship."
      actionLabel="View batches"
    />
  );
}
