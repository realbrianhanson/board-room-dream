import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { startGithubConnect } from "@/lib/github-connect";
import { classifyGitHubCard, type GhOauthStatus } from "@/lib/github-repo-card-state";

type Repo = { full_name: string; private: boolean; updated_at: string };
type Head = { sha: string; message: string; committed_at: string | null; branch: string };

async function ghInvoke(action: string, payload: Record<string, unknown> = {}, fn: "github-oauth" | "github-sync" = "github-sync") {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const { data, error } = await supabase.functions.invoke(fn, {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) throw error;
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data;
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function GitHubRepoCard({
  projectId,
  isOwner,
  onLinked,
}: {
  projectId: string;
  isOwner: boolean;
  onLinked?: (fullName: string) => void;
}) {
  const [gh, setGh] = useState<GhOauthStatus | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  // undefined = loading; null = loaded with no repo; string = linked.
  const [repo, setRepo] = useState<string | null | undefined>(undefined);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [head, setHead] = useState<Head | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [statusTick, setStatusTick] = useState(0);
  // Pending flags stop a double-click from launching two connect / reconnect
  // / picker flows in parallel — the previous smoke run showed users
  // click-spamming when the OAuth popup was slow to open.
  const [connecting, setConnecting] = useState(false);
  const [pickerOpening, setPickerOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // OAuth status
      try {
        const s = (await ghInvoke("status", {}, "github-oauth")) as GhOauthStatus;
        if (cancelled) return;
        setGh(s);
        setGhError(null);
      } catch (e) {
        if (cancelled) return;
        setGh({ configured: false, connected: false, status: null });
        setGhError((e as Error).message ?? "Couldn't reach GitHub connector.");
      }
      // Persisted project.github_repo — MUST NOT fall back to "unlinked" on
      // error. A silent null here previously masked the true linked state.
      try {
        const { data, error } = await supabase
          .from("projects")
          .select("github_repo")
          .eq("id", projectId)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          setRepoError(error.message ?? "Couldn't load linked repo.");
          setRepo(undefined);
        } else {
          setRepoError(null);
          setRepo((data as { github_repo: string | null } | null)?.github_repo ?? null);
        }
      } catch (e) {
        if (cancelled) return;
        setRepoError((e as Error).message ?? "Couldn't load linked repo.");
        setRepo(undefined);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, statusTick]);

  async function loadHead() {
    if (!repo) return;
    setRefreshing(true);
    try {
      const h = (await ghInvoke("head", { project_id: projectId })) as Head;
      setHead(h);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { if (repo && gh?.connected && gh.status === "valid") loadHead(); /* eslint-disable-next-line */ }, [repo, gh?.connected, gh?.status]);

  async function loadRepos() {
    setPickerError(null);
    setRepos(null);
    try {
      const d = (await ghInvoke("list_repos")) as { repos: Repo[] };
      setRepos(d.repos);
    } catch (e) {
      setPickerError((e as Error).message ?? "Couldn't load repositories.");
      toast.error((e as Error).message);
    }
  }

  async function openPicker() {
    if (pickerOpening) return;
    setPickerOpening(true);
    try {
      setShowPicker(true);
      if (repos || pickerError) return;
      await loadRepos();
    } finally {
      setPickerOpening(false);
    }
  }

  async function pick(full_name: string) {
    try {
      await ghInvoke("link_repo", { project_id: projectId, full_name });
      setRepo(full_name);
      setShowPicker(false);
      toast.success(`Linked ${full_name}`);
      onLinked?.(full_name);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    try {
      const r = await startGithubConnect();
      if (r === "embedded") toast("Open the app in its own browser tab to connect GitHub.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  const filtered = (repos ?? []).filter((r) => !q || r.full_name.toLowerCase().includes(q.toLowerCase()));

  const state = classifyGitHubCard({ repo, repoError, gh, ghError });

  // Linked + healthy: slim status row.
  if (state.kind === "linked") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-1 px-5 py-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Repo</span>
        <span className="font-mono text-sm text-foreground">{state.repo}</span>
        {head && (
          <span className="font-mono text-[11px] text-muted-foreground">
            HEAD {head.sha.slice(0, 7)} · {relTime(head.committed_at)}
          </span>
        )}
        {isOwner && (
          <button
            onClick={loadHead}
            disabled={refreshing}
            className="rounded-md border border-border bg-surface-2 px-3 py-1 text-xs text-foreground transition-colors hover:border-primary/40 disabled:opacity-50"
          >
            {refreshing ? "…" : "Refresh"}
          </button>
        )}
        <a
          href={`https://github.com/${state.repo}`}
          target="_blank" rel="noreferrer noopener"
          className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          View on GitHub <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }

  // Linked but the OAuth connection needs attention. This MUST NOT read as
  // "repo unlinked" — the repo is still persisted and audits will keep using
  // it via the service-role token. Only the interactive OAuth session is off.
  if (state.kind === "linked_needs_reconnect") {
    return (
      <div className="rounded-xl border border-warning/40 bg-warning/10 p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-warning">Repo linked · GitHub connection needs attention</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Repo</span>
          <span className="font-mono text-sm text-foreground">{state.repo}</span>
          <a
            href={`https://github.com/${state.repo}`}
            target="_blank" rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            View on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {state.reason === "invalid" && "Your GitHub token expired. Reconnect to refresh HEAD and enable new audits."}
          {state.reason === "disconnected" && "GitHub is no longer connected on your account. Reconnect to keep pulling HEAD and new audits."}
          {state.reason === "not_configured" && "GitHub isn't configured on this deployment right now, but your repo link is preserved."}
          {state.reason === "unknown" && "Couldn't verify the GitHub connection just now. The repo link is preserved — retry when you can."}
          {ghError ? ` (${ghError})` : ""}
        </p>
        {isOwner && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={connect}
              disabled={connecting}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              {connecting ? "Opening…" : "Reconnect GitHub"}
            </button>
            <button
              type="button"
              onClick={() => setStatusTick((n) => n + 1)}
              className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              Retry check
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-surface-1 p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-primary">Real-code audits</p>
        <h3 className="mt-2 font-display text-xl text-foreground">Audits read your real code.</h3>
        {state.kind === "error" ? (
          <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <p>Couldn't load the linked repo — {state.message}.</p>
            <button
              type="button"
              onClick={() => setStatusTick((n) => n + 1)}
              className="mt-2 rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
            >
              Retry
            </button>
          </div>
        ) : state.kind === "loading" ? (
          <div className="mt-3 h-8 animate-pulse rounded-md bg-surface-2" aria-label="Loading GitHub status" />
        ) : state.kind === "unlinked_not_configured" ? (
          <p className="mt-2 text-sm text-muted-foreground">
            GitHub isn't configured yet — the program admin sets two backend secrets to enable it. Until then, audits will offer a paste-your-code mode (ships with the audit engine).
            {ghError ? ` (${ghError})` : ""}
          </p>
        ) : state.kind === "unlinked_disconnected" ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Connect GitHub in Settings, then pick the repo Lovable is syncing to.
            </p>
            {isOwner && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={connect}
                  disabled={connecting}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
                >
                  {connecting ? "Opening…" : "Connect GitHub"}
                </button>
                <button
                  onClick={() => setShowGuide(true)}
                  className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  How to sync Lovable → GitHub
                </button>
              </div>
            )}
          </>
        ) : state.kind === "unlinked_needs_reconnect" ? (
          <>
            <p className="mt-2 text-sm text-destructive">Your GitHub token expired. Reconnect to keep audits running.</p>
            <button
              onClick={connect}
              disabled={connecting}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              {connecting ? "Opening…" : "Reconnect GitHub"}
            </button>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">Pick the repo Lovable is syncing to. Audits will read it read-only.</p>
            {isOwner && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={openPicker}
                  disabled={pickerOpening}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
                >
                  {pickerOpening ? "Opening…" : "Connect & link repo"}
                </button>
                <button
                  onClick={() => setShowGuide(true)}
                  className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  How to sync Lovable → GitHub
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-6" onClick={() => setShowGuide(false)}>
          <div className="relative w-full max-w-lg rounded-xl border border-border bg-surface-1 p-6" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowGuide(false)} className="absolute right-3 top-3 text-muted-foreground hover:text-foreground" aria-label="Close"><X className="h-4 w-4" /></button>
            <h3 className="font-display text-2xl text-foreground">Sync Lovable → GitHub</h3>
            <ol className="mt-4 space-y-3 text-sm text-foreground/90">
              <li><span className="mr-2 font-mono text-primary">1.</span>In Lovable, open your project → GitHub → Connect and create the repo.</li>
              <li><span className="mr-2 font-mono text-primary">2.</span>Here in App Blueprint Settings, Connect GitHub.</li>
              <li><span className="mr-2 font-mono text-primary">3.</span>Back on this Runway, pick that repo.</li>
            </ol>
            <div className="mt-5 flex justify-end">
              <button onClick={() => setShowGuide(false)} className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground">Got it</button>
            </div>
          </div>
        </div>
      )}

      {showPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-6" onClick={() => setShowPicker(false)}>
          <div className="relative w-full max-w-lg rounded-xl border border-border bg-surface-1 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-display text-xl text-foreground">Pick a repo</h3>
              <button onClick={() => setShowPicker(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search repos…"
              className="mt-4 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
            <div className="mt-3 max-h-80 overflow-auto rounded-md border border-border bg-background">
              {pickerError ? (
                <div role="alert" className="p-4 text-sm text-destructive">
                  <p>Couldn't load repositories — {pickerError}</p>
                  <button
                    type="button"
                    onClick={() => { void loadRepos(); }}
                    className="mt-2 rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                  >
                    Retry
                  </button>
                </div>
              ) : !repos ? (
                <div className="p-4 text-sm text-muted-foreground">Loading…</div>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No repos.</div>
              ) : (
                filtered.map((r) => (
                  <button
                    key={r.full_name}
                    onClick={() => pick(r.full_name)}
                    className="flex w-full items-center justify-between border-b border-border/60 px-4 py-2.5 text-left text-sm text-foreground hover:bg-surface-2"
                  >
                    <span className="font-mono">{r.full_name}</span>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {r.private ? "private" : "public"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
