// Pure derivation for the dashboard project-load UI. An error must NEVER
// collapse into the empty-state ("No projects yet.") — that lies to the user
// and hides retryable failures. Empty is reserved for a successful query
// with zero rows.
export type DashboardLoadState = "loading" | "error" | "empty" | "ready";

export function deriveDashboardLoadState(input: {
  projects: unknown[] | null;
  loadError: string | null;
}): DashboardLoadState {
  if (input.loadError) return "error";
  if (input.projects === null) return "loading";
  if (input.projects.length === 0) return "empty";
  return "ready";
}
