# PRD — Stocks For Kids (v1)

This is the contract the build is graded against.

## 1. User types & auth

| Role | Who | How they get in |
| --- | --- | --- |
| `parent` | Account holder | Email signup (Supabase Auth). Creates kid profiles. |
| `teacher` | Courtney | Email signup, role granted at classroom creation. A teacher is also a parent-capable account. |
| kid | The student | **Never signs up.** Netflix-style profile picker under the grown-up's session + 4-digit PIN. All kid data lives as sub-records of the parent account. |

Rules (constitutional, not preferences):

- Kids never self-register, never enter email/last name/address/school/photo.
  Collected about a kid: **first name, age band, avatar choice, progress data.
  Nothing else.**
- Parent creates the kid profile and joins a classroom with the teacher's
  join code. Every kid-data access path is parent-scoped or
  teacher-of-classroom-scoped by RLS.
- Kid session = grown-up auth session + `active_kid_id` selected via PIN.
  All kid writes go through edge functions that verify the kid belongs to
  the authenticated parent.
- All data deletable on parent request (cascade delete from kid profile).

## 2. Data model

All tables in `public`, RLS enabled on every one.

### `profiles`
`id uuid PK = auth.users.id`, `role` (`parent`|`teacher`), `display_name`,
`created_at`. Auto-created by signup trigger. RLS: own row read/update;
role not client-editable (guard trigger).

### `classrooms`
`id`, `teacher_id → profiles`, `name`, `join_code` (unique, generated),
`starting_cash_cents` (default 1_000_000 = $10,000), `created_at`.
RLS: teacher CRUD own; members (parents of enrolled kids) read.

### `kids`
`id`, `parent_id → profiles`, `classroom_id → classrooms` (nullable),
`first_name`, `age_band` (`8-9`|`10-11`|`12-14`), `avatar` (emoji from a
fixed set), `pin_hash`, `cash_cents`, `created_at`.
RLS: parent CRUD own kids; classroom teacher read. `cash_cents` and
`pin_hash` never client-writable (server/RPC only).

### `tickers` (the walled garden — seeded, curated)
`symbol PK`, `name`, `kid_blurb` (one kid-readable sentence about what the
company does), `emoji`, `sector`, `is_active`.
~50 rows: DIS, AAPL, NKE, MCD, RBLX, NTDOY, KO, SBUX, TGT, F, LEGO-adjacent
etc. RLS: authenticated read; write service-role only.

### `quotes_cache`
`symbol PK → tickers`, `price_cents`, `change_pct`, `day_high_cents`,
`day_low_cents`, `as_of`, `fetched_at`.
Written only by the `market-data` edge function. RLS: authenticated read.

### `candles_cache`
`symbol`, `day date`, `close_cents` — PK(symbol, day). 90 days per symbol
for charts. Service-role write, authenticated read.

### `holdings`
`id`, `kid_id → kids`, `symbol → tickers`, `shares numeric(12,4)`
(fractional), `avg_cost_cents`, UNIQUE(kid_id, symbol).
RLS: parent read (own kids), teacher read (classroom). **Client write
revoked** — only `place-trade` writes.

### `trades`
`id`, `kid_id`, `symbol`, `side` (`buy`|`sell`), `shares numeric(12,4)`,
`price_cents` (server's execution price), `total_cents`, `reason_tag`
(`coach_tip`|`i_like_this_company`|`price_went_down`|`long_term`|`other`),
`reason_text` (kid's one-liner, ≤200 chars), `created_at`.
RLS: parent/teacher read as above. Client write revoked — `place-trade` only.

### `watchlist_items`
`id`, `kid_id`, `symbol`, UNIQUE(kid_id, symbol). RLS: parent-scoped CRUD
via active kid, teacher read.

### `lessons` (Coach's Corner)
`id`, `classroom_id`, `teacher_id`, `title`, `body_md`, `linked_symbols
text[]`, `published_at` (null = draft), `created_at`.
RLS: teacher CRUD own classroom's; enrolled parents read published only.
Kid-facing rendering strips all links (walled garden: no external links on
kid surfaces, ever).

### `badges` + `kid_badges`
`badges`: `key PK`, `title`, `kid_blurb`, `emoji` (seeded: `first_trade`,
`diversified_3`, `held_through_dip`, `great_reason`, `patient_investor`,
`did_the_reading`). `kid_badges`: `kid_id`, `badge_key`, `awarded_at`,
`awarded_by` (`system`|`teacher`). RLS: read parent/teacher-scoped; write
via edge functions + teacher award RPC.

## 3. Edge functions

All require the caller's JWT; anon-key-as-auth rejected. Secrets:
`MARKET_DATA_API_KEY` (Finnhub free tier).

### `market-data`
`GET quotes?symbols=…` / `GET candles?symbol=…`
1. Validates symbols against `tickers` (walled garden enforced server-side).
2. Serves from `quotes_cache` when `fetched_at` < 90s old (market hours) or
   since last close (after hours); otherwise refreshes from provider with
   the server-held key, upserts cache, returns.
3. Client never sees the provider or the key. Provider outage → serve stale
   cache with `stale: true`; UI shows a friendly "prices are napping" state.

### `place-trade`
`POST { kid_id, symbol, side, shares | spend_cents, reason_tag, reason_text }`
1. Verifies `kid_id` belongs to `auth.uid()` (or caller is the classroom
   teacher in demo mode — v1: parents only).
2. Re-fetches the server-side price (never trusts a client price).
3. Validates: symbol active, shares > 0, buy ≤ cash, sell ≤ held shares,
   min trade $1, max single trade = current cash (no margin, structurally).
4. Executes atomically in one Postgres RPC: update `kids.cash_cents`,
   upsert `holdings` (recompute `avg_cost_cents`), insert `trades`.
5. Awards system badges when earned (first_trade, diversified_3).
6. Returns the fill: price, total, new cash — the UI renders the ticket.

### `kid-pin`
`POST set` (parent sets/resets PIN, bcrypt-hashed) · `POST verify`
(returns short-lived signed approval the client stores in memory for the
session). PINs never stored or compared client-side. 5 bad attempts →
30-min lockout per kid.

## 4. Pages

| Route | Audience | What's on it |
| --- | --- | --- |
| `/` | Public | Landing for stocks.kids: the promise, how it works (Real Market → Fake Money → Real Teacher), parent CTA, "not investment advice" footer. |
| `/onboarding` | Parent | Signup → create kid profile (first name, age band, avatar, PIN) → enter classroom join code. |
| `/profiles` | Family | Profile picker: kid avatars + grown-up tile. Kid taps avatar → PIN pad → kid mode. |
| `/home` | Kid | **The Big Board** (signature element): portfolio as a split-flap departures board — cash, total value, today's move, each holding one flap row. Coach's latest lesson card. |
| `/market` | Kid | The curated market: ticker cards (emoji, name, kid blurb, price, day change as ▲/▼). Search within the garden only. |
| `/stock/$symbol` | Kid | 90-day line chart (recharts), kid blurb, price, day range, Buy/Sell buttons, watchlist star, "Coach mentioned this" chip when linked from a lesson. |
| `/trade/$symbol` | Kid | The trade ticket: buy in dollars OR shares (fractional), live total preview, **required reason step** (tag + one-liner), confirm → animated ticket stub confirmation. |
| `/journal` | Kid | Every trade as a card: what, when, price then vs now, and the kid's own reason — "past you says…". Badges shelf. |
| `/lessons` | Kid | Coach's Corner feed (published lessons, links stripped, linked tickers rendered as in-app chips). |
| `/teach` | Teacher | Classroom dashboard: roster with cash/value/last-trade/trade-count per kid, click-in to any kid's journal, lesson composer, join-code display, adjust/reset cash, award badges. Courtney test applies. |
| `/family` | Parent | Parent view of their own kids: portfolios, journals, PIN reset, profile management, delete-everything button. |

## 5. Integrations

| Integration | Purpose | Failure mode |
| --- | --- | --- |
| Finnhub (free tier) | Delayed quotes + daily candles, US equities | Serve stale cache; never crash a kid surface. |
| Supabase Auth | Grown-up accounts only | — |
| pg_cron (optional, v1.1) | Pre-warm quotes cache every 5 min during market hours | Lazy refresh already covers it. |

No analytics SDKs or third-party trackers on kid surfaces. No email to kids.

## 6. Kid-facing copy rules (bind every batch)

Warm, simple, second person, short sentences, zero sarcasm/irony, reading
level ≤ the age band. Money words defined on first use ("A share is a tiny
piece of a company"). Losses are lessons, never failures: "DIS is down
today. Investors call this a dip. What do you think Disney's worth next
year?" Session tone ends warm, never nags.

## 7. Explicitly out of scope for v1

AI tutor/chat (needs full Gateway apparatus — v2 at earliest), real-money
anything (never), crypto/options/shorting (never), kid-to-kid social
(never), public dollar leaderboards (never), per-kid standalone logins
(v1.1: magic-code kid sessions), push/email notifications, native apps.
