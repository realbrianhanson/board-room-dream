// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptSecret } from "../_shared/crypto.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp3|mp4|mov|woff2?|ttf|otf|eot|wasm|bin)$/i;

async function gh(admin: any, userId: string, path: string): Promise<{ status: number; body: any; headers: Headers }> {
  const { data, error } = await admin
    .from("api_keys")
    .select("encrypted_key, status")
    .eq("user_id", userId)
    .eq("provider", "github")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: 404, body: { error: "GitHub not connected" }, headers: new Headers() };
  const key = await decryptSecret(data.encrypted_key);
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "boardroom-app",
    },
  });
  if (res.status === 401) {
    await admin.from("api_keys").update({ status: "invalid" }).eq("user_id", userId).eq("provider", "github");
  }
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body, headers: res.headers };
}

function readable(status: number, body: any): string {
  if (status === 401) return "GitHub token invalid — please reconnect.";
  if (status === 403) {
    const msg = body?.message ?? "GitHub rate limit or forbidden.";
    return msg;
  }
  if (status === 404) return "Not found on GitHub.";
  return body?.message ?? `GitHub error ${status}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return j(401, { error: "Missing or invalid user JWT" });

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: uerr } = await userClient.auth.getUser();
  if (uerr || !userData.user) return j(401, { error: "Unauthorized" });
  const userId = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return j(400, { error: "Invalid JSON" }); }
  const action: string = body?.action;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function ownProject(project_id: string): Promise<{ id: string; github_repo: string | null } | null> {
    const { data, error } = await admin
      .from("projects")
      .select("id, user_id, github_repo")
      .eq("id", project_id)
      .maybeSingle();
    if (error) throw error;
    if (!data || data.user_id !== userId) return null;
    return { id: data.id, github_repo: data.github_repo };
  }

  try {
    if (action === "list_repos") {
      const { status, body: gb } = await gh(admin, userId, "/user/repos?per_page=100&sort=updated");
      if (status < 200 || status >= 300) return j(status, { error: readable(status, gb) });
      const repos = (gb as any[]).map((r) => ({
        full_name: r.full_name,
        private: !!r.private,
        updated_at: r.updated_at,
      }));
      return j(200, { repos });
    }

    if (action === "link_repo") {
      const project_id = String(body?.project_id ?? "");
      const full_name = String(body?.full_name ?? "").trim();
      if (!project_id || !full_name) return j(400, { error: "Missing project_id or full_name" });
      const proj = await ownProject(project_id);
      if (!proj) return j(403, { error: "Not your project" });
      // verify repo access
      const { status, body: gb } = await gh(admin, userId, `/repos/${full_name}`);
      if (status < 200 || status >= 300) return j(status, { error: readable(status, gb) });
      const { error } = await admin.from("projects").update({ github_repo: full_name }).eq("id", project_id);
      if (error) throw error;
      return j(200, { linked: true, full_name });
    }

    if (action === "head") {
      const project_id = String(body?.project_id ?? "");
      const proj = await ownProject(project_id);
      if (!proj) return j(403, { error: "Not your project" });
      if (!proj.github_repo) return j(400, { error: "No repo linked" });
      const repoRes = await gh(admin, userId, `/repos/${proj.github_repo}`);
      if (repoRes.status < 200 || repoRes.status >= 300) return j(repoRes.status, { error: readable(repoRes.status, repoRes.body) });
      const branch = repoRes.body?.default_branch ?? "main";
      const commitRes = await gh(admin, userId, `/repos/${proj.github_repo}/commits/${branch}`);
      if (commitRes.status < 200 || commitRes.status >= 300) return j(commitRes.status, { error: readable(commitRes.status, commitRes.body) });
      const c = commitRes.body;
      return j(200, {
        sha: c?.sha,
        message: c?.commit?.message ?? "",
        committed_at: c?.commit?.committer?.date ?? c?.commit?.author?.date ?? null,
        branch,
      });
    }

    if (action === "compare") {
      const project_id = String(body?.project_id ?? "");
      const base_sha = String(body?.base_sha ?? "");
      const proj = await ownProject(project_id);
      if (!proj) return j(403, { error: "Not your project" });
      if (!proj.github_repo) return j(400, { error: "No repo linked" });
      if (!base_sha) return j(400, { error: "Missing base_sha" });
      const { status, body: gb } = await gh(admin, userId, `/repos/${proj.github_repo}/compare/${base_sha}...HEAD`);
      if (status < 200 || status >= 300) return j(status, { error: readable(status, gb) });
      return j(200, {
        head_sha: gb?.merge_base_commit?.sha ? gb?.commits?.at(-1)?.sha ?? null : gb?.commits?.at(-1)?.sha ?? null,
        files: (gb?.files ?? []).map((f: any) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
      });
    }

    if (action === "get_file") {
      const project_id = String(body?.project_id ?? "");
      const path = String(body?.path ?? "");
      const ref = String(body?.ref ?? "");
      const proj = await ownProject(project_id);
      if (!proj) return j(403, { error: "Not your project" });
      if (!proj.github_repo) return j(400, { error: "No repo linked" });
      if (!path) return j(400, { error: "Missing path" });
      if (BINARY_EXT.test(path)) return j(400, { error: "Binary file refused" });
      const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const { status, body: gb } = await gh(admin, userId, `/repos/${proj.github_repo}/contents/${encodeURI(path)}${qs}`);
      if (status < 200 || status >= 300) return j(status, { error: readable(status, gb) });
      if (Array.isArray(gb)) return j(400, { error: "Path is a directory" });
      const sizeBytes: number = gb?.size ?? 0;
      if (sizeBytes > 100 * 1024) {
        return j(200, { path, truncated: true, size: sizeBytes, sha: gb?.sha });
      }
      const content = gb?.encoding === "base64" ? atob((gb.content ?? "").replace(/\n/g, "")) : (gb?.content ?? "");
      return j(200, { path, truncated: false, size: sizeBytes, sha: gb?.sha, content });
    }

    return j(400, { error: "Unknown action" });
  } catch (e) {
    return j(500, { error: (e as Error).message });
  }
});
