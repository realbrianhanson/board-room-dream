// The Lovable execution contract — a single source-linked doctrine imported
// by every step that writes or reviews prompts a founder will paste into
// Lovable (batches draft/review/revise, batch compiler, audits). Update this
// file when Lovable's official docs change or cohort-wide audit findings
// reveal new failure patterns; every improvement here upgrades all future
// builds at once.
//
// Reviewed against official Lovable documentation.

export const LOVABLE_CONTRACT_REVIEWED_AT = "2026-07-22";
export const LOVABLE_CONTRACT_SOURCES = [
  "https://docs.lovable.dev/introduction/faq",
  "https://docs.lovable.dev/prompting/prompting-one",
  "https://docs.lovable.dev/tips-tricks/best-practice",
  "https://docs.lovable.dev/features/knowledge",
  "https://docs.lovable.dev/features/testing",
  "https://docs.lovable.dev/features/browser-testing",
] as const;

// Compact rules — the founder pastes these prompts into today's Lovable, not
// last year's. Keep this short and factual; do not restate the docs.
export const LOVABLE_FIELD_MANUAL = `LOVABLE EXECUTION CONTRACT (reviewed ${LOVABLE_CONTRACT_REVIEWED_AT}; sources: ${LOVABLE_CONTRACT_SOURCES.join(", ")})

STACK (do NOT assume — detect and preserve):
- Lovable ships two default stacks. Projects created from 2026-05-13 onward use TanStack Start (SSR, file-based routes in src/routes/, server functions). Older projects use React + Vite + React Router (client-only, src/pages/ or src/App.tsx).
- Backend for both is Lovable Cloud on Supabase (Postgres, Auth, Storage, Edge Functions).
- Detect from the LIVE REPO CONTRACT: presence of @tanstack/react-start / src/routes/__root.tsx = TanStack Start. Presence of react-router-dom or src/App.tsx with a <Routes> table + no src/routes/__root.tsx = React + Vite. Preserve whichever stack the repo already ships; never migrate stacks unless the current batch explicitly requires it.
- Greenfield (no live repo): say "use Lovable's current default stack" and do not hard-code a possibly-stale framework name. The founder's app will land on whichever default Lovable is shipping when they paste the batch.

PROMPT SHAPE (per official prompting-one + best-practice docs):
- One concern per prompt. Prompts that touch more than ~5 files or mix schema + UI + integration cause drift. Split into a follow-up batch instead.
- UI work is prompted by component / atomic section, never as an "entire page rewrite". Name the component and describe its states.
- Use real production copy, not lorem-ipsum. Ship the actual empty / loading / error states — they are part of the definition, not polish for later.
- Name everything: exact route paths ("/dashboard"), component names ("BatchCard"), table + column names ("batches.outcome_md"), edge function names. Unnamed things get invented names that drift between batches.
- State access rules for every table in plain words: who can read/insert/update/delete. Unstated → Lovable writes permissive policies.
- Pin what must NOT change: when collateral edits are a risk, list the files or areas Lovable must not touch.

DATABASE (additive only):
- Additive migrations only inside a build batch. Never rename or drop in the same batch that adds UI on top of the result.
- Enable RLS on every user-data table; scope to auth.uid(). GRANT explicitly to the roles the policies allow.
- Secrets go in Supabase secrets, never in code. Public Supabase anon/publishable keys are NOT secrets.

KNOWLEDGE (per features/knowledge doc):
- Project knowledge is concise architecture + product context — not a dump of docs. Keep guardrails short and specific. Update knowledge when architecture actually changes.

VERIFICATION (per features/testing + features/browser-testing docs):
- Do NOT ask Lovable to make a large build change AND run browser tests in the same prompt. Ship the build first; verify in a follow-up prompt.
- Frontend/UI batches → browser workflow tests exercise the exact user flow. Add durable frontend tests only for state/UI invariants worth locking in.
- Backend/edge-function/schema batches → verify by directly calling the affected edge functions or RPCs (success + failure cases) and run/add Deno tests. Include a permission check when RLS/auth changed.
- Human-channel work (Stripe, OAuth apps, DNS, App Store, domains) is a console checklist — no code, no Acceptance checks, no typecheck line.

DESIGN TOKENS:
- Install semantic CSS variables + Tailwind config in the earliest batch. Later batches reference tokens by name; never restate raw HSL values in feature prompts.

SHAPE OF EVERY BATCH:
- Start with: \`Batch N — <one-line name>. Numbered items only, no scope creep.\`
- Body: numbered implementation items (max 8), then for code channels an \`Acceptance checks:\` block with 2–4 checks the founder can verify by clicks alone (no console, no code reading). For lovable batches the checks are user/browser observable; for supabase batches they may be backend-verifiable outcomes.
- Ends EXACTLY with: \`Keep everything else identical.\\nTypecheck when done.\` (code channels only — human channel ends with the last checklist step, no typecheck line, no Acceptance).`;

// Detect the live stack from the repo file tree + a few key files. Returns
// a compact block the model should render inside its prompt so it never
// invents a framework the app isn't using.
export type DetectedStack = {
  id: "tanstack_start" | "react_vite" | "unknown_greenfield";
  label: string;
  evidence: string[];
};

export function detectStackFromRepo(opts: {
  fileTree?: readonly string[];
  packageJson?: string | null;
  hasLiveRepo?: boolean;
}): DetectedStack {
  const tree = opts.fileTree ?? [];
  const pkg = (opts.packageJson ?? "").toLowerCase();
  const evidence: string[] = [];
  const hasRootRoute = tree.some((p) => /(^|\/)src\/routes\/__root\.(t|j)sx?$/i.test(p));
  const hasRoutesDir = tree.some((p) => /(^|\/)src\/routes\//i.test(p));
  const pkgTanstack = /@tanstack\/react-start|@tanstack\/start/i.test(pkg);
  const hasAppTsx = tree.some((p) => /(^|\/)src\/App\.(t|j)sx?$/i.test(p));
  const hasPagesDir = tree.some((p) => /(^|\/)src\/pages\//i.test(p));
  const pkgReactRouter = /"react-router-dom"|"react-router"/.test(pkg);
  const pkgHasVite = /"vite"/.test(pkg);
  if (hasRootRoute) evidence.push("src/routes/__root.tsx present");
  if (hasRoutesDir) evidence.push("src/routes/ directory present");
  if (pkgTanstack) evidence.push("@tanstack/react-start in package.json");
  if (hasAppTsx) evidence.push("src/App.tsx present");
  if (hasPagesDir) evidence.push("src/pages/ directory present");
  if (pkgReactRouter) evidence.push("react-router-dom in package.json");
  if (pkgHasVite) evidence.push("vite in package.json");
  if (!opts.hasLiveRepo || tree.length === 0) {
    return {
      id: "unknown_greenfield",
      label: "Lovable's current default stack (greenfield — do not hard-code a framework)",
      evidence,
    };
  }
  if (hasRootRoute || pkgTanstack) {
    return { id: "tanstack_start", label: "TanStack Start (SSR, file-based routes in src/routes/)", evidence };
  }
  if (hasAppTsx || hasPagesDir || pkgReactRouter) {
    return { id: "react_vite", label: "React + Vite + React Router (client-only)", evidence };
  }
  return {
    id: "unknown_greenfield",
    label: "Live stack could not be detected — treat as Lovable's current default and do NOT assume React+Vite",
    evidence,
  };
}

export function renderStackBlock(stack: DetectedStack): string {
  const ev = stack.evidence.length ? stack.evidence.map((e) => `- ${e}`).join("\n") : "- (none)";
  return `DETECTED STACK: ${stack.label}\nEvidence:\n${ev}\n\nWrite the prompt against THIS stack. Never propose migrating stacks unless the current batch explicitly requires it. Never say "React + Vite is the fixed stack" — that is no longer true for new Lovable projects.`;
}

// The full manual = static doctrine + cohort-learned rules mined from real
// audit findings and batch outcomes, approved by an admin in Settings.
// deno-lint-ignore no-explicit-any
export async function loadFieldManual(admin: any): Promise<string> {
  try {
    const { data } = await admin
      .from("app_settings")
      .select("value")
      .eq("key", "field_manual_addenda")
      .maybeSingle();
    // deno-lint-ignore no-explicit-any
    const items = Array.isArray((data?.value as any)?.items) ? (data!.value as any).items : [];
    if (!items.length) return LOVABLE_FIELD_MANUAL;
    // deno-lint-ignore no-explicit-any
    return `${LOVABLE_FIELD_MANUAL}\nCOHORT-LEARNED RULES (mined from real build outcomes in this workspace):\n${items.map((i: any) => `- ${String(i)}`).join("\n")}`;
  } catch {
    return LOVABLE_FIELD_MANUAL;
  }
}
