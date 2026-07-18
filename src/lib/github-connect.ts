import { supabase } from "@/integrations/supabase/client";

const RETURN_TO_KEY = "gh_return_to";

export async function startGithubConnect(
  opts?: { returnTo?: string },
): Promise<"started" | "embedded"> {
  if (typeof window === "undefined") return "started";
  if (window.self !== window.top) return "embedded";

  const returnTo =
    opts?.returnTo ?? window.location.pathname + window.location.search;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, returnTo);
  } catch {
    // sessionStorage may be unavailable; proceed without persistence.
  }

  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const { data, error } = await supabase.functions.invoke("github-oauth", {
    body: { action: "start", origin: window.location.origin },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) throw error;
  const payload = data as { url?: string; error?: string } | null;
  if (payload?.error) throw new Error(payload.error);
  if (!payload?.url) throw new Error("GitHub start returned no url.");

  window.location.href = payload.url;
  return "started";
}

export function consumeGithubReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    if (v && v.startsWith("/")) return v;
    return null;
  } catch {
    return null;
  }
}
