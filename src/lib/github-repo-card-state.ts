// Pure display-state helper for GitHubRepoCard.
//
// The card renders based on two independent inputs:
//   1. The persisted `projects.github_repo` (present => the project is linked).
//   2. The GitHub connector status from the `github-oauth` `status` action.
//
// Historically the card required BOTH to say "linked", so a live smoke test
// where the project HAD a repo persisted but the connector status was
// transiently loading/errored rendered the misleading "Connect & link repo"
// empty state — even though a 200-file audit had already read the repo
// successfully. This helper separates those signals so a persisted repo is
// ALWAYS shown as linked, and OAuth uncertainty surfaces as a distinct
// "connection needs attention" warning.

export type GhOauthStatus = {
  configured: boolean;
  connected: boolean;
  status: "valid" | "invalid" | null;
};

export type GitHubCardInputs = {
  /** Persisted project.github_repo. null when not linked, undefined while loading. */
  repo: string | null | undefined;
  /** Error loading the repo field itself. */
  repoError: string | null;
  /** GitHub connector status. null while loading. */
  gh: GhOauthStatus | null;
  /** Error loading connector status. */
  ghError: string | null;
};

export type GitHubCardState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "linked"; repo: string; connectionHealthy: true }
  | {
      kind: "linked_needs_reconnect";
      repo: string;
      reason: "invalid" | "disconnected" | "unknown" | "not_configured";
    }
  | { kind: "unlinked_not_configured" }
  | { kind: "unlinked_disconnected" }
  | { kind: "unlinked_needs_reconnect" }
  | { kind: "unlinked_ready" };

/**
 * Pure classifier. Order:
 * 1. Repo query error is fatal for this card — surface Retry, never fall
 *    back to the empty state (that misled users into thinking the audit
 *    was reading nothing).
 * 2. Repo still loading (undefined) is loading.
 * 3. Any persisted repo => linked. OAuth signal only chooses between
 *    "healthy" and "needs reconnect".
 * 4. No repo => unlinked variants driven by connector state.
 */
export function classifyGitHubCard(input: GitHubCardInputs): GitHubCardState {
  const { repo, repoError, gh, ghError } = input;

  if (repoError) return { kind: "error", message: repoError };
  if (repo === undefined) return { kind: "loading" };

  if (repo) {
    if (gh && gh.configured && gh.connected && gh.status === "valid") {
      return { kind: "linked", repo, connectionHealthy: true };
    }
    if (ghError) return { kind: "linked_needs_reconnect", repo, reason: "unknown" };
    if (!gh) return { kind: "linked_needs_reconnect", repo, reason: "unknown" };
    if (!gh.configured) return { kind: "linked_needs_reconnect", repo, reason: "not_configured" };
    if (!gh.connected) return { kind: "linked_needs_reconnect", repo, reason: "disconnected" };
    return { kind: "linked_needs_reconnect", repo, reason: "invalid" };
  }

  // No repo persisted. Connector state chooses the unlinked variant.
  if (!gh) return { kind: "loading" };
  if (!gh.configured) return { kind: "unlinked_not_configured" };
  if (!gh.connected) return { kind: "unlinked_disconnected" };
  if (gh.status === "invalid") return { kind: "unlinked_needs_reconnect" };
  return { kind: "unlinked_ready" };
}
