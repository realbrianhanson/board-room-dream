// Shared GitHub → code-payload assembly used by audit-runner and boardroom-orchestrator.
// deno-lint-ignore-file no-explicit-any
import { decryptSecret } from "./crypto.ts";
import {
  finalizeMigrationLedger,
  MIGRATION_MAX_FILES,
  type LedgerFetchStatus,
  type MigrationAttempt,
  type MigrationFile,
  parseMigrationsToInventory,
  renderTargetInventory,
} from "./target-schema-inventory.ts";

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|mp3|mp4|mov|woff2?|ttf|otf|eot|wasm|bin)$/i;
const LOCK_FILES = /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|deno\.lock)$/i;
const IGNORE_DIR = /(^|\/)(node_modules|dist|build|\.next|\.git|\.turbo|coverage)(\/|$)/;
// Never ship credential-bearing files to a model provider, even truncated.
const SECRET_FILES = /(^|\/)(\.env[^/]*|[^/]*\.(pem|p12|pfx)|id_rsa[^/]*|id_ed25519[^/]*|[^/]*service[-_]?account[^/]*\.json|[^/]*credentials[^/]*)$/i;

// Redact obvious secret material from code before any model call. The marker
// is deliberately loud so auditors can still flag "a secret was hardcoded
// here" without ever seeing the value.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED-SECRET]");
  return out;
}

// Byte-correct base64 -> UTF-8 decode. GitHub's Contents API returns file
// bodies base64-encoded (with embedded newlines); the previous implementation
// did `atob(...)` and passed the resulting Latin-1 binary string straight
// into the model, which corrupted every multi-byte UTF-8 codepoint (em-dash,
// ellipsis, middot, arrows, non-ASCII names) and produced spurious "mojibake"
// findings. Route the bytes through TextDecoder instead.
export function decodeGithubBase64(b64: string): string {
  const clean = String(b64 ?? "").replace(/\s+/g, "");
  if (!clean) return "";
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export type FilePayload = { path: string; content: string; bytes: number };

export async function ghToken(admin: any, userId: string): Promise<string | null> {
  const { data } = await admin
    .from("api_keys")
    .select("encrypted_key, status")
    .eq("user_id", userId)
    .eq("provider", "github")
    .maybeSingle();
  if (!data || data.status === "invalid") return null;
  return await decryptSecret(data.encrypted_key);
}

async function gh(token: string, path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "boardroom-app",
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

// Heuristic ordering: prefer frontend UI and route/component files first so
// small caps favor the code that actually shapes design + UX. Edge-function
// entrypoints and the shared server modules score alongside UI components:
// the 200-file audit cap used to drop the orchestrator, proxy and every
// shared helper — the files a security audit exists for (RC-6).
export function keyFileScore(path: string): number {
  const p = path.toLowerCase();
  let s = 0;
  if (/^(src|app|pages)\//.test(p)) s += 5;
  if (/(components|routes|pages|screens|views|features)\//.test(p)) s += 4;
  if (/\.(tsx|jsx|vue|svelte)$/.test(p)) s += 3;
  if (/\.(ts|js|mts|cjs)$/.test(p)) s += 2;
  if (/(index|home|landing|main|app)\.[a-z]+$/.test(p)) s += 2;
  if (/(readme|package\.json|tailwind\.config|vite\.config|tsconfig|astro\.config|next\.config)/.test(p)) s += 2;
  if (/\.(css|scss|md|json)$/.test(p)) s += 1;
  if (/^supabase\/functions\/[^/]+\/index\.ts$/.test(p)) s += 9;
  if (/^supabase\/functions\/_shared\/[^/]+\.ts$/.test(p)) s += 8;
  return s;
}

// Files that cost audit tokens without carrying product or security truth:
// tests, generated route trees and DB types, editor/lint config, prose.
// Applied to every assembled payload unless the caller passes exclude: null.
export const AUDIT_EXCLUDE =
  /(\.test\.|\.spec\.|__tests__\/|\.gen\.|routeTree\.gen|integrations\/supabase\/types\.ts|\.lovable\/|\.md$|\.prettier|eslint\.config|components\.json)/;

export function isExcludedPath(path: string, exclude: RegExp | null = AUDIT_EXCLUDE): boolean {
  return !!exclude && exclude.test(path);
}

const MIGRATION_SQL = /^supabase\/migrations\/[^/]+\.sql$/i;
// Synthetic path of the folded migration ledger: every supabase/migrations
// *.sql file at HEAD is parsed into one effective-schema inventory instead of
// shipping the raw SQL of every historical migration.
export const MIGRATION_INVENTORY_PATH = "supabase/migrations/EFFECTIVE_SCHEMA.inventory";
// GitHub's compare endpoint lists at most this many files in one response;
// a diff that large is not a trustworthy incremental set, so read the tree.
export const COMPARE_FILE_CAP = 300;

function basicKeep(path: string): boolean {
  return !BINARY_EXT.test(path) && !LOCK_FILES.test(path) && !IGNORE_DIR.test(path) && !SECRET_FILES.test(path);
}

export class NoChangesSinceBase extends Error {
  constructor(public readonly baseSha: string) {
    super(`No changes since the last audited commit ${baseSha.slice(0, 7)} - push first, or run a full rescan`);
    this.name = "NoChangesSinceBase";
  }
}

export type TreeEntry = { path: string; size: number; sha?: string };
export type CompareFile = { filename: string; status: string };
export type CompareResult = { ok: true; files: CompareFile[] } | { ok: false };

export type FileSelection = {
  /** Ordered files to fetch (already excluded: binaries, secrets, oversize, AUDIT_EXCLUDE, folded migrations). */
  toFetch: TreeEntry[];
  /** Every migration path at HEAD to fold into the inventory (empty when none are in scope). */
  migrationPaths: string[];
  /** Paths dropped before any fetch, with the reason folded into the caller's skipped list. */
  skippedPaths: string[];
  /** Non-removed files of a successful compare (before any filter), else []. */
  changedPaths: string[];
  removedPaths: string[];
  /** True when the payload covers only the changed set. */
  incremental: boolean;
  fileTree: string[];
};

// Pure. Decides WHAT to read before a single content fetch so the selection
// is deterministic and testable: incremental set vs whole tree, exclusions,
// tree-size pre-filter, key-file ordering, migration folding.
export function planFileSelection(input: {
  tree: TreeEntry[];
  compare: CompareResult | null;
  baseSha: string | null;
  maxFileBytes: number;
  preferKeyFiles: boolean;
  exclude: RegExp | null;
  foldMigrations: boolean;
}): FileSelection {
  const treeOk = input.tree.filter((t) => basicKeep(t.path));
  const bySize = new Map(input.tree.map((t) => [t.path, t] as const));
  const fileTree = treeOk.map((t) => t.path).slice(0, 400);

  let candidates: TreeEntry[] = treeOk;
  let changedPaths: string[] = [];
  let removedPaths: string[] = [];
  let incremental = false;
  if (input.baseSha && input.compare?.ok) {
    const nonRemoved = input.compare.files.filter((f) => f.status !== "removed");
    removedPaths = input.compare.files.filter((f) => f.status === "removed").map((f) => f.filename);
    if (nonRemoved.length === 0) throw new NoChangesSinceBase(input.baseSha);
    if (input.compare.files.length < COMPARE_FILE_CAP) {
      incremental = true;
      changedPaths = nonRemoved.map((f) => f.filename);
      candidates = changedPaths
        .map((p) => bySize.get(p) ?? { path: p, size: 0 })
        .filter((t) => basicKeep(t.path));
    }
  }

  const skippedPaths: string[] = [];
  const toFetch: TreeEntry[] = [];
  let migrationPaths: string[] = [];
  let migrationInScope = false;
  for (const t of candidates) {
    if (input.foldMigrations && MIGRATION_SQL.test(t.path)) { migrationInScope = true; continue; }
    if (isExcludedPath(t.path, input.exclude)) { skippedPaths.push(t.path); continue; }
    if (t.size > input.maxFileBytes) { skippedPaths.push(t.path); continue; }
    toFetch.push(t);
  }
  if (migrationInScope) {
    migrationPaths = treeOk.map((t) => t.path).filter((p) => MIGRATION_SQL.test(p)).sort();
    if (incremental) changedPaths = [...changedPaths, MIGRATION_INVENTORY_PATH];
  }

  const ordered = input.preferKeyFiles
    ? toFetch
      .map((f) => ({ f, score: keyFileScore(f.path) }))
      .sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
      .map((x) => x.f)
    : toFetch;

  return { toFetch: ordered, migrationPaths, skippedPaths, changedPaths, removedPaths, incremental, fileTree };
}

// Bounded parallel map that preserves input order in its result.
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Pure. One inventory document standing in for every migration file.
export function renderMigrationInventoryFile(
  migrations: readonly MigrationFile[],
  totalPaths: number,
): string {
  const inv = parseMigrationsToInventory(migrations);
  const header = `EFFECTIVE SCHEMA INVENTORY derived from ${migrations.length} of ${totalPaths} supabase/migrations/*.sql files at HEAD, applied in lexicographic order (raw SQL not shown; cite this file for schema-level findings and quote the inventory line).`;
  return `${header}\n\n${renderTargetInventory(inv)}`;
}

export type AssembleOptions = {
  baseSha?: string | null;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** If true, order files by keyFileScore descending before capping. */
  preferKeyFiles?: boolean;
  /** Path exclusion; defaults to AUDIT_EXCLUDE, null disables it. */
  exclude?: RegExp | null;
  /** Replace raw migration SQL with one parsed inventory file (audits). */
  foldMigrations?: boolean;
  /** Parallel content fetches. */
  fetchConcurrency?: number;
};

export type AssembledPayload = {
  files: FilePayload[];
  headSha: string;
  branch: string;
  skipped: number;
  skippedPaths: string[];
  fileTree: string[];
  /** Set when the payload covers only files changed since baseSha. */
  incremental: boolean;
  baseSha: string | null;
  changedPaths: string[];
  removedPaths: string[];
};

export async function assembleFromGithub(
  token: string,
  repo: string,
  opts: AssembleOptions = {},
): Promise<AssembledPayload> {
  const {
    baseSha = null,
    maxFiles = 25,
    maxFileBytes = 100 * 1024,
    maxTotalBytes = 300 * 1024,
    preferKeyFiles = false,
    exclude = AUDIT_EXCLUDE,
    foldMigrations = false,
    fetchConcurrency = 8,
  } = opts;

  const repoRes = await gh(token, `/repos/${repo}`);
  if (repoRes.status >= 300) throw new Error(`repo: ${repoRes.body?.message ?? repoRes.status}`);
  const branch = repoRes.body?.default_branch ?? "main";
  const headRes = await gh(token, `/repos/${repo}/commits/${branch}`);
  if (headRes.status >= 300) throw new Error(`head: ${headRes.body?.message ?? headRes.status}`);
  const headSha: string = headRes.body?.sha;

  const tree = await gh(token, `/repos/${repo}/git/trees/${headSha}?recursive=1`);
  const treeEntries: TreeEntry[] = tree.status < 300 && Array.isArray(tree.body?.tree)
    ? tree.body.tree
      .filter((t: any) => t.type === "blob")
      .map((t: any) => ({ path: String(t.path), size: Number(t.size ?? 0) || 0, sha: t.sha ? String(t.sha) : undefined }))
    : [];

  let compare: CompareResult | null = null;
  if (baseSha) {
    const cmp = await gh(token, `/repos/${repo}/compare/${baseSha}...${headSha}`);
    compare = cmp.status < 300 && Array.isArray(cmp.body?.files)
      ? { ok: true, files: cmp.body.files.map((f: any) => ({ filename: String(f.filename), status: String(f.status ?? "") })) }
      : { ok: false };
  }

  const sel = planFileSelection({ tree: treeEntries, compare, baseSha, maxFileBytes, preferKeyFiles, exclude, foldMigrations });
  const skippedPaths = [...sel.skippedPaths];

  const fetchContent = async (path: string): Promise<{ ok: true; content: string; size: number } | { ok: false }> => {
    const c = await gh(token, `/repos/${repo}/contents/${encodeURI(path)}?ref=${headSha}`);
    if (c.status >= 300 || Array.isArray(c.body)) return { ok: false };
    const raw = c.body?.encoding === "base64"
      ? decodeGithubBase64(String(c.body?.content ?? ""))
      : String(c.body?.content ?? "");
    return { ok: true, content: raw, size: Number(c.body?.size ?? 0) };
  };

  const files: FilePayload[] = [];
  let total = 0;

  if (sel.migrationPaths.length) {
    if (sel.migrationPaths.length > MIGRATION_MAX_FILES) {
      skippedPaths.push(...sel.migrationPaths);
    } else {
      const fetched = await mapPool(sel.migrationPaths, fetchConcurrency, fetchContent);
      const migrations: MigrationFile[] = [];
      fetched.forEach((r, i) => {
        if (r.ok) migrations.push({ path: sel.migrationPaths[i], sql: r.content });
        else skippedPaths.push(sel.migrationPaths[i]);
      });
      if (migrations.length) {
        const content = redactSecrets(renderMigrationInventoryFile(migrations, sel.migrationPaths.length));
        total += content.length;
        files.push({ path: MIGRATION_INVENTORY_PATH, content, bytes: content.length });
      }
    }
  }

  for (let i = 0; i < sel.toFetch.length; i += fetchConcurrency) {
    if (files.length >= maxFiles) {
      skippedPaths.push(...sel.toFetch.slice(i).map((f) => f.path));
      break;
    }
    const batch = sel.toFetch.slice(i, i + fetchConcurrency);
    const results = await mapPool(batch, fetchConcurrency, (f) => fetchContent(f.path));
    results.forEach((r, k) => {
      const path = batch[k].path;
      if (files.length >= maxFiles || !r.ok || r.size > maxFileBytes) { skippedPaths.push(path); return; }
      const content = redactSecrets(r.content);
      if (total + content.length > maxTotalBytes) { skippedPaths.push(path); return; }
      total += content.length;
      files.push({ path, content, bytes: content.length });
    });
  }

  return {
    files,
    headSha,
    branch,
    skipped: skippedPaths.length,
    skippedPaths,
    fileTree: sel.fileTree,
    incremental: sel.incremental,
    baseSha: sel.incremental ? baseSha : null,
    changedPaths: sel.changedPaths,
    removedPaths: sel.removedPaths,
  };
}

export function formatFiles(files: FilePayload[]): string {
  if (!files.length) return "(no code files were readable)";
  return files
    .map((f) => `\n=== FILE: ${f.path} (${f.bytes} bytes) ===\n${f.content}`)
    .join("\n");
}

// -------- Target-repo migration ledger (JIT compiler schema authority) --------
//
// Fetches every supabase/migrations/*.sql file from the linked target repo
// and returns the ordered list plus compact provenance. NEVER uses the
// platform database as evidence for the target project's schema.
//
// TARGET-SCHEMA-LEDGER-R2: strict fail-closed. Any GitHub tree failure,
// malformed/non-array tree, zero matching paths, or any per-file fetch/
// decoding failure produces {ok:false}. No skips, no partial ledgers.


export async function fetchTargetMigrations(
  token: string,
  repo: string,
): Promise<LedgerFetchStatus> {
  try {
    const repoRes = await gh(token, `/repos/${repo}`);
    if (repoRes.status >= 300) {
      return { ok: false, code: "SCHEMA_LEDGER_FETCH_FAILED", message: `repo: ${repoRes.body?.message ?? repoRes.status}` };
    }
    const branch = repoRes.body?.default_branch ?? "main";
    const headRes = await gh(token, `/repos/${repo}/commits/${branch}`);
    if (headRes.status >= 300) {
      return { ok: false, code: "SCHEMA_LEDGER_FETCH_FAILED", message: `head: ${headRes.body?.message ?? headRes.status}` };
    }
    const headSha: string = String(headRes.body?.sha ?? "");
    if (!headSha) {
      return { ok: false, code: "SCHEMA_LEDGER_FETCH_FAILED", message: "head commit missing sha" };
    }
    const tree = await gh(token, `/repos/${repo}/git/trees/${headSha}?recursive=1`);
    if (tree.status >= 300) {
      return { ok: false, code: "SCHEMA_LEDGER_FETCH_FAILED", message: `tree: ${tree.body?.message ?? tree.status}` };
    }
    if (!tree.body || !Array.isArray(tree.body.tree)) {
      return { ok: false, code: "SCHEMA_LEDGER_FETCH_FAILED", message: "tree: malformed response (missing tree array)" };
    }
    const paths: string[] = tree.body.tree
      .filter((t: any) => t && t.type === "blob" && /^supabase\/migrations\/[^/]+\.sql$/i.test(String(t.path ?? "")))
      .map((t: any) => String(t.path));
    paths.sort();
    if (paths.length === 0) {
      return {
        ok: false,
        code: "SCHEMA_LEDGER_FETCH_FAILED",
        message: "no migration ledger: linked repo has zero supabase/migrations/*.sql files at HEAD — add the migrations folder and retry",
      };
    }
    if (paths.length > MIGRATION_MAX_FILES) {
      return { ok: false, code: "SCHEMA_LEDGER_TOO_LARGE", message: `target repo has ${paths.length} migrations (cap ${MIGRATION_MAX_FILES})` };
    }
    const attempts: MigrationAttempt[] = [];
    for (const p of paths) {
      const c = await gh(token, `/repos/${repo}/contents/${encodeURI(p)}?ref=${headSha}`);
      if (c.status >= 300) {
        attempts.push({ ok: false, path: p, reason: `HTTP ${c.status}: ${c.body?.message ?? "content fetch failed"}` });
        break;
      }
      if (Array.isArray(c.body)) {
        attempts.push({ ok: false, path: p, reason: "path resolved to a directory listing" });
        break;
      }
      const encoding = c.body?.encoding;
      const rawContent = c.body?.content;
      if (encoding !== "base64" || typeof rawContent !== "string") {
        attempts.push({ ok: false, path: p, reason: `unsupported or missing content encoding (${encoding ?? "none"})` });
        break;
      }
      const sql = decodeGithubBase64(rawContent);
      const reportedBytes = typeof c.body?.size === "number" ? c.body.size : null;
      attempts.push({ ok: true, path: p, sql, reportedBytes });
    }
    return finalizeMigrationLedger({ headSha, attempts });
  } catch (e) {
    return { ok: false, code: "SCHEMA_LEDGER_FETCH_FAILED", message: (e as Error).message };
  }
}

