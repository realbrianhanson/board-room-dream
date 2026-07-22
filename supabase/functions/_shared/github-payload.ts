// Shared GitHub → code-payload assembly used by audit-runner and boardroom-orchestrator.
// deno-lint-ignore-file no-explicit-any
import { decryptSecret } from "./crypto.ts";

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
// small caps favor the code that actually shapes design + UX.
function keyFileScore(path: string): number {
  const p = path.toLowerCase();
  let s = 0;
  if (/^(src|app|pages)\//.test(p)) s += 5;
  if (/(components|routes|pages|screens|views|features)\//.test(p)) s += 4;
  if (/\.(tsx|jsx|vue|svelte)$/.test(p)) s += 3;
  if (/\.(ts|js|mts|cjs)$/.test(p)) s += 2;
  if (/(index|home|landing|main|app)\.[a-z]+$/.test(p)) s += 2;
  if (/(readme|package\.json|tailwind\.config|vite\.config|tsconfig|astro\.config|next\.config)/.test(p)) s += 2;
  if (/\.(css|scss|md|json)$/.test(p)) s += 1;
  return s;
}

export type AssembleOptions = {
  baseSha?: string | null;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** If true, order files by keyFileScore descending before capping. */
  preferKeyFiles?: boolean;
};

export type AssembledPayload = {
  files: FilePayload[];
  headSha: string;
  branch: string;
  skipped: number;
  fileTree: string[];
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
  } = opts;

  const repoRes = await gh(token, `/repos/${repo}`);
  if (repoRes.status >= 300) throw new Error(`repo: ${repoRes.body?.message ?? repoRes.status}`);
  const branch = repoRes.body?.default_branch ?? "main";
  const headRes = await gh(token, `/repos/${repo}/commits/${branch}`);
  if (headRes.status >= 300) throw new Error(`head: ${headRes.body?.message ?? headRes.status}`);
  const headSha: string = headRes.body?.sha;

  let candidates: { path: string }[] = [];
  const tree = await gh(token, `/repos/${repo}/git/trees/${headSha}?recursive=1`);
  const treePaths: string[] = tree.status < 300 && Array.isArray(tree.body?.tree)
    ? tree.body.tree.filter((t: any) => t.type === "blob").map((t: any) => String(t.path))
    : [];

  if (baseSha) {
    const cmp = await gh(token, `/repos/${repo}/compare/${baseSha}...${headSha}`);
    if (cmp.status < 300 && Array.isArray(cmp.body?.files)) {
      candidates = cmp.body.files
        .filter((f: any) => f.status !== "removed")
        .map((f: any) => ({ path: f.filename }));
    }
  }
  if (!candidates.length) candidates = treePaths.map((p) => ({ path: p }));

  let filtered = candidates.filter(
    (f) => !BINARY_EXT.test(f.path) && !LOCK_FILES.test(f.path) && !IGNORE_DIR.test(f.path) && !SECRET_FILES.test(f.path),
  );

  if (preferKeyFiles) {
    filtered = filtered
      .map((f) => ({ f, score: keyFileScore(f.path) }))
      .sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
      .map((x) => x.f);
  }

  const files: FilePayload[] = [];
  let total = 0;
  let skipped = 0;
  for (const f of filtered) {
    if (files.length >= maxFiles) { skipped++; continue; }
    const c = await gh(token, `/repos/${repo}/contents/${encodeURI(f.path)}?ref=${headSha}`);
    if (c.status >= 300 || Array.isArray(c.body)) { skipped++; continue; }
    const size: number = c.body?.size ?? 0;
    if (size > maxFileBytes) { skipped++; continue; }
    const raw = c.body?.encoding === "base64"
      ? decodeGithubBase64(String(c.body?.content ?? ""))
      : String(c.body?.content ?? "");
    const content = redactSecrets(raw);
    if (total + content.length > maxTotalBytes) { skipped++; continue; }
    total += content.length;
    files.push({ path: f.path, content, bytes: content.length });
  }

  const fileTree = treePaths
    .filter((p) => !BINARY_EXT.test(p) && !LOCK_FILES.test(p) && !IGNORE_DIR.test(p))
    .slice(0, 400);

  return { files, headSha, branch, skipped, fileTree };
}

export function formatFiles(files: FilePayload[]): string {
  if (!files.length) return "(no code files were readable)";
  return files
    .map((f) => `\n=== FILE: ${f.path} (${f.bytes} bytes) ===\n${f.content}`)
    .join("\n");
}
