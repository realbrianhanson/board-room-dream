
# Hardening Pass — Plan

Scope is large; grouping into six independent workstreams executed in order so tests stay green between them.

## 1. Target-repo schema authority in batch-compiler

- New pure module `supabase/functions/_shared/target-schema-inventory.ts`:
  - `parseMigrationsToInventory(files: {path, sql}[]): { tables: Set<string>, functions: Set<string>, policies: Set<string>, indexes: Set<string>, views: Set<string> }` — parses `CREATE TABLE|FUNCTION|POLICY|INDEX|VIEW` (incl. `OR REPLACE`, `IF NOT EXISTS`, quoted/schema-prefixed names) and `DROP ...` and `ALTER TABLE ... RENAME TO` to keep the effective ledger.
  - `toCollisionSet(inventory)` — merges names for `findExistingCreateCollision`.
- `batch-compiler/index.ts`:
  - Only when `source === "github"`: fetch all `supabase/migrations/*.sql` files via the existing GitHub helper. Hard caps: max 400 files, 1.5 MiB total, 256 KiB per file. On any cap breach → fail closed with an actionable message (`SCHEMA_LEDGER_TOO_LARGE`).
  - Detect whether the batch is a "schema-touching" batch by `channel === 'supabase'` OR compiled markdown/roadmap mentions `CREATE TABLE|ALTER TABLE|CREATE POLICY|CREATE FUNCTION` on Supabase paths. If schema-touching and ledger is empty/missing → block with `SCHEMA_LEDGER_MISSING` and precise retry action ("Link the target repo's supabase/migrations before compiling this Supabase batch.").
  - UI-only (lovable) batches may proceed with an empty target inventory but must not receive DB claim assertions; pass `schemaObjects: undefined`.
  - Remove `get_compiler_schema_inventory` RPC call for target inventory (keep only if used for platform diagnostic elsewhere — audit and delete).
  - Record `compile_meta.target_repo_migrations = { files: [{path, bytes}], total_bytes, source_commit }` and inject a short "TARGET SCHEMA (from repo migrations)" section into the model prompt.
- Tests (`_shared/target-schema-inventory.test.ts`):
  - Platform-only names (`batches`, `audit_findings`, `boardroom_runs`) never appear in a parsed target inventory built from a fixture of target-repo migrations that don't define them.
  - Later migration `ALTER TABLE plan_versions ADD COLUMN is_build_safe` and `CREATE TABLE ... IF NOT EXISTS` are included; `DROP TABLE` removes them.
  - Quoted/schema-prefixed idents normalize the same as `normalizeSqlIdent`.
- Compiler tests: schema-touching Supabase batch with empty ledger → blocked; UI-only lovable batch with empty ledger → allowed but no DB collision fired.

## 2. Server-side state-integrity guards

- Audit current writers first (batch-compiler, boardroom-orchestrator, dashboard imports, intake wizard, audit-runner) for any authenticated-role UPDATE to:
  - `intakes.verdict`, `intakes.validation_scores`
  - `projects.status`, `projects.current_batch_no`
- Migration `2026072900000_state_integrity_guards.sql`:
  - Trigger `intakes_guard_verdict_scores` (SECURITY DEFINER): on UPDATE, if `auth.role() <> 'service_role'` and `NEW.verdict IS DISTINCT FROM OLD.verdict` OR `NEW.validation_scores IS DISTINCT FROM OLD.validation_scores` → RAISE.
  - Trigger `projects_guard_status_batchno` (SECURITY DEFINER): same shape for `status` and `current_batch_no`. Explicit whitelist for owner-initiated legitimate transitions is routed through a new SECURITY DEFINER RPC `project_owner_transition(project_id, new_status)` limited to `draft→archived` and similar owner-safe transitions we actually need — determined by call-site audit.
- Any browser-initiated legitimate change found in step 1 gets moved behind a `createServerFn` (RLS-scoped) that itself calls the RPC or performs the update via `supabaseAdmin` after re-verifying ownership.
- SQL regression tests under `supabase/tests/state_integrity_guards.sql`:
  - Owner UPDATE of allowed fields succeeds.
  - Owner UPDATE forging `verdict='pass'` / `status='validated'` / `current_batch_no=5` fails.
  - Service-role UPDATE succeeds for orchestrated transitions.

## 3. UX correctness

- `src/routes/reset-password.tsx`: bounded 8 s timeout — if `ready` still false, render an "invalid or expired reset link" panel with Retry (re-run supabase.auth.getSession) and Sign-in link.
- `src/components/github-repo-card.tsx`: return `{ status: 'error' }` distinct from loading; render explicit error card with Retry button that invalidates the query. Preserve current loading/connected/disconnected paths.
- `src/components/spend-panel.tsx`: if `user === null` after auth resolves → auth-required state (not spinner). If query errors → error state with retry, never fall through to `spent = 0` display.
- `src/routes/_authenticated/plan.$projectId.tsx`: use `selectCurrentPlanVersion` — when displayed version's `id !== currentVersion.id`, hide the change-request form and show a "This is a historical plan version. Go to current plan." button (navigates to current). Keep owner-authority markers explicit in the form on current version.

## 4. Deterministic audit truthfulness

- `_shared/audit-findings.ts` — expand `evaluateChairMergeCandidate` / add deterministic downgrade rules with unit tests:
  - Rule A (P0 IMPACT class): P0 requires an `IMPACT: <build_failure|data_loss|auth_bypass|secret_exposure>` marker in the evidence. Missing/invalid → downgrade to P1 with reason.
  - Rule B (migration path corroboration): if `file_path` starts with `supabase/migrations/` and severity is P0/P1, require a `CURRENT: "<quoted current definition>"` marker; else downgrade to P2.
  - Rule C (nonexistence claims): claim text matches `/does not exist|is missing|not defined/i` referring to a table/column/function → require `SCHEMA_LEDGER:` or `RUNTIME_FAILURE:` marker; else downgrade to P2.
  - Rule D (universality claims): claim text matches `/applies universally|every|all callers/i` → require `CALLER: "<file>:<line>"` marker citing a reachable current call; else downgrade to P2.
- Prompt updates in `audit-runner` map/merge/correction: teach the four markers with tight examples. Increase per-finding evidence cap from current N to allow +200 chars for markers; keep 12-finding + 9k serialized caps and the single bounded correction pass unchanged.
- Fixture regression test `audit-truthfulness-regressions.test.ts` covering:
  - "Round 2 steals schema is truncated" (needs CURRENT from later migration) → downgraded.
  - "Human batches bypass skeletonError" (universality) without CALLER marker → downgraded (real code path shows `isCodeChannel` gating).
  - "plan_versions.is_build_safe missing" (nonexistence) without SCHEMA_LEDGER → downgraded.
  - "join_cohort ignores boardroom.allow_cohort_change" (universality) without CALLER → downgraded.
- Keep `supersedeOlderFinalAudits` unchanged; add one test that supersession still fires after new downgrades.

## 5. App Blueprint product-name layer

- Landing `src/routes/index.tsx` (`head()` + copy), `src/routes/auth.tsx` copy, and the persistent authenticated header product mark: rename displayed brand to "App Blueprint" with subline "The Boardroom challenges your idea against real code to produce an evidence-backed Blueprint and safer Lovable prompts."
- `__root.tsx` default `head()` title / description / og updated: title `App Blueprint — Evidence-backed blueprints for Lovable`, description ≤160 chars, og:type=website, twitter:card=summary_large_image. No absolute superlatives.
- Do NOT change: route names, edge function names, DB columns, `boardroom_*` tables, "Boardroom" as council/method wording inside the app.
- Keep existing design tokens; no palette/font changes.

## 6. batch-compiler system-copy fix

- Replace any user/system prompt text saying `channel is "code"` with explicit language: `channel is one of: "lovable" (frontend/UI code), "supabase" (backend/DB code), or "human" (console checklist)`. Update tests that assert on this string.

## Verification (final)

Run in one pass and report exact counts:

```text
deno test --allow-env --allow-read --allow-net supabase/functions
bunx vitest run
tsgo --noEmit
bun run build
```

Do NOT create a fix batch from the current audit. Do NOT start a paid audit or LLM run.

## Out of scope (unchanged)

- Model routing, budgets, chunk sizes, plan protocol, storage policies.
- Any theme/palette/font redesign.
- Rename of routes/tables/edge functions.

## Assumptions to confirm

1. GitHub file-fetch helper already handles auth for the target repo (it does for github-sync). If not, this pass will not add a new integration surface; it will fail closed with `SCHEMA_LEDGER_MISSING` and surface a clear action instead.
2. The set of legitimate owner-driven `projects.status`/`current_batch_no` transitions from the browser (found during step 1 audit) will be moved into an RPC — I will list them in the migration description before writing code.

Reply "go" to approve or edit any section.
