import { createFileRoute, redirect } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/cohort")({
  beforeLoad: async () => {
    const { data } = await supabase
      .from("profiles")
      .select("role")
      .maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    if (role !== "instructor" && role !== "admin") {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: CohortPage,
});

function CohortPage() {
  return (
    <PlaceholderPage
      eyebrow="Cohort"
      title="Your cohort at a glance."
      description="Members, progress, and the shared context you need to teach them well."
      actionLabel="View members"
    />
  );
}
