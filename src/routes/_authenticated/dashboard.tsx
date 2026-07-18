import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  return (
    <PlaceholderPage
      eyebrow="Dashboard"
      title="Your desk, quietly waiting."
      description="Once the board convenes on your first idea, everything you need to steer it will live here."
      actionLabel="Open the boardroom"
      onAction={() => navigate({ to: "/boardroom" })}
    />
  );
}
