import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_authenticated/boardroom")({
  component: BoardroomPage,
});

function BoardroomPage() {
  return (
    <PlaceholderPage
      eyebrow="Boardroom"
      title="Bring your idea to the table."
      description="Four frontier models will read it, question it, and return with a locked plan."
      actionLabel="Start a session"
    />
  );
}
