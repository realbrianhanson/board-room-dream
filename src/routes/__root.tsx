import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-6xl font-semibold text-foreground">404</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This chamber is empty. Return to the boardroom.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">Session interrupted</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something on our side went wrong. Try again or head back.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface-1 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-2"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "App Blueprint — Audit, blueprint, and compile prompts for your Lovable app" },
      {
        name: "description",
        content:
          "App Blueprint audits your code, produces the Blueprint, and compiles step-by-step prompts you run in Lovable. The Boardroom — an adversarial council of frontier models — pressure-tests every decision. App Blueprint never builds or deploys your app for you.",
      },
      { property: "og:title", content: "App Blueprint — Audit, blueprint, and compile prompts for your Lovable app" },
      {
        property: "og:description",
        content:
          "App Blueprint audits your code, produces the Blueprint, and compiles step-by-step prompts you run in Lovable. The Boardroom — an adversarial council of frontier models — pressure-tests every decision. App Blueprint never builds or deploys your app for you.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "App Blueprint — Audit, blueprint, and compile prompts for your Lovable app" },
      { name: "twitter:description", content: "App Blueprint audits your code, produces the Blueprint, and compiles step-by-step prompts you run in Lovable. The Boardroom — an adversarial council of frontier models — pressure-tests every decision. App Blueprint never builds or deploys your app for you." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/6bc1f9e5-2f53-4179-a24e-d19261b25aa5/id-preview-db101d11--887503f1-4c18-4b48-87f8-05674e6d8964.lovable.app-1784399490838.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/6bc1f9e5-2f53-4179-a24e-d19261b25aa5/id-preview-db101d11--887503f1-4c18-4b48-87f8-05674e6d8964.lovable.app-1784399490838.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="dark min-h-screen bg-background text-foreground">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  // Mount the toaster only after the client has hydrated. sonner injects a
  // portal and reads browser APIs; rendering it in the SSR/first-render tree
  // risks a hydration mismatch that can kill interactivity on every page
  // (including sign-in). Deferring it keeps hydration purely deterministic.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      {hydrated && <Toaster />}
    </QueryClientProvider>
  );
}
