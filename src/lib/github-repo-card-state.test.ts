import { describe, it, expect } from "vitest";
import { classifyGitHubCard } from "./github-repo-card-state";

const validGh = { configured: true, connected: true, status: "valid" as const };

describe("classifyGitHubCard", () => {
  it("returns loading while repo is undefined", () => {
    const s = classifyGitHubCard({ repo: undefined, repoError: null, gh: validGh, ghError: null });
    expect(s.kind).toBe("loading");
  });

  it("surfaces repo query error with a retry-eligible state (never the empty state)", () => {
    const s = classifyGitHubCard({ repo: undefined, repoError: "boom", gh: validGh, ghError: null });
    expect(s).toEqual({ kind: "error", message: "boom" });
  });

  it("shows LINKED when a repo is persisted and OAuth is fully healthy", () => {
    const s = classifyGitHubCard({ repo: "owner/repo", repoError: null, gh: validGh, ghError: null });
    expect(s).toEqual({ kind: "linked", repo: "owner/repo", connectionHealthy: true });
  });

  it("shows LINKED_NEEDS_RECONNECT (repo present, connector invalid)", () => {
    const s = classifyGitHubCard({
      repo: "owner/repo",
      repoError: null,
      gh: { configured: true, connected: true, status: "invalid" },
      ghError: null,
    });
    expect(s).toEqual({ kind: "linked_needs_reconnect", repo: "owner/repo", reason: "invalid" });
  });

  it("shows LINKED_NEEDS_RECONNECT (repo present, connector disconnected)", () => {
    const s = classifyGitHubCard({
      repo: "owner/repo",
      repoError: null,
      gh: { configured: true, connected: false, status: null },
      ghError: null,
    });
    expect(s).toEqual({
      kind: "linked_needs_reconnect",
      repo: "owner/repo",
      reason: "disconnected",
    });
  });

  it("shows LINKED_NEEDS_RECONNECT (repo present, gh status errored)", () => {
    // Regression: previously this rendered "Connect & link repo" — an outright
    // lie because the audit had just read the linked repo. Now it must say the
    // repo IS linked, and only the OAuth check is uncertain.
    const s = classifyGitHubCard({
      repo: "owner/repo",
      repoError: null,
      gh: null,
      ghError: "network",
    });
    expect(s.kind).toBe("linked_needs_reconnect");
    if (s.kind === "linked_needs_reconnect") expect(s.repo).toBe("owner/repo");
  });

  it("shows LINKED_NEEDS_RECONNECT (repo present, admin has not configured GitHub)", () => {
    const s = classifyGitHubCard({
      repo: "owner/repo",
      repoError: null,
      gh: { configured: false, connected: false, status: null },
      ghError: null,
    });
    expect(s).toEqual({
      kind: "linked_needs_reconnect",
      repo: "owner/repo",
      reason: "not_configured",
    });
  });

  it("shows UNLINKED_READY when no repo and OAuth healthy", () => {
    const s = classifyGitHubCard({ repo: null, repoError: null, gh: validGh, ghError: null });
    expect(s.kind).toBe("unlinked_ready");
  });

  it("shows UNLINKED_DISCONNECTED when no repo and connector disconnected", () => {
    const s = classifyGitHubCard({
      repo: null,
      repoError: null,
      gh: { configured: true, connected: false, status: null },
      ghError: null,
    });
    expect(s.kind).toBe("unlinked_disconnected");
  });

  it("shows UNLINKED_NOT_CONFIGURED when connector not configured", () => {
    const s = classifyGitHubCard({
      repo: null,
      repoError: null,
      gh: { configured: false, connected: false, status: null },
      ghError: null,
    });
    expect(s.kind).toBe("unlinked_not_configured");
  });

  it("shows UNLINKED_NEEDS_RECONNECT when no repo and status invalid", () => {
    const s = classifyGitHubCard({
      repo: null,
      repoError: null,
      gh: { configured: true, connected: true, status: "invalid" },
      ghError: null,
    });
    expect(s.kind).toBe("unlinked_needs_reconnect");
  });

  it("shows loading when neither repo nor gh has loaded (no error)", () => {
    const s = classifyGitHubCard({ repo: null, repoError: null, gh: null, ghError: null });
    expect(s.kind).toBe("loading");
  });
});
