import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/auth/github/callback")({
  component: GitHubCallbackPage,
});

function GitHubCallbackPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("Finishing GitHub connection…");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      if (err) {
        toast.error(`GitHub: ${err}`);
        navigate({ to: "/settings" });
        return;
      }
      if (!code || !state) {
        toast.error("GitHub returned no code.");
        navigate({ to: "/settings" });
        return;
      }
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) {
        toast.error("Sign in first to finish connecting GitHub.");
        navigate({ to: "/auth" });
        return;
      }
      const { data, error } = await supabase.functions.invoke("github-oauth", {
        body: { action: "callback", code, state },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error || (data as { error?: string })?.error) {
        toast.error((data as { error?: string })?.error ?? error?.message ?? "Failed");
      } else {
        toast.success("GitHub connected.");
      }
      setMessage("Done. Redirecting…");
      navigate({ to: "/settings" });
    })();
  }, [navigate]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      <p className="font-display text-xl text-foreground">{message}</p>
    </div>
  );
}
