import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { consumeGithubReturnTo } from "@/lib/github-connect";

export const Route = createFileRoute("/auth_/github/callback")({
  component: GitHubCallbackPage,
});

type State =
  | { kind: "working"; message: string }
  | { kind: "error"; error: string }
  | { kind: "success" };

function GitHubCallbackPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({
    kind: "working",
    message: "Finishing GitHub connection…",
  });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const stateParam = url.searchParams.get("state");
      const err =
        url.searchParams.get("error_description") ?? url.searchParams.get("error");
      if (err) {
        setState({ kind: "error", error: `GitHub: ${err}` });
        return;
      }
      if (!code || !stateParam) {
        setState({ kind: "error", error: "GitHub returned no code or state." });
        return;
      }
      const token = await getTokenWithRetry();
      if (!token) {
        setState({
          kind: "error",
          error: "You are signed out. Sign in first, then reconnect GitHub.",
        });
        return;
      }

      const { data, error } = await supabase.functions.invoke("github-oauth", {
        body: { action: "callback", code, state: stateParam },
        headers: { Authorization: `Bearer ${token}` },
      });
      const fnError = (data as { error?: string } | null)?.error ?? error?.message;
      if (fnError) {
        setState({ kind: "error", error: fnError });
        return;
      }
      const returnTo = consumeGithubReturnTo();
      if (returnTo) {
        toast.success("GitHub connected.");
        window.location.replace(returnTo);
        return;
      }
      setState({ kind: "success" });
    })();
  }, [navigate]);

  if (state.kind === "error") {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6">
        <div className="w-full rounded-xl border border-destructive/40 bg-surface-1 p-6 shadow-lg">
          <h1 className="font-display text-2xl text-foreground">
            GitHub connection failed
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The callback returned an error. You can retry from Settings.
          </p>
          <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/50 p-3 font-mono text-xs text-destructive">
            {state.error}
          </pre>
          <div className="mt-6 flex gap-3">
            <Button asChild>
              <Link to="/settings">Try again</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/dashboard">Back to dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "success") {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6">
        <div className="w-full rounded-xl border border-[hsl(160_45%_42%/0.4)] bg-surface-1 p-6 shadow-lg">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[hsl(160_45%_42%/0.4)] bg-[hsl(160_45%_42%/0.12)]">
            <Check className="h-5 w-5 text-[hsl(160_45%_62%)]" />
          </div>
          <h1 className="mt-4 font-display text-2xl text-foreground">GitHub connected.</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The board can now read your repos for audits.
          </p>
          <div className="mt-6 flex gap-3">
            <Button asChild>
              <Link to="/dashboard">Back to dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/settings">Settings</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      <p className="font-display text-xl text-foreground">{state.message}</p>
    </div>
  );
}
