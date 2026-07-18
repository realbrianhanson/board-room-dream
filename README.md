# BOARDROOM

Four frontier LLMs sit as a board of directors and take a non-technical
founder's app idea from raw concept to a locked plan, a batch-by-batch build,
and audited, polished code. Students bring their own OpenRouter key
(encrypted at rest); the board debates in structured rounds — independent
drafts, forced dissent, chair synthesis, scored vote — and either locks a
plan by consensus or the Chair rules with a dissent ledger. From the plan
the board generates numbered Lovable build batches, audits the resulting
code after each batch, and drafts fix batches for anything it finds.
Imported apps skip the plan and get straight to an A-Z audit plus an
improvement plan.

## Architecture

- **Frontend** — TanStack Start, Tailwind v4, dark-first executive design
  system (see project knowledge). Realtime UI on `boardroom_runs`,
  `run_steps`, and `alerts`.
- **Orchestrator** — the `boardroom-orchestrator` edge function claims one
  step at a time with an atomic `UPDATE … RETURNING` on `run_steps.step_key`,
  self-chains via fire-and-forget POST, and is kicked once a minute by
  `pg_cron` so any interrupted run resumes from its last completed step
  without double-charging.
- **LLM choke point** — `supabase/functions/_shared/openrouter-proxy.ts`.
  Every model call — every round, every seat, every audit — goes through
  it. It enforces the model allowlist, the per-run budget, the per-day
  cap, refusal fallback, and cost ledger writes.
- **Protocol** — Round 1 independent drafts (4 seats in parallel), Round 2
  cross-examination (≥3 objections + ≥1 steal per seat, "no objections is
  not an option"), Round 3 Chair synthesis, Round 4 scored vote (consensus
  = every rubric score ≥8 and zero blocking objections). On failure after 3
  loops the Chair rules and a dissent ledger is stored. Locked plans then
  get a Round 5 blueprint (PRD).
- **Design Council** — same protocol, distinct rubric, produces a design
  brief in `plan_versions.kind='design'`. Screenshots live in the private
  `design-screenshots` bucket, owner-scoped, signed URLs only.
- **Batches & Runway** — the `batches` run kind emits 6-14 numbered build
  batches (Lovable / Supabase / Human). Runway UI activates one at a time.
- **Audit engine** — `audit-runner` pulls the batch's code (GitHub or paste,
  300KB cap), runs Inspector/Contrarian/Strategist in parallel, Chair merges
  and issues findings. Findings with P0/P1 insert a fix batch numbered `N.1`;
  P2/P3 can be dismissed by the owner.
- **Import mode** — projects with `is_import=true` skip greenfield gates:
  the A-Z audit is immediately eligible, the Design Council accepts a repo
  or description, and the Boardroom drafts an improvement plan.
- **Instructor's Eye** — `alerts` table + `alert-scan` cron surface stuck
  students (`stuck_48h`, `audit_loop`, `spend_cap`, `never_locked`).
  `/cohort` shows the attention strip and members table with drill-in.

Full table/policy/cron inventory lives in [`DATA_SCHEMA.md`](./DATA_SCHEMA.md).

## Secrets

### Required (already set in this project)

| Secret | Purpose |
| --- | --- |
| `KEY_ENCRYPTION_SECRET` | AES-256-GCM key that wraps every BYOK API key. Rotating it invalidates all stored keys. |
| `PIPELINE_SECRET` | Shared secret pg_cron uses in `x-pipeline-secret` when kicking edge functions. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWKS` | Managed by Lovable Cloud. |
| `LOVABLE_API_KEY` | Reserved for future gateway use; not currently in the proxy path (all LLM traffic is via student BYOK OpenRouter keys). |

### Optional (features degrade gracefully when unset)

Add these in **Project Settings → Secrets**. The UI shows a designed
"needs setup" state everywhere they matter until they're configured.

| Secret | Feature |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth connect from Settings + Runway. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth token exchange (`github-oauth` edge function). |
| `RESEND_API_KEY` | Instructor daily digest email (`instructor-digest`). Without it the digest is composed and logged, never sent. |

## Model registry & refusal fallback

Four seats, editable from **Settings → Admin · Model registry**:

| Seat | Default | Role |
| --- | --- | --- |
| Chair | `anthropic/claude-fable-5` | Synthesizes, rules on consensus, writes the PRD. |
| Strategist | `openai/gpt-5.5` | Argues market/UX/monetization. |
| Contrarian | `x-ai/grok-4.5` | Attacks feasibility, scope, security. |
| Inspector | `moonshotai/kimi-k3` | Coherence, completeness, code audits. |

Every seat has a `fallback_model_id` (default `moonshotai/kimi-k3`). On a
refusal (finish-reason content filter, empty output, or refusal prose when
JSON was requested) the proxy retries once, then re-issues on the fallback
and tags the step's `response_json._meta` with the model that answered.
The Boardroom transcript renders a muted chip on those cards.

## Spend caps

- **Per run**: `boardroom_runs.budget_usd` (defaults sourced from the run
  kind). Enforced in the proxy before every call; overage pauses the run
  and emits a `spend_cap` alert.
- **Per day (UTC)**: `cohorts.daily_cap_usd` if set, otherwise
  `app_settings.default_daily_cap_usd` (seeded at `$25`).
  - Instructors edit their cohort's cap in **Cohort → header** (leave
    blank to inherit the default).
  - Admins edit the workspace default in **Settings → Admin · Default daily cap**.
  - Students see today's usage vs cap and a 30-day daily table in
    **Settings → Spend**.

## Development

```bash
bun install
bun run dev
```

Database changes go through the migration tool (auto-approved by the user).
Edge functions live under `supabase/functions/`; every function requires
the caller's JWT (and rejects the anon key as auth) except the public
webhook endpoints which verify `x-pipeline-secret` or the OAuth callback
signature.

## First-hour checklist (before trusting it with real students)

1. **Auth** — sign up a fresh account, receive the trigger-created profile,
   join a cohort via the join-code onboarding step.
2. **Key vault** — paste an OpenRouter key in Settings → verify → confirm
   status turns jade and only `last4` is exposed to the client.
3. **Intake** — run through the 5-step wizard for a strong idea (pass) and
   a weak one (kill). Confirm the verdict screen shows evidence per dimension.
4. **Boardroom** — convene a plan run and watch all four rounds land in the
   transcript. Verify the consensus ring fills, the brass pulse fires once
   on lock, and `plan_versions` gets a Round-5 PRD.
5. **Design Council** — convene design after the plan locks. Upload a screenshot
   and confirm the bucket URL is signed (no public access).
6. **Batches** — generate batches, "mark built" the first one, confirm the
   next activates.
7. **Audit** — paste small code into the audit runner; verify findings render
   with severity colors and any P0/P1 spawns a fix batch numbered `N.1`.
8. **Change request** — file a CR against the locked plan; verify a new
   `plan_versions` row is written on approval.
9. **Import** — create an "Existing app" project, run the immediate A-Z audit,
   then improvement Boardroom.
10. **Cost meter** — force a small overrun by lowering `budget_usd`; confirm
    the run pauses as `paused_budget` and a `spend_cap` alert lands in
    the cohort dashboard within seconds.
11. **Daily cap** — set a cohort `daily_cap_usd` below current spend and
    confirm the next call refuses with a `spend_cap` alert (`detail.scope='daily'`).
12. **Refusal fallback** — temporarily point a seat at a model that will
    refuse a prompt and confirm the transcript shows the fallback chip and
    both attempts land in `cost_ledger`.
13. **Cron** — check `cron.job_run_details` for the minute-by-minute
    orchestrator tick and the daily alert-scan / instructor-digest rows.
14. **Instructor view** — as an instructor, load `/cohort`, drill into a
    student project, verify the read-only Boardroom renders (no owner
    controls) and open alerts snooze/resolve.
15. **Graceful degradation** — with `GITHUB_CLIENT_ID` unset, confirm the
    Settings GitHub card shows the "needs setup" state instead of crashing;
    same for `RESEND_API_KEY` and the digest.
