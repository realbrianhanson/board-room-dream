/**
 * Dashboard "new project" chooser can be pre-opened via a validated
 * search param (`?new=idea|import`) from Onboarding. Kept pure so we can
 * assert both valid destinations and invalid-value fallback without
 * mounting the route.
 */
export type DashboardNewMode = "idea" | "import" | null;

export function initialModeFromSearch(newParam: unknown): DashboardNewMode {
  if (newParam === "idea") return "idea";
  if (newParam === "import") return "import";
  return null;
}
