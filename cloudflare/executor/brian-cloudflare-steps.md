# Brian's setup steps — Cloudflare executor for Boardroom

Do these in order, once, after the Batch 17 pull request is merged to `main`. Total time about 20 minutes. You never run a command on your computer except one line to make a password (step 3), and even that has a no-terminal alternative.

You will end up with three things written down:

- `EXECUTOR_URL` — the web address Cloudflare gives your worker (looks like `https://boardroom-executor.YOURNAME.workers.dev`)
- `EXECUTOR_SECRET` — a 64-character password you make up once and paste into two places
- nothing else. Cloudflare never gets your Supabase keys or your OpenRouter key.

---

## Part A — Cloudflare (about 10 minutes)

### 1. Log in and turn on the paid plan

1. Go to https://dash.cloudflare.com and log in.
2. In the left menu click **Workers & Pages**.
3. Click **Plans** (or the "Upgrade" link on that page). Choose **Workers Paid** ($5/month). Confirm.
   The executor needs the paid plan because free workers cannot run the long "Workflows" jobs that wait 5 to 15 minutes for a slow model.

### 2. Connect the GitHub repo and create the worker

1. Still under **Workers & Pages**, click **Create**.
2. Choose **Workers**, then **Import a repository** (sometimes labelled "Connect to Git").
3. If Cloudflare asks to install its GitHub app: click **Connect GitHub**, pick your GitHub account **realbrianhanson**, and allow access to **board-room-dream** only. Come back to Cloudflare.
4. Pick the repository **board-room-dream**.
5. Fill the form exactly like this:
   - **Project name:** `boardroom-executor`
   - **Production branch:** `main`
   - **Root directory:** `cloudflare/executor`   (click "Edit" next to root directory if it is collapsed; type it exactly, no leading slash)
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
6. Click **Save and Deploy** (or **Create and Deploy**).
7. Wait for the first build. It will say **Success** after a minute or two. (If it fails, copy the red text and send it to me; do not change settings.)

### 3. Make the shared password (EXECUTOR_SECRET)

You need a random 64-character string of letters a–f and numbers 0–9.

- On a Mac: open **Terminal**, paste `openssl rand -hex 32`, press Enter, copy the line it prints.
- No terminal: go to any password generator (for example 1Password or https://www.random.org/strings/), ask for **64 characters, digits and lowercase letters only**, generate one.

Paste it into a note and label it `EXECUTOR_SECRET`. You will paste it twice (steps 4 and 8) and then you can keep it in your password manager.

### 4. Give the worker the password

1. Open the worker: **Workers & Pages** → **boardroom-executor**.
2. Click **Settings** → **Variables and Secrets**.
3. Click **Add**.
   - **Type:** Secret
   - **Variable name:** `EXECUTOR_SECRET`
   - **Value:** paste the 64-character string
4. Click **Deploy** (Cloudflare asks you to deploy so the secret takes effect). Wait for it to finish.

You should also see four plain variables already there (EXECUTOR_VERSION, ALLOWED_CALLBACK_HOSTS, MAX_DISPATCH_BYTES, EXECUTOR_MAX_TIMEOUT_MS). They come from the code; leave them alone.

### 5. Copy the worker's address (EXECUTOR_URL)

1. In the same worker, click **Settings** → **Domains & Routes**.
2. You will see a `workers.dev` address like `boardroom-executor.brian-abc123.workers.dev`. Make sure it is **Enabled**.
3. Write it down with `https://` in front and nothing after `.workers.dev`:
   `https://boardroom-executor.brian-abc123.workers.dev` → this is your `EXECUTOR_URL`.

### 6. Quick check

Open a new browser tab and go to your `EXECUTOR_URL` with `/v1/health` on the end, for example:
`https://boardroom-executor.brian-abc123.workers.dev/v1/health`

You should see: `{"ok":true,"version":"batch17"}`. If you see that, Cloudflare is done.

### 7. (Optional, recommended) Only rebuild when the executor code changes

**Settings** → **Builds** → **Build watch paths** → **Include paths**: add these two lines, then Save:
```
cloudflare/executor/*
supabase/functions/_shared/*
```
Without this every merge to `main` redeploys the worker. That is harmless, just noisy.

---

## Part B — Lovable Cloud (about 5 minutes)

### 8. Add the two secrets to the Supabase side

1. Open the **App Blueprint / Boardroom** project in Lovable.
2. Click **Cloud** at the top (the backend area), then **Secrets** (in some versions it is **Settings → Secrets** inside Cloud).
3. Add a secret:
   - **Name:** `EXECUTOR_URL`
   - **Value:** the address from step 5 (starts with `https://`, ends with `.workers.dev`, no trailing slash)
4. Add another secret:
   - **Name:** `EXECUTOR_SECRET`
   - **Value:** the same 64-character string from step 3, exactly. It must match Cloudflare character for character.
5. Add one more (recommended):
   - **Name:** `MAX_STEP_CONCURRENCY`
   - **Value:** `4`
   This lets all four board seats start in the same minute instead of three then one.

If you cannot find the Secrets screen, type this in the Lovable chat: "Add three edge-function secrets: EXECUTOR_URL = …, EXECUTOR_SECRET = …, MAX_STEP_CONCURRENCY = 4" with the real values. Lovable will add them and redeploy the functions.

### 9. Confirm the app sees them

1. Open the Boardroom app, go to **Settings**.
2. Find the new **Cloudflare executor** card (admin only). It should say **Configured**.
   If it says **Off**, one of the two Lovable secrets is missing or misspelled. Names are case-sensitive.

---

## Part C — Test it for cents (about 10 minutes of waiting)

### 10. Run a smoke test through the executor

1. Settings → **Smoke run**.
2. Pick a throwaway project, kind **Plan**.
3. Tick **Route through Cloudflare executor**.
4. Click **Run smoke**. Budget is capped at $1 and it uses the cheap Haiku model.
5. Open that project's **Boardroom** page. Each seat should show a **Deliberating** chip while it works, then **On record**.
6. In Cloudflare: **Workers & Pages** → **boardroom-executor** → **Workflows** tab → **boardroom-seat-call**. You should see one finished job per seat call. This proves the whole loop.
7. Click any one of those jobs. It has two steps, **openrouter** and **callback**. Both should show a green check. If **callback** shows red, or a list of eight failed tries, copy the text and send it to me: the Worker finished the model call but the app refused its answer, and the app is then falling back to a slower once-a-minute check. Runs still finish, just later.
8. Back in the app, Settings → **Cloudflare executor** card: the line **Last settle** should say **callback** with a time a moment ago. If it only ever says **poll**, that is the same problem as item 7 — tell me.

If the run finishes normally but you never see Deliberating and there are no jobs in Cloudflare, the executor was skipped and the run went the old way. The usual cause is a mismatched secret (step 4 vs step 8). Fix it and run the smoke again — nothing gets stuck either way.

### 11. Turn it on for real runs

Settings → **Cloudflare executor** card → switch **Enabled** on. From the next minute, every board seat call goes through Cloudflare and can take as long as the model needs (the Chair is allowed 12 minutes).

Start a real Plan run and watch the Chair step sit in Deliberating past two or three minutes and then finish. That is the moment Batch 17 exists for.

---

## If something goes wrong

**Turn it off (safe, instant):** Settings → Cloudflare executor → switch Enabled off. Anything already in flight still finishes; new work uses the old path.

**Turn it off harder:** in Lovable Cloud, delete the `EXECUTOR_URL` secret. Do this only when no run is mid-step if you can; a step caught mid-flight will retry the old way after its time limit.

**Change the password later:** switch Enabled off, wait until no run is active, then set the new value in Cloudflare (step 4, use **Edit** on the existing secret, then Deploy) and in Lovable Cloud (step 8). Both must match again before you switch Enabled back on.

**Costs:** Workers Paid is $5/month flat. Each seat call is one Workflow job, which is far below the included amount. Model spend still comes from your OpenRouter key exactly as before and shows in the same cost ledger.

**Where to look:** the Cloudflare **Workflows** tab shows every job with a status. The Boardroom step chip shows Deliberating while a job is running. The Settings card shows "In flight: N" for how many steps are currently waiting on Cloudflare, and "Last settle: callback / poll" for how the most recent answer came back (callback is the fast path; poll means the app picked it up on its once-a-minute check instead).
