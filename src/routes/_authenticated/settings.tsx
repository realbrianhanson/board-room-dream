import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <PlaceholderPage
      eyebrow="Settings"
      title="Set the terms."
      description="Profile, cohort, notifications, and the small preferences that shape your seat."
      actionLabel="Edit profile"
    />
  );
}
