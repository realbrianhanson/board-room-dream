# Build Batches — Stocks For Kids

Seven single-concern batches, sequenced so nothing depends on a blocked
item. Execute through lovable-production mechanics (send, wait, verify;
never re-send a completed batch). Grade each against the PRD, not the
summary Lovable gives back.

**Safety invariants block — include verbatim at the top of EVERY batch:**

> SAFETY INVARIANTS (do not violate, do not "improve"):
> - Kids never self-register and are never asked for personal information.
>   Kid data = first name, age band, avatar, progress. Nothing else.
> - Every kid-data table is parent-scoped or classroom-teacher-scoped by RLS.
> - The market-data API key exists only as an edge-function secret.
> - Trades execute server-side at the server's price; `holdings`, `trades`,
>   and `kids.cash_cents` are never client-writable.
> - Only symbols in the `tickers` table are ever quoted or tradable.
> - No external links, trackers, or analytics on any kid-facing surface.
> - Kid-facing copy: warm, simple, no sarcasm, losses framed as lessons.

---

## Batch 1 — Foundation: design system, auth, family structure

Scope: Tailwind tokens + fonts per `04-design-system.md` (including the
`<BigBoard>` component shell with flap-flip animation, fed with placeholder
rows for now). Public landing page at `/` (promise, how-it-works,
disclaimer footer). Supabase Auth email signup for grown-ups; `profiles`
table + signup trigger + role guard trigger. Tables: `classrooms`, `kids`
with RLS per PRD §2. `/onboarding` (create kid: first name, age band,
avatar from fixed emoji set, set PIN via `kid-pin` edge function; join
classroom by code). `/profiles` picker with PIN pad (verify via `kid-pin`;
5 attempts → 30-min lockout). Keep everything else identical. Typecheck
when done.

Verify by read-back: RLS policies on `profiles`/`classrooms`/`kids`,
`kid-pin` function (bcrypt, no plaintext, lockout), role guard trigger.

## Batch 2 — The market: data pipeline + browse

Scope: `tickers` seeded with ~50 curated kid-recognizable US equities
(symbol, name, one-sentence kid_blurb, emoji, sector) — no penny stocks,
no crypto. `quotes_cache` + `candles_cache` tables. `market-data` edge
function per PRD §3 (JWT required, garden-enforced symbols, 90s cache TTL,
Finnhub via `MARKET_DATA_API_KEY` secret, stale-cache fallback with
`stale: true`). `/market` page (ticker cards, in-garden search) and
`/stock/$symbol` (90-day line chart from candles, kid blurb, day range,
watchlist star backed by `watchlist_items`). Buy/Sell buttons present but
routing to a "coming next" state. Keep everything else identical.
Typecheck when done.

Verify by read-back: `market-data` rejects symbols not in `tickers`; key
never returned; cache upsert path.

## Batch 3 — The trading engine

Scope: `holdings` + `trades` tables (client writes revoked, RLS read per
PRD). `place-trade` edge function + atomic Postgres RPC exactly per PRD §3
(ownership check, server price, validations, avg-cost recompute, badge
awards for `first_trade`/`diversified_3`). `/trade/$symbol` ticket flow:
dollars-or-shares input (fractional to 4dp), live total preview, required
reason step (tag + ≤200-char one-liner), ticket-stub confirmation with
first-trade-only confetti. Wire the real Big Board on `/home`: cash, total
value (holdings × cached prices), day move, one flap row per holding.
Keep everything else identical. Typecheck when done.

Verify by read-back: RPC atomicity, all validations server-side, revoked
client grants on `holdings`/`trades`, `cash_cents` not client-writable.

## Batch 4 — The learning layer

Scope: `badges` seed + `kid_badges` per PRD. `/journal`: trade cards with
price-then vs price-now and the kid's own reason ("Past you said: …"),
badges shelf. `lessons` table + `/lessons` Coach's Corner feed for kids
(published only; markdown rendered with ALL links stripped;
`linked_symbols` render as in-app chips to `/stock/$symbol`). "Coach
mentioned this" chip on stock pages linked from a published lesson.
Keep everything else identical. Typecheck when done.

Verify by read-back: link-stripping in the kid lesson renderer; lessons
RLS (drafts invisible to non-teachers).

## Batch 5 — Teacher & parent dashboards

Scope: `/teach` for the classroom teacher: roster table (kid first name,
avatar, cash, portfolio value, last trade, trade count), drill-in to any
enrolled kid's journal, lesson composer (draft/publish, link symbols),
join-code card, adjust/reset starting cash (RPC, teacher-scoped, writes a
`trades`-style audit note), manual badge award (`awarded_by='teacher'`).
`/family` for parents: own kids' portfolios and journals, PIN reset,
profile edit, and a delete-kid-profile flow that cascade-deletes all their
data after a typed confirmation. Keep everything else identical.
Typecheck when done.

Verify by read-back: teacher RLS reaches only their classroom's kids;
cash-adjust RPC scope; cascade delete completeness.

## Batch 6 — Polish & copy pass

Scope: every empty state per the design system (teach, don't apologize);
loading skeletons; the "prices are napping" stale-data state; error states
warm and blame-free; kid-copy pass over every kid surface at age-band
reading level; `prefers-reduced-motion` honored everywhere; mobile/tablet
layout pass (44px targets); landing page final polish + "not investment
advice — Stocks For Kids is a learning game" in the footer of every
grown-up surface. No schema changes, no new features. Keep everything
else identical. Typecheck when done.

## Batch 7 — Hardening & final QA

Run `06-hardening-plan.md` as the final batch: the P0/P1 sweep, the
kid-safety regression list, and read-backs of every security-critical
file. Nothing ships until P0 and P1 are clean.
