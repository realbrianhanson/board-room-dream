# boardroom-executor

The Cloudflare Worker + Workflow that runs one OpenRouter seat call on behalf
of the `boardroom-orchestrator` edge function (Batch 17). The orchestrator
still claims the step, runs every pre-call check and builds the exact
OpenRouter body; it then `POST /v1/calls` here with the body and an
envelope-sealed user key. `SeatCallWorkflow` streams the completion with a
per-model total timeout and an idle timer, stores the raw OpenRouter JSON as
its output, and POSTs a signed result back to the orchestrator. The
orchestrator's collector also polls `GET /v1/calls/:id` every tick, so a lost
callback never strands a step. This directory never sees a Supabase key.

Routes (all signed except health): `GET /v1/health`, `POST /v1/calls`,
`GET /v1/calls/:id`, `POST /v1/calls/:id/cancel`.

## Deploying (Workers Builds, git integration)

Workers Paid plan (Workflows). Connect the repository in the Cloudflare
dashboard with **root directory** `cloudflare/executor` and **deploy command**
`npx wrangler deploy`. Workers Builds clones the whole repository, installs
from the committed `package-lock.json` in this directory (the repo root uses
bun; this directory uses npm) and deploys `wrangler.jsonc`. The two shared
modules are imported by relative path from
`supabase/functions/_shared/executor-{protocol,auth}.ts` — one source of truth
for the wire protocol and the HMAC / sealing code on both sides.

Local check: `npm ci && npm run typecheck` (the root `vitest run` also runs
`src/*.test.ts`). `src/workers-shim.d.ts` declares the lib.dom `KeyUsage`
alias that `@cloudflare/workers-types` lacks, so the shared `executor-auth.ts`
typechecks under the Workers lib as well as under Deno.

## Configuration

Plain vars (in `wrangler.jsonc`):

| var | meaning |
|---|---|
| `EXECUTOR_VERSION` | reported by `/v1/health` and stamped on every result |
| `ALLOWED_CALLBACK_HOSTS` | comma-separated hostnames a dispatch may name in `callback_url` |
| `MAX_DISPATCH_BYTES` | dispatch bodies above this are refused with 413 |
| `EXECUTOR_MAX_TIMEOUT_MS` | upper clamp for a call's total timeout |

One secret, set in the dashboard only (never in the file): `EXECUTOR_SECRET`.
It is the same value as `EXECUTOR_SECRET` in Lovable Cloud; it signs every
request in both directions and seals the per-call OpenRouter key. Until it is
set the Worker answers 401 to everything but health — harmless.

`EXECUTOR_URL` on the Lovable Cloud side must be the Worker's **origin only**
(`https://boardroom-executor.<account>.workers.dev` or a bare custom domain),
no path prefix: requests are signed over `/v1/calls…` and verified against
the request path, so a prefixed URL fails both routing and the signature and
shows up only as dispatches rejected 401/404 → inline fall-through.

## Rollout

The order of operations (deploy, set the secret, copy the `workers.dev` URL
into Lovable Cloud as `EXECUTOR_URL`, prove the fast path on a smoke run,
then flip `app_settings.executor.enabled`) and the three off switches are in
the Batch 17 build spec, section "Rollout and kill switch", and step by step
in [brian-cloudflare-steps.md](./brian-cloudflare-steps.md).
