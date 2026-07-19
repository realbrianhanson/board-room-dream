# BOARDROOM — Data Schema

Generated from `information_schema` and `pg_catalog`. All tables in `public`
have Row Level Security **enabled**.

## Tables

### `profiles`
| column | type |
| --- | --- |
| id | uuid (PK, = auth.users.id) |
| role | text (`student` \| `instructor` \| `admin`) |
| cohort_id | uuid (nullable) |
| display_name | text |
| onboarded_at | timestamptz |

RLS: users read/update **own row only**; instructors/admins read profiles in
cohorts they instruct. `role` and `cohort_id` cannot be changed directly by
clients — enforced by `profiles_guard_privileged_fields` trigger. Cohort
joining goes through `join_cohort(code text)` (SECURITY DEFINER RPC).

### `cohorts` (`consensus_threshold` — optional 1-10 override of the workspace consensus bar)
`id`, `name`, `join_code` (unique), `starts_at`, `instructor_id`, `daily_cap_usd`.
RLS: members read own cohort; instructors read/update their cohorts (admins any).

### `api_keys`
`id`, `user_id`, `provider` (`openrouter` \| `github`), `encrypted_key`, `last4`,
`status` (`unverified` \| `valid` \| `invalid`), `created_at`. UNIQUE(user_id, provider).
**RLS enabled with NO client policies** — access only via edge functions using
the service role. Plaintext keys never touch the DB.

### `app_settings`
`key` (PK), `value` (jsonb), `version`, `updated_at`.
Seeded keys: `constitution`, `default_daily_cap_usd`, `consensus_threshold`
(`{score}`), `field_manual_addenda` (`{items[]}` — admin-approved rules
appended to the Lovable field manual in every prompt).
RLS: SELECT authenticated; write admin-only.

### `field_manual_proposals`
`id`, `proposed_rule`, `rationale`, `evidence` (jsonb), `status`
(`pending`|`approved`|`dismissed`), `created_by`, `created_at`, `decided_at`.
Written by `flywheel-miner` (service role); RLS: admin read/update only.

### `model_registry`
`seat` (PK: `chair` \| `strategist` \| `contrarian` \| `inspector`), `model_id`,
`display_name`, `role_prompt`, `enabled`, `use_latest_alias`, `max_cost_per_run`,
`fallback_model_id`, `updated_at`.
RLS: SELECT authenticated; write admin-only.

### `projects`
`id`, `user_id`, `name`, `status`
(`intake`|`validated`|`imported`|`boardroom`|`locked`|`building`|`auditing`|`polishing`|`done`|`killed`),
`lovable_project_url`, `github_repo`, `current_batch_no`, `is_import`, `created_at`.
RLS: owner CRUD; instructor cohort read.

### `intakes`
`id`, `project_id`, `user_id`, `answers` (jsonb), `validation_scores` (jsonb),
`verdict` (`pass`|`kill`|`override`), `created_at`.
RLS: owner CRUD; instructor cohort read.

### `boardroom_runs`
`id`, `project_id`, `user_id`, `kind`
(`test`|`plan`|`design`|`change_request`|`batches`|`audit`|`audit_final`),
`status` (includes `queued`, `running`, `consensus`, `completed`,
`paused_budget`, `failed`), `round_no`, `loop_no`, `constitution_version`,
`budget_usd`, `spent_usd`, `budget_warning`, `consensus` (jsonb),
`dissent_ledger` (jsonb), `founder_notes` (owner's standing note, read at
the next Round-3 synthesis), `error`, timestamps.
RLS: owner read; instructor cohort read. Server-write-only — clients may
update ONLY `founder_notes` (trigger `boardroom_runs_guard`); INSERT/DELETE
revoked. Realtime enabled.

### `run_steps`
`id`, `run_id`, `user_id`, `step_key` (unique per run — powers atomic claim),
`round`, `seat`, `status`, `request` (jsonb), `response_text`,
`response_json` (jsonb, includes `_meta.fallback_model_used`), `tokens_in/out`,
`cost_usd`, `started_at` (claim time — steps stuck `running` 15+ min are
requeued by the cron tick), `error`, timestamps.
RLS: owner read; instructor cohort read. Server-write-only (all client
writes revoked). Realtime enabled.

### `plan_versions`
`id`, `project_id`, `user_id`, `kind` (`plan`|`design`), `version`,
`content_md`, `prd_md`, `features` (jsonb), `decision_log` (jsonb),
`dissent_ledger` (jsonb), `is_chair_ruled`, `source_run_id`, `locked_at`.
Immutable. RLS: owner read; instructor cohort read. Inserts via service role.

### `change_requests`
`id`, `project_id`, `user_id`, `plan_version_id`, `description`, `status`,
`board_verdict` (jsonb), `run_id`, `created_at`.
RLS: owner insert/read; instructor cohort read.

### `batches`
`id`, `project_id`, `user_id`, `plan_version_id`, `batch_no` (numeric — `.1`
suffix denotes fix batch), `title`, `channel` (`lovable`|`supabase`|`human`),
`prompt_md`, `status`
(`pending`|`sent`|`built`|`auditing`|`fix_needed`|`passed`|`skipped`),
`is_fix`, `parent_batch_id`, `sent_at`, `built_at`, `outcome_md`
(owner-reported "what Lovable actually did" — fed into the next audit's
context), `compiled_prompt_md` (JIT compiler output — the batch rewritten
against live code; served by the Runway in place of `prompt_md`),
`compiled_at`, `compile_meta` (jsonb: status, head_sha, files_analyzed,
drift_notes, rationale), `created_at`.
RLS: owner read/update (trigger `batches_guard_content` restricts client
updates to `status`, `sent_at`, `built_at`, and `outcome_md`; the
`compiled_*` columns are service-role-only, written by `batch-compiler`);
instructor cohort read.

### `audits`
`id`, `project_id`, `user_id`, `batch_id`, `kind` (`batch`|`final`|`reaudit`),
`run_id`, `status`, `loop_no`, `source`, `base_sha`, `head_sha`,
`files_analyzed`, `summary` (jsonb), timestamps.
RLS: owner read; instructor cohort read. Writes via service role.

### `audit_findings`
`id`, `audit_id`, `user_id`, `seat`, `severity` (P0|P1|P2|P3), `file_path`,
`title`, `description`, `fix_batch_id`, `status`, `created_at`.
RLS: owner reads own; owner may dismiss only `open` P2/P3
(`audit_findings_guard` trigger); instructor cohort read.

### `cost_ledger`
`id`, `user_id`, `project_id`, `run_id`, `seat`, `model_id`,
`tokens_in`, `tokens_out`, `cost_usd`, `created_at`.
RLS: owner read; instructor cohort read. Writes only from edge functions.

### `alerts`
`id`, `cohort_id`, `user_id`, `project_id`, `kind`
(`stuck_48h`|`audit_loop`|`spend_cap`|`never_locked`), `status`
(`open`|`resolved`|`snoozed`), `detail` (jsonb), `created_at`, `resolved_at`,
`snoozed_until`.
RLS: **no student access**. Instructors/admins read; instructors update
`status`/`resolved_at`/`snoozed_until` only (guard trigger). Realtime enabled.

## Security-definer helpers

- `is_admin(uid uuid) -> bool` — profile role check.
- `instructs_cohort(uid uuid, cohort uuid) -> bool` — cohort instructor check.
- `user_cohort(uid uuid) -> uuid` — resolve a user's cohort.
- `join_cohort(code text) -> uuid` — validated cohort join.
- `handle_new_user()` trigger — auto-creates `profiles` row on signup.
- `touch_updated_at()`, `profiles_guard_privileged_fields`,
  `batches_guard_content`, `audit_findings_guard`, `alerts_guard` — guard triggers.

## Storage buckets

| bucket | public | policies |
| --- | --- | --- |
| `design-screenshots` | no | owner-scoped SELECT/INSERT/DELETE on `{auth.uid}/…` paths (single hyphen-named policy set) |

Reads always via signed URLs (60 min TTL).

## Cron jobs (`pg_cron`)

| job | schedule | purpose |
| --- | --- | --- |
| `boardroom-orchestrator-tick` | `* * * * *` | Heartbeat — resumes stalled runs via atomic step claim. |
| `alert-scan-daily` | `15 5 * * *` UTC | Emits `never_locked` and `stuck_48h` alerts (idempotent). |
| `instructor-digest-daily` | `0 13 * * *` UTC | Sends daily cohort digest via Resend (logs when unset). |

All cron POSTs authenticate to edge functions with the `PIPELINE_SECRET`
shared secret in `x-pipeline-secret`.

## Edge functions

`key-vault`, `validate-intake`, `boardroom-orchestrator`, `audit-runner`,
`github-oauth`, `github-sync`, `alert-scan`, `instructor-digest`, plus
`_shared/openrouter-proxy.ts` (LLM choke point), `_shared/crypto.ts` (AES-GCM),
`_shared/github-payload.ts` (repo sampling).

Every LLM call goes through `openrouter-proxy.callSeat()`. It:
1. Loads the caller's OpenRouter key (AES-GCM decrypted from `api_keys`).
2. Injects the current Constitution + the seat's role prompt.
3. Checks the per-run budget and the UTC-day cap (cohort `daily_cap_usd`
   falling back to `app_settings.default_daily_cap_usd`).
4. On refusal (content filter, empty response, or refusal prose when JSON
   requested) retries once, then re-issues on `fallback_model_id` if set;
   result is tagged in `response_json._meta`.
5. Logs `cost_ledger` for the model actually called and updates `spent_usd`.
