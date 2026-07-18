import { useCallback, useRef, useState } from "react";
import { unzip, strFromU8 } from "fflate";
import { ChevronDown, ChevronRight, FileArchive, Replace, Upload } from "lucide-react";

type Tab = "paste" | "zip";

type FileEntry = {
  path: string;
  bytes: number;
  included: boolean;
  reason?: string;
};

type ZipSummary = {
  zipName: string;
  files: FileEntry[];
  totalFound: number;
  includedCount: number;
  includedBytes: number;
  capHit: boolean;
};

const SKIP_DIRS = ["node_modules/", ".git/", "dist/", "build/", ".next/", "out/", "coverage/", ".lovable/"];
const SKIP_FILES = new Set(["package-lock.json", "bun.lock", "yarn.lock", "pnpm-lock.yaml"]);
const SKIP_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
  "woff", "woff2", "ttf", "eot", "pdf", "zip", "mp4", "mp3",
]);
const PRIORITY_PREFIXES = [
  "supabase/functions/",
  "supabase/migrations/",
  "src/routes/",
  "src/components/",
  "src/lib/",
  "src/hooks/",
];

function priorityOf(path: string): number {
  for (let i = 0; i < PRIORITY_PREFIXES.length; i++) {
    if (path.startsWith(PRIORITY_PREFIXES[i])) return i;
  }
  return PRIORITY_PREFIXES.length;
}

function extOf(path: string): string {
  const base = path.substring(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

function fileBaseName(path: string): string {
  return path.substring(path.lastIndexOf("/") + 1);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

async function unzipAsync(buf: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(buf, (err, files) => (err ? reject(err) : resolve(files)));
  });
}

export function CodeSourcePicker({
  value,
  onChange,
  maxBytes,
}: {
  value: string;
  onChange: (code: string) => void;
  maxBytes: number;
}) {
  const [tab, setTab] = useState<Tab>("paste");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ summary: ZipSummary; combined: string } | null>(null);
  const [committed, setCommitted] = useState<ZipSummary | null>(null);
  const [showList, setShowList] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processZip = useCallback(
    async (file: File) => {
      setError(null);
      setPending(null);
      if (!file.name.toLowerCase().endsWith(".zip")) {
        setError("That's not a .zip file.");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        setError("Zip is over 20MB. Trim it down and try again.");
        return;
      }
      setBusy(true);
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = await unzipAsync(buf);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const candidates: { path: string; text: string; bytes: number }[] = [];
        const skipped: FileEntry[] = [];

        for (const [rawPath, data] of Object.entries(entries)) {
          const path = rawPath.replace(/\\/g, "/");
          if (path.endsWith("/")) continue; // directory entry
          if (SKIP_DIRS.some((d) => path.includes(d))) {
            skipped.push({ path, bytes: data.length, included: false, reason: "vendor/build dir" });
            continue;
          }
          const base = fileBaseName(path);
          if (SKIP_FILES.has(base)) {
            skipped.push({ path, bytes: data.length, included: false, reason: "lockfile" });
            continue;
          }
          if (SKIP_EXTS.has(extOf(path))) {
            skipped.push({ path, bytes: data.length, included: false, reason: "binary/asset" });
            continue;
          }
          if (data.includes(0)) {
            skipped.push({ path, bytes: data.length, included: false, reason: "binary content" });
            continue;
          }
          let text: string;
          try {
            text = decoder.decode(data);
          } catch {
            skipped.push({ path, bytes: data.length, included: false, reason: "not utf-8" });
            continue;
          }
          candidates.push({ path, text, bytes: data.length });
        }

        candidates.sort((a, b) => {
          const pa = priorityOf(a.path);
          const pb = priorityOf(b.path);
          if (pa !== pb) return pa - pb;
          return a.path.localeCompare(b.path);
        });

        const includedFiles: FileEntry[] = [];
        const excludedByCap: FileEntry[] = [];
        let combined = "";
        let capHit = false;

        for (const c of candidates) {
          const block = `--- ${c.path} ---\n${c.text}\n\n`;
          if (combined.length + block.length > maxBytes) {
            capHit = true;
            excludedByCap.push({ path: c.path, bytes: c.bytes, included: false, reason: "cap reached" });
            continue;
          }
          combined += block;
          includedFiles.push({ path: c.path, bytes: c.bytes, included: true });
        }

        const allFiles = [...includedFiles, ...excludedByCap, ...skipped].sort((a, b) => a.path.localeCompare(b.path));
        const summary: ZipSummary = {
          zipName: file.name,
          files: allFiles,
          totalFound: candidates.length + skipped.length,
          includedCount: includedFiles.length,
          includedBytes: combined.length,
          capHit,
        };
        setPending({ summary, combined });
      } catch (err) {
        setError(err instanceof Error ? `Couldn't read the zip: ${err.message}` : "Couldn't read the zip.");
      } finally {
        setBusy(false);
      }
    },
    [maxBytes],
  );

  function commit() {
    if (!pending) return;
    onChange(pending.combined);
    setCommitted(pending.summary);
    setPending(null);
  }

  function replace() {
    setCommitted(null);
    setPending(null);
    onChange("");
    setError(null);
  }

  const pct = pending ? Math.min(100, (pending.summary.includedBytes / maxBytes) * 100) : 0;

  return (
    <div className="mt-4">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {(["paste", "zip"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.22em] transition-colors ${
              tab === t
                ? "border-primary text-[hsl(38_65%_72%)]"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "paste" ? "Paste code" : "Upload zip"}
          </button>
        ))}
      </div>

      {tab === "paste" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste the relevant source files here…"
          rows={10}
          className="mt-3 w-full rounded-lg border border-border bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground/90 outline-none focus:border-primary"
        />
      ) : (
        <div className="mt-3 space-y-3">
          {committed ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 p-4">
              <div className="flex items-center gap-3">
                <FileArchive className="h-5 w-5 text-[hsl(38_65%_70%)]" />
                <div>
                  <p className="font-mono text-[12px] text-foreground">{committed.zipName}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {committed.includedCount} files · {formatBytes(committed.includedBytes)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={replace}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground hover:border-primary/40 hover:text-foreground"
              >
                <Replace className="h-3.5 w-3.5" /> Replace
              </button>
            </div>
          ) : (
            <>
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) processZip(f);
                }}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/10"
                    : "border-border bg-surface-2 hover:border-primary/40"
                }`}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) processZip(f);
                    e.target.value = "";
                  }}
                />
                <Upload className="mb-2 h-6 w-6 text-[hsl(38_65%_70%)]" />
                <p className="font-mono text-[12px] text-foreground">
                  {busy ? "Reading the zip…" : "Drop a .zip here, or click to choose"}
                </p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  Up to 20MB · cap {formatBytes(maxBytes)} of source
                </p>
              </label>

              {error && (
                <p className="rounded-md border border-[hsl(8_60%_55%/0.4)] bg-[hsl(8_60%_25%/0.15)] px-3 py-2 font-mono text-[11px] text-[hsl(8_60%_78%)]">
                  {error}
                </p>
              )}

              {pending && (
                <div className="rounded-lg border border-border bg-surface-2 p-4">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                      {pending.summary.zipName}
                    </span>
                    <span className="font-mono text-[11px] text-foreground">
                      {formatBytes(pending.summary.includedBytes)} / {formatBytes(maxBytes)}
                    </span>
                  </div>
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-1">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${pct}%`,
                        background: pending.summary.capHit ? "hsl(38 65% 55%)" : "hsl(160 45% 48%)",
                      }}
                    />
                  </div>
                  <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                    Included {pending.summary.includedCount} of {pending.summary.totalFound} files ·{" "}
                    {pending.summary.files.filter((f) => !f.included).length} skipped
                  </p>
                  {pending.summary.capHit && (
                    <p className="mt-1 font-mono text-[11px] text-[hsl(38_65%_72%)]">
                      Included {pending.summary.includedCount} of {pending.summary.totalFound} files (cap reached) — prioritized functions, migrations, and routes; the rest were left out.
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowList((v) => !v)}
                    className="mt-3 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground hover:text-foreground"
                  >
                    {showList ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    File list
                  </button>
                  {showList && (
                    <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border/50 bg-surface-1">
                      <table className="w-full font-mono text-[11px]">
                        <tbody>
                          {pending.summary.files.map((f) => (
                            <tr key={f.path} className="border-t border-border/40 first:border-t-0">
                              <td className="truncate px-2 py-1 text-foreground/80">{f.path}</td>
                              <td className="whitespace-nowrap px-2 py-1 text-right text-muted-foreground">
                                {formatBytes(f.bytes)}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1 text-right">
                                {f.included ? (
                                  <span className="rounded-full border border-[hsl(160_45%_48%/0.4)] bg-[hsl(160_45%_28%/0.15)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[hsl(160_45%_72%)]">
                                    in
                                  </span>
                                ) : (
                                  <span
                                    className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
                                    title={f.reason ?? ""}
                                  >
                                    skip
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={commit}
                      disabled={pending.summary.includedCount === 0}
                      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-50"
                    >
                      Use this code
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
