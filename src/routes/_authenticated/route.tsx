import {
  createFileRoute,
  Outlet,
  redirect,
  Link,
  useRouterState,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Settings,
  GraduationCap,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type ProfileRow = {
  id: string;
  role: "student" | "instructor" | "admin";
  cohort_id: string | null;
  display_name: string | null;
};

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Use getSession (reads the persisted session locally — no network round
    // trip) rather than getUser (which hits /auth/v1/user on every entry).
    // getUser races session propagation right after password sign-in and can
    // bounce the user back to /auth; it also adds a blocking network hop to
    // every authenticated navigation. RLS enforces real security server-side.
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) throw redirect({ to: "/auth" });
    return { user: session.user };
  },
  component: AuthenticatedShell,
});


// Kept intentionally short. Each project's stages (plan, design, build, audit)
// live inside its guided journey, not as top-level tabs — so the sidebar never
// asks the owner to figure out the sequence themselves.
const NAV = [
  { to: "/dashboard", label: "My Projects", icon: LayoutDashboard },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

function AuthenticatedShell() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [alertCount, setAlertCount] = useState<number>(0);

  const isInstructor = profile?.role === "instructor" || profile?.role === "admin";

  // Load the profile (and, for instructors, the open-alert count) WITHOUT
  // blocking first paint. The shell and the page Outlet render immediately;
  // the sidebar name/role/badge fill in when this resolves. Previously this
  // ran as a blocking route loader, so every navigation showed a black screen
  // until the profile round-trip (plus a second alerts round-trip) returned.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, role, cohort_id, display_name")
        .maybeSingle();
      if (cancelled) return;
      const prof = (data as ProfileRow | null) ?? null;
      setProfile(prof);
      if (prof?.role === "instructor" || prof?.role === "admin") {
        const { count } = await supabase
          .from("alerts")
          .select("id", { count: "exact", head: true })
          .eq("status", "open");
        if (!cancelled) setAlertCount(count ?? 0);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Onboarding redirect
  useEffect(() => {
    if (!profile) return;
    const skipped =
      typeof window !== "undefined" && localStorage.getItem("boardroom.cohort_skipped") === "1";
    if (!profile.cohort_id && !skipped && pathname !== "/onboarding") {
      navigate({ to: "/onboarding" });
    }
  }, [profile, pathname, navigate]);

  useEffect(() => setMobileOpen(false), [pathname]);

  // Live alert count for instructors.
  useEffect(() => {
    if (!isInstructor) return;
    const refresh = async () => {
      const { count } = await supabase
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .eq("status", "open");
      setAlertCount(count ?? 0);
    };
    const channel = supabase
      .channel("nav-alerts")
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, () => { void refresh(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [isInstructor]);

  const items = isInstructor
    ? [NAV[0], { to: "/cohort", label: "Cohort", icon: GraduationCap }, NAV[1]]
    : NAV;


  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-border bg-surface-1/90 px-4 py-3 backdrop-blur md:hidden">
        <span className="font-display text-sm tracking-[0.28em]">BOARDROOM</span>
        <button
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Toggle navigation"
          className="rounded-md border border-border p-2 text-muted-foreground hover:text-foreground"
        >
          {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </div>

      {/* Sidebar */}
      <aside
        className={`sticky top-0 z-30 flex h-screen w-64 shrink-0 flex-col border-r border-border bg-surface-1 transition-transform max-md:fixed max-md:inset-y-0 max-md:left-0 md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "max-md:-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center px-6">
          <span className="font-display text-base tracking-[0.28em] text-foreground">
            BOARDROOM
          </span>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {items.map((item) => {
            const active = pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-surface-2 text-foreground"
                    : "text-muted-foreground hover:bg-surface-2/60 hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
                {item.to === "/cohort" && alertCount > 0 && (
                  <span className="rounded-full border border-[hsl(8_60%_55%)]/40 bg-[hsl(8_60%_55%)]/10 px-1.5 py-0.5 font-mono text-[9px] leading-none text-[hsl(8_60%_55%)]">
                    {alertCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-4">
          <div className="mb-3 px-1">
            <p className="truncate text-sm text-foreground">
              {profile?.display_name ?? "Member"}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {profile?.role ?? "student"}
            </p>
          </div>
          <button
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <button
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
        />
      )}

      <main className="min-w-0 flex-1 pt-14 md:pt-0">
        <Outlet />
      </main>
    </div>
  );
}
