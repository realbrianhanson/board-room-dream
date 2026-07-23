# Hardening Plan — Stocks For Kids

The app is not done — and never demoed to Courtney's class — until P0 and
P1 are clean. Trust read-backs of the actual files, never build summaries.

## P0 — ship-blockers

- [ ] `MARKET_DATA_API_KEY` appears in zero client bundles and zero
      responses; grep the built output, don't assume.
- [ ] RLS enabled on **every** table; every kid-data path parent-scoped or
      classroom-teacher-scoped. Test with two real accounts: Parent A can
      see nothing of Parent B's kid; a teacher sees only their classroom.
- [ ] `holdings`, `trades`, `kids.cash_cents`, `pin_hash`,
      `quotes_cache`, `tickers`: client INSERT/UPDATE/DELETE revoked;
      attempt each from the browser console and confirm the deny.
- [ ] `place-trade`: cannot trade another parent's kid; cannot pass a
      price; cannot buy with insufficient cash or sell unheld shares;
      cannot trade a symbol outside `tickers`; concurrent double-submit
      does not double-spend (atomic RPC).
- [ ] All edge functions reject missing JWT and anon-key-as-auth.
- [ ] Kid profile deletion cascade-deletes holdings, trades, watchlist,
      badges, and PIN — verify row counts before/after.

## P1 — before real students

- [ ] PIN: bcrypt-hashed, never in client storage, lockout after 5 bad
      attempts actually locks (test it), parent reset works.
- [ ] `place-trade` and `kid-pin` rate-limited per user (e.g. 30/min) so a
      script can't spam trades or brute-force PINs.
- [ ] Input validation server-side: shares > 0, ≤ 4dp, reason_text ≤ 200
      chars, age_band from the enum, first_name length-capped and
      HTML-escaped everywhere it renders.
- [ ] Market-data provider outage drill: kill the key, confirm every kid
      surface degrades to the "prices are napping" state — zero crashes.
- [ ] Lesson renderer strips links/scripts/iframes — test with a lesson
      containing markdown links, raw HTML, and an image URL.
- [ ] Join code: unguessable (≥8 chars), rotatable by the teacher.

## P2 — before any public launch

- [ ] COPPA posture review by qualified counsel (encode, don't
      self-certify): parent consent flow, data minimum, deletion.
- [ ] Market-data license terms re-checked for commercial use.
- [ ] "Not investment advice" disclaimer on all grown-up surfaces.
- [ ] Accessibility pass: AA contrast, keyboard nav, reduced motion.
- [ ] Performance: Big Board and /market usable on a cheap tablet.

## Kid-safety regression list (run before ANY release)

No AI surface exists in v1, so the red-team list is structural:

1. A kid profile flow never asks for last name, school, address, email,
   phone, or a photo — walk every screen and confirm.
2. No external link is reachable from any kid surface (lessons included).
3. Kid A's device session cannot see Kid B's data even within the same
   family (PIN gates the profile switch).
4. Copy sweep: no shame words on losses anywhere; run the down-portfolio
   state and read every string.
5. Session-end tone: closing the app or a long session gets warmth, not
   nag mechanics; confirm there are no streaks/FOMO mechanics anywhere.

## Full pre-ship test (mirror of the parent flow end-to-end)

Signup → create kid → set PIN → join Courtney's classroom via code → kid
picks profile → browses market → buys fractional DIS with a reason →
Big Board flips → Courtney sees the trade + reason on /teach → posts a
lesson linking DIS → kid sees it in Coach's Corner with the chip →
parent views journal on /family → parent deletes profile → all data gone.
Run once per age band with copy read aloud at that band's reading level.
