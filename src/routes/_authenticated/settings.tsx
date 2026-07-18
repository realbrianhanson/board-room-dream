import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { SpendPanel } from "@/components/spend-panel";

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
    valid: "border-[hsl(160_45%_42%/0.4)] bg-[hsl(160_45%_42%/0.12)] text-[hsl(160_45%_62%)]",
    invalid: "border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.12)] text-[hsl(8_60%_65%)]",
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

  async function refresh() {
    setLoading(true);
    try {
      const data = (await callVault("list")) as { keys: KeyRow[] };
      const r = data.keys.find((k) => k.provider === "openrouter") ?? null;
      setRow(r);
      setShowForm(!r);
    } catch (e) {
      toast.error((e as Error).message);
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
        <div className="mt-6 h-16 animate-pulse rounded-md bg-surface-2" />
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
              className="rounded-md border border-[hsl(8_60%_45%/0.4)] px-4 py-2 text-sm text-[hsl(8_60%_65%)] transition-colors hover:bg-[hsl(8_60%_45%/0.12)] disabled:opacity-50"
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

  async function refresh() {
    try {
      const data = (await callGh("status")) as GhStatus;
      setState(data);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function connect() {
    if (window.self !== window.top) {
      setIframeNotice(true);
      return;
    }
    setIframeNotice(false);
    setBusy(true);
    try {
      const data = (await callGh("start", { origin: window.location.origin })) as { url: string };
      window.location.href = data.url;
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
    ? "border-[hsl(160_45%_42%/0.4)] bg-[hsl(160_45%_42%/0.12)] text-[hsl(160_45%_62%)]"
    : state?.status === "invalid"
    ? "border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.12)] text-[hsl(8_60%_65%)]"
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

      {!state ? (
        <div className="mt-6 h-16 animate-pulse rounded-md bg-surface-2" />
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
            <div className="rounded-md border border-dashed border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.12)] p-4">
              <p className="text-sm text-foreground">
                GitHub can't open inside an embedded preview. Open the app in its own browser tab, then connect.
              </p>
              <button
                onClick={() => window.open(window.location.href, "_blank")}
                className="mt-3 rounded-md border border-[hsl(38_65%_55%/0.4)] px-4 py-2 text-sm font-medium text-[hsl(38_70%_62%)] transition-colors hover:bg-[hsl(38_65%_55%/0.16)]"
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
              className="rounded-md border border-[hsl(8_60%_45%/0.4)] px-4 py-2 text-sm text-[hsl(8_60%_65%)] transition-colors hover:bg-[hsl(8_60%_45%/0.12)] disabled:opacity-50"
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
  const [usd, setUsd] = useState<number>(25);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "default_daily_cap_usd")
        .maybeSingle();
      const n = Number((data?.value as { usd?: number } | null)?.usd);
      if (Number.isFinite(n) && n > 0) setUsd(n);
      setLoading(false);
    })();
  }, []);

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("app_settings")
      .update({ value: { usd }, updated_at: new Date().toISOString() })
      .eq("key", "default_daily_cap_usd");
    if (error) toast.error(error.message);
    else toast.success(`Default daily cap set to $${usd.toFixed(2)}`);
    setSaving(false);
  }

  if (loading) return <div className="h-20 animate-pulse rounded-md bg-surface-2" />;
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-5">
      <label className="mb-2 block text-xs text-muted-foreground">Default daily cap ($ USD)</label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="number"
          step="0.01"
          value={usd}
          onChange={(e) => setUsd(Number(e.target.value))}
          className="w-40 rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
        />
        <button
          onClick={save}
          disabled={saving || !Number.isFinite(usd) || usd <= 0}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save default"}
        </button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Applies to any user whose cohort hasn't set its own cap. Resets at 00:00 UTC.
      </p>
    </div>
  );
}

function ConstitutionEditor() {
  const [text, setText] = useState("");
  const [version, setVersion] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("app_settings")
      .select("value, version")
      .eq("key", "constitution")
      .maybeSingle();
    if (error) toast.error(error.message);
    else if (data) {
      setText(((data.value as { text?: string })?.text) ?? "");
      setVersion(data.version);
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
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

  if (loading) return <div className="h-40 animate-pulse rounded-md bg-surface-2" />;
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
          disabled={saving}
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
        Set the terms.
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
        </>
      )}
    </div>
  );
}
