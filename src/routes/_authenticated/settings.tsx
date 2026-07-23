import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useReducer, useState } from "react";
import {
  initialSettingsLoadState,
  isSaveEnabled,
  settingsLoadReducer,
} from "@/lib/settings-load";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { SpendPanel } from "@/components/spend-panel";
import { startGithubConnect } from "@/lib/github-connect";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

type KeyRow = { provider: string; last4: string | null; status: "unverified" | "valid" | "invalid" };
type Seat = {
  seat: string;
  model_id: string;
  display_name: string | null;
  role_prompt: string | null;
  enabled: boolean;
  max_cost_per_run: number;
  fallback_model_id: string | null;
};

async function callVault(action: string, payload: Record<string, unknown> = {}) {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const { data, error } = await supabase.functions.invoke("key-vault", {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) throw error;
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data;
}

function StatusChip({ status }: { status: KeyRow["status"] }) {
  const map = {
    valid: "border-success/40 bg-success/15 text-success",
    invalid: "border-destructive/40 bg-destructive/15 text-destructive",
    unverified: "border-border bg-surface-2 text-muted-foreground",
  } as const;
  return (
    <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${map[status]}`}>
      {status}
    </span>
  );
}

function OpenRouterCard() {
  const [row, setRow] = useState<KeyRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = (await callVault("list")) as { keys: KeyRow[] };
      const r = data.keys.find((k) => k.provider === "openrouter") ?? null;
      setRow(r);
      setShowForm(!r);
    } catch (e) {
      const msg = (e as Error).message ?? "Failed to load key status";
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function store() {
    if (!input.trim()) return;
    setBusy(true);
    try {
      const r = (await callVault("store", { provider: "openrouter", key: input.trim() })) as KeyRow;
      setRow(r);
      setInput("");
      setShowForm(false);
      toast.success(`Key stored — ${r.status}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!input.trim()) return;
    setBusy(true);
    try {
      const r = (await callVault("rotate", { provider: "openrouter", key: input.trim() })) as KeyRow;
      setRow(r);
      setInput("");
      setShowForm(false);
      toast.success("Key rotated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    try {
      const r = (await callVault("verify", { provider: "openrouter" })) as KeyRow;
      setRow(r);
      toast.success(`Verified — ${r.status}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm("Delete the stored OpenRouter key?")) return;
    setBusy(true);
    try {
      await callVault("delete", { provider: "openrouter" });
      setRow(null);
      setShowForm(true);
      toast.success("Key deleted");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface-1 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-xl text-foreground">OpenRouter</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Your key routes every board call. Stored encrypted; never returned to the browser.
          </p>
        </div>
        {row && <StatusChip status={row.status} />}
      </div>

      {loading ? (
        <div className="mt-6 h-16 animate-pulse rounded-md bg-surface-2" role="status" aria-label="Loading OpenRouter status" />
      ) : loadError ? (
        <div role="alert" className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Couldn't reach the key vault.</p>
          <p className="mt-1 break-words text-destructive/80">{loadError}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 inline-flex rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            Retry
          </button>
        </div>
      ) : row && !showForm ? (
        <div className="mt-6 space-y-4">
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-3">
            <span className="font-mono text-xs text-muted-foreground">sk-or-...</span>
            <span className="font-mono text-sm text-foreground">{row.last4}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={verify}
              disabled={busy}
              className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              Re-verify
            </button>
            <button
              onClick={() => setShowForm(true)}
              disabled={busy}
              className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              Rotate
            </button>
            <button
              onClick={del}
              disabled={busy}
              className="rounded-md border border-destructive/40 px-4 py-2 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {!row && (
            <p className="text-sm text-muted-foreground">
              No key yet. Paste an OpenRouter API key to seat the board.
            </p>
          )}
          <input
            type="password"
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="sk-or-..."
            className="w-full rounded-md border border-border bg-surface-2 px-4 py-3 font-mono text-sm text-foreground outline-none focus:border-primary"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={row ? rotate : store}
              disabled={busy || !input.trim()}
              className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Working…" : row ? "Save rotated key" : "Store key"}
            </button>
            {row && (
              <button
                onClick={() => {
                  setShowForm(false);
                  setInput("");
                }}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

type GhStatus = {
  configured: boolean;
  connected: boolean;
  last4: string | null;
  status: "valid" | "invalid" | null;
};

async function callGh(action: string, payload: Record<string, unknown> = {}) {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const { data, error } = await supabase.functions.invoke("github-oauth", {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) throw error;
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data;
}

function GitHubCard({ isAdmin }: { isAdmin: boolean }) {
  const [state, setState] = useState<GhStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [iframeNotice, setIframeNotice] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refresh() {
    setLoadError(null);
    try {
      const data = (await callGh("status")) as GhStatus;
      setState(data);
    } catch (e) {
      const msg = (e as Error).message ?? "Failed to load GitHub status";
      setLoadError(msg);
      toast.error(msg);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function connect() {
    setBusy(true);
    try {
      const result = await startGithubConnect({ returnTo: "/settings" });
      if (result === "embedded") {
        setIframeNotice(true);
        setBusy(false);
        return;
      }
      setIframeNotice(false);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect GitHub?")) return;
    setBusy(true);
    try {
      await callGh("disconnect");
      toast.success("Disconnected.");
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chip = state?.status === "valid"
    ? "border-success/40 bg-success/15 text-success"
    : state?.status === "invalid"
    ? "border-destructive/40 bg-destructive/15 text-destructive"
    : "border-border bg-surface-2 text-muted-foreground";

  return (
    <section className="rounded-xl border border-border bg-surface-1 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-xl text-foreground">GitHub</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The board reads your repo to audit real code against the plan. Read-only.
          </p>
        </div>
        {state?.connected && (
          <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${chip}`}>
            {state.status ?? "unknown"}
          </span>
        )}
      </div>

      {loadError ? (
        <div role="alert" className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Couldn't reach the GitHub connector.</p>
          <p className="mt-1 break-words text-destructive/80">{loadError}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 inline-flex rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            Retry
          </button>
        </div>
      ) : !state ? (
        <div className="mt-6 h-16 animate-pulse rounded-md bg-surface-2" role="status" aria-label="Loading GitHub status" />
      ) : !state.configured ? (
        <div className="mt-6 rounded-md border border-dashed border-border bg-surface-2 p-4 text-sm text-muted-foreground">
          GitHub connection isn't configured yet — the program admin sets two backend secrets to enable it.
          {isAdmin && (
            <p className="mt-2 font-mono text-[11px] text-foreground/70">
              Add <span className="text-foreground">GITHUB_CLIENT_ID</span> and <span className="text-foreground">GITHUB_CLIENT_SECRET</span> in Project Settings → Secrets.
            </p>
          )}
        </div>
      ) : !state.connected ? (
        <div className="mt-6 space-y-3">
          {iframeNotice && (
            <div className="rounded-md border border-dashed border-primary/40 bg-primary/15 p-4">
              <p className="text-sm text-foreground">
                GitHub can't open inside an embedded preview. Open the app in its own browser tab, then connect.
              </p>
              <button
                onClick={() => window.open(window.location.href, "_blank")}
                className="mt-3 rounded-md border border-primary/40 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
              >
                Open in new tab
              </button>
            </div>
          )}
          <button
            onClick={connect}
            disabled={busy}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Redirecting…" : "Connect GitHub"}
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-3">
            <span className="font-mono text-xs text-muted-foreground">ghp_…</span>
            <span className="font-mono text-sm text-foreground">{state.last4}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {state.status === "invalid" && (
              <button
                onClick={connect}
                disabled={busy}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
              >
                Reconnect
              </button>
            )}
            <button
              onClick={disconnect}
              disabled={busy}
              className="rounded-md border border-destructive/40 px-4 py-2 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ModelRegistryEditor() {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.rpc("admin_model_registry");
    if (error) toast.error(error.message);
    else {
      const rows = ((data ?? []) as Seat[]).slice().sort((a, b) => a.seat.localeCompare(b.seat));
      setSeats(rows);
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  function update(seat: string, patch: Partial<Seat>) {
    setSeats((prev) => prev.map((s) => (s.seat === seat ? { ...s, ...patch } : s)));
  }

  async function save(seat: Seat) {
    setSaving(seat.seat);
    const { error } = await supabase
      .from("model_registry")
      .update({
        model_id: seat.model_id,
        display_name: seat.display_name,
        role_prompt: seat.role_prompt,
        enabled: seat.enabled,
        max_cost_per_run: seat.max_cost_per_run,
        fallback_model_id: seat.fallback_model_id,
      })
      .eq("seat", seat.seat);
    if (error) toast.error(error.message);
    else toast.success(`${seat.seat} saved`);
    setSaving(null);
  }

  if (loading) return <div className="h-40 animate-pulse rounded-md bg-surface-2" />;
  return (
    <div className="space-y-4">
      {seats.map((s) => (
        <div key={s.seat} className="rounded-lg border border-border bg-surface-2 p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              {s.seat}
            </span>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => update(s.seat, { enabled: e.target.checked })}
              />
              Enabled
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Display name</label>
              <input
                value={s.display_name ?? ""}
                onChange={(e) => update(s.seat, { display_name: e.target.value })}
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Model ID</label>
              <input
                value={s.model_id}
                onChange={(e) => update(s.seat, { model_id: e.target.value })}
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs text-muted-foreground">Role prompt</label>
              <textarea
                value={s.role_prompt ?? ""}
                onChange={(e) => update(s.seat, { role_prompt: e.target.value })}
                rows={3}
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Max cost / run ($)</label>
              <input
                type="number"
                step="0.01"
                value={s.max_cost_per_run}
                onChange={(e) => update(s.seat, { max_cost_per_run: Number(e.target.value) })}
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Refusal fallback model</label>
              <input
                value={s.fallback_model_id ?? ""}
                onChange={(e) => update(s.seat, { fallback_model_id: e.target.value || null })}
                placeholder="moonshotai/kimi-k3"
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
              />
            </div>
          </div>
          <div className="mt-4">
            <button
              onClick={() => save(s)}
              disabled={saving === s.seat}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              {saving === s.seat ? "Saving…" : "Save seat"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DefaultDailyCapEditor() {
  // Fail-closed load state: never render a fabricated fallback like $25
  // as if it were the current configured cap. Loading, error, and
  // "no value configured yet" are distinct states; save is disabled until
  // a real value has actually loaded.
  type CapState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "unset" }
    | { kind: "ready"; usd: number };
  const [state, setState] = useState<CapState>({ kind: "loading" });
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setState({ kind: "loading" });
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "default_daily_cap_usd")
      .maybeSingle();
    if (error) {
      setState({ kind: "error", message: error.message });
      return;
    }
    const raw = (data?.value as { usd?: number } | null)?.usd;
    const n = Number(raw);
    if (data && Number.isFinite(n) && n > 0) {
      setState({ kind: "ready", usd: n });
      setDraft(String(n));
    } else {
      setState({ kind: "unset" });
      setDraft("");
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    const usd = Number(draft);
    if (!Number.isFinite(usd) || usd <= 0) return;
    setSaving(true);
    const { error } = await supabase
      .from("app_settings")
      .update({ value: { usd }, updated_at: new Date().toISOString() })
      .eq("key", "default_daily_cap_usd");
    if (error) toast.error(error.message);
    else {
      toast.success(`Default daily cap set to $${usd.toFixed(2)}`);
      setState({ kind: "ready", usd });
    }
    setSaving(false);
  }

  if (state.kind === "loading") {
    return <div className="h-20 animate-pulse rounded-md bg-surface-2" role="status" aria-label="Loading default daily cap" />;
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-5 text-sm text-destructive">
        <p className="font-medium">Couldn't load the default daily cap.</p>
        <p className="mt-1 break-words text-destructive/80">{state.message}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 inline-flex rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
        >
          Retry
        </button>
      </div>
    );
  }
  const canSave =
    state.kind === "ready"
      ? Number.isFinite(Number(draft)) && Number(draft) > 0 && !saving
      : false;
  const draftNum = Number(draft);
  const draftValid = Number.isFinite(draftNum) && draftNum > 0;
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-5">
      <label className="mb-2 block text-xs text-muted-foreground">Default daily cap ($ USD)</label>
      {state.kind === "unset" && (
        <p className="mb-3 text-xs text-muted-foreground">
          No value configured yet in runtime app_settings. Enter a value to seed it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="number"
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={state.kind === "unset" ? "e.g. 150.00" : ""}
          className="w-40 rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
        />
        <button
          onClick={save}
          disabled={!draftValid || saving || state.kind !== "ready"}
          title={state.kind !== "ready" ? "Load the current value before saving." : undefined}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
        >
          {saving ? "Saving…" : canSave ? "Save default" : "Save default"}
        </button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Applies to any user whose cohort hasn't set its own cap. Resets at 00:00 UTC.
      </p>
    </div>
  );
}

function ConstitutionEditor() {
  const [loadState, dispatch] = useReducer(
    settingsLoadReducer<{ text: string; version: number }>,
    undefined,
    initialSettingsLoadState<{ text: string; version: number }>,
  );
  const [text, setText] = useState("");
  const [version, setVersion] = useState(1);
  const [saving, setSaving] = useState(false);

  async function load() {
    dispatch({ type: "retry" });
    const { data, error } = await supabase
      .from("app_settings")
      .select("value, version")
      .eq("key", "constitution")
      .maybeSingle();
    if (error) {
      dispatch({ type: "failure", message: error.message });
      return;
    }
    const t = ((data?.value as { text?: string } | null)?.text) ?? "";
    const v = data?.version ?? 1;
    setText(t);
    setVersion(v);
    dispatch({ type: "success", value: { text: t, version: v } });
  }
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("app_settings")
      .update({
        value: { text },
        version: version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("key", "constitution");
    if (error) toast.error(error.message);
    else {
      toast.success(`Constitution v${version + 1} saved`);
      setVersion((v) => v + 1);
    }
    setSaving(false);
  }

  if (loadState.kind === "loading") {
    return <div className="h-40 animate-pulse rounded-md bg-surface-2" />;
  }
  if (loadState.kind === "error") {
    return (
      <div className="rounded-lg border border-destructive/40 bg-surface-2 p-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-destructive">
          Failed to load constitution
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{loadState.message}</p>
        <button
          onClick={() => void load()}
          className="mt-4 rounded-md border border-border bg-surface-1 px-4 py-2 text-sm font-medium text-foreground transition-all hover:bg-surface-2"
        >
          Retry
        </button>
      </div>
    );
  }
  const canSave = isSaveEnabled(loadState) && !saving;
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          Current version
        </span>
        <span className="font-mono text-xs text-foreground">v{version}</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
      />
      <div className="mt-4">
        <button
          onClick={save}
          disabled={!canSave}
          className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save and bump version"}
        </button>
      </div>
    </div>
  );
}


function SettingsPage() {
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      const { data: p } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .maybeSingle();
      setRole(p?.role ?? null);
    })();
  }, []);

  const isAdmin = role === "admin";

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12 md:py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Settings
      </span>
      <h1 className="mt-3 font-display text-4xl leading-tight text-foreground">
        Settings
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Keys, providers, and — if you have the gavel — the board's own configuration.
      </p>

      <div className="mt-10 space-y-6">
        <OpenRouterCard />
        <GitHubCard isAdmin={isAdmin} />
      </div>

      <div className="mt-14 border-t border-border pt-10">
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          Spend
        </span>
        <h2 className="mt-3 font-display text-2xl text-foreground">The meter.</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Every board call is logged. Resets at 00:00 UTC.
        </p>
        <div className="mt-6">
          <SpendPanel />
        </div>
      </div>


      {isAdmin && (
        <>
          <div className="mt-14 border-t border-border pt-10">
            <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              Admin · Board configuration
            </span>
            <h2 className="mt-3 font-display text-2xl text-foreground">Model registry</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Reassign a seat's model, edit its role prompt, or cap its per-run spend.
            </p>
            <div className="mt-6">
              <ModelRegistryEditor />
            </div>
          </div>

          <div className="mt-14 border-t border-border pt-10">
            <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              Admin · Default daily cap
            </span>
            <h2 className="mt-3 font-display text-2xl text-foreground">The workspace ceiling.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Fallback cap when a cohort hasn't set its own.
            </p>
            <div className="mt-6">
              <DefaultDailyCapEditor />
            </div>
          </div>

          <div className="mt-14 border-t border-border pt-10">
            <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              Admin · Constitution
            </span>
            <h2 className="mt-3 font-display text-2xl text-foreground">
              The governing text.
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Injected into every board call. Saving bumps the version.
            </p>
            <div className="mt-6">
              <ConstitutionEditor />
            </div>
          </div>

          <div className="mt-14 border-t border-border pt-10">
            <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              Admin · Field manual
            </span>
            <h2 className="mt-3 font-display text-2xl text-foreground">Cohort learnings.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The Chair mines recent audit findings and batch outcomes for recurring Lovable
              failure patterns. Approve a rule and every future prompt carries it.
            </p>
            <div className="mt-6">
              <FlywheelPanel />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type Proposal = {
  id: string;
  proposed_rule: string;
  rationale: string | null;
  status: "pending" | "approved" | "dismissed";
  created_at: string;
};

function FlywheelPanel() {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [addenda, setAddenda] = useState<string[]>([]);
  const [mining, setMining] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  async function load() {
    const [{ data: rows }, { data: setting }] = await Promise.all([
      supabase
        .from("field_manual_proposals")
        .select("id, proposed_rule, rationale, status, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      supabase.from("app_settings").select("value").eq("key", "field_manual_addenda").maybeSingle(),
    ]);
    setProposals((rows ?? []) as Proposal[]);
    const items = (setting?.value as { items?: unknown[] } | null)?.items;
    setAddenda(Array.isArray(items) ? items.map(String) : []);
  }
  useEffect(() => { void load(); }, []);

  async function mine() {
    setMining(true);
    try {
      const { data, error } = await supabase.functions.invoke("flywheel-miner", { body: {} });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.status === "no_key") { toast.error("Add your OpenRouter key first — the miner runs on it."); return; }
      if (data?.status === "no_evidence") { toast("No findings or outcomes in the last 30 days yet."); return; }
      toast.success(data.inserted ? `${data.inserted} new rule${data.inserted === 1 ? "" : "s"} proposed.` : "Nothing new — the manual already covers recent history.");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMining(false);
    }
  }

  async function decide(p: Proposal, status: "approved" | "dismissed") {
    setActing(p.id);
    try {
      if (status === "approved") {
        // Re-read before writing so two admins can't clobber each other's approvals.
        const { data: setting } = await supabase.from("app_settings").select("value").eq("key", "field_manual_addenda").maybeSingle();
        const current = (setting?.value as { items?: unknown[] } | null)?.items;
        const items = Array.isArray(current) ? current.map(String) : [];
        if (!items.includes(p.proposed_rule)) items.push(p.proposed_rule);
        const { error: aerr } = await supabase
          .from("app_settings")
          .update({ value: { items }, updated_at: new Date().toISOString() })
          .eq("key", "field_manual_addenda");
        if (aerr) throw aerr;
      }
      const { error } = await supabase
        .from("field_manual_proposals")
        .update({ status, decided_at: new Date().toISOString() })
        .eq("id", p.id);
      if (error) throw error;
      toast.success(status === "approved" ? "Rule adopted — every future prompt carries it." : "Dismissed.");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActing(null);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface-1 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[11px] text-muted-foreground">
          {addenda.length} adopted rule{addenda.length === 1 ? "" : "s"} · {(proposals ?? []).length} pending
        </p>
        <button
          onClick={mine}
          disabled={mining}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
        >
          {mining ? "The Chair is reading the history…" : "Mine recent findings"}
        </button>
      </div>

      {addenda.length > 0 && (
        <div className="mt-4 space-y-1">
          {addenda.map((a, i) => (
            <p key={i} className="border-l-2 border-success pl-3 text-sm text-foreground/90">{a}</p>
          ))}
        </div>
      )}

      {proposals === null ? (
        <div className="mt-4 h-16 animate-pulse rounded-lg bg-surface-2" />
      ) : proposals.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No pending proposals. Mine after a batch of audits lands.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {proposals.map((p) => (
            <div key={p.id} className="rounded-lg border border-border bg-background/40 p-4">
              <p className="text-sm text-foreground">{p.proposed_rule}</p>
              {p.rationale && <p className="mt-1 text-xs text-muted-foreground">{p.rationale}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => decide(p, "approved")}
                  disabled={acting === p.id}
                  className="rounded-md border border-success/50 bg-success/30 px-3 py-1.5 text-xs text-foreground hover:brightness-110 disabled:opacity-60"
                >
                  Adopt into the manual
                </button>
                <button
                  onClick={() => decide(p, "dismissed")}
                  disabled={acting === p.id}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
