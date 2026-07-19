// The Lovable field manual — hard-won knowledge about how Lovable actually
// executes prompts. Injected into every step that writes or reviews artifacts
// the founder will paste into Lovable (batches, blueprint, audits). Update this
// file as cohort-wide audit findings reveal new failure patterns; every
// improvement here upgrades all future builds at once.

export const LOVABLE_FIELD_MANUAL = `LOVABLE FIELD MANUAL (how to write prompts Lovable executes faithfully)
- Stack is fixed: React + Vite + TypeScript + Tailwind + shadcn/ui, Supabase backend (Postgres, Auth, Storage, Edge Functions). Never reference another stack.
- One concern per batch. Prompts that touch more than ~5 files or mix schema + UI + integration cause drift. Split instead.
- Name everything: exact route paths ("/dashboard"), component names ("BatchCard"), table and column names ("batches.outcome_md"), edge function names. Unnamed things get invented names that drift between batches.
- State access rules for every table in plain words: who can read, insert, update, delete. If unstated, Lovable writes permissive policies.
- Pin what must not change: when collateral edits are a risk, list the files or areas Lovable must not touch.
- Every code batch ends with acceptance checks: 2-5 numbered checks the founder can verify in the preview with clicks only — no console, no code reading.
- Design tokens first: colors, fonts, and spacing installed as CSS variables + Tailwind config in the earliest batch, then referenced (never restated) in later batches.
- Edge functions: state the auth model (user JWT vs shared secret), inputs, outputs, and error shape. Secrets go in Supabase secrets, never in code.
- Empty, loading, and error states are part of every screen's definition — not polish for later.
- Database changes are additive; never rename or drop in the same batch that builds UI on top of the result.`;
