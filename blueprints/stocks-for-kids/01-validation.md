# Stage 0–1: Portfolio Gate + Validation

## Stage 0 — Portfolio gate

**What does this displace, or what launch does it wait behind?**

Nothing has to move for this one, and that's the honest answer, not a dodge:
Stocks For Kids has a live teacher (Courtney) and live students on day one.
It doesn't need a launch to be useful — it needs to exist by the time her
next lesson runs. It is a *use-first* build, not a *sell-first* build, so it
does not queue behind PushTen/A3/event launches. The commercial angle
(family SaaS or PSA) stays parked until the classroom version has real
sessions behind it. **Gate: PASS.**

## Stage 1 — Validation scorecard

| # | Dimension | Score | Evidence |
| --- | --- | --- | --- |
| 1 | Painful problem | 8/10 | Parents consistently say they wish they'd learned investing as kids; Courtney has students waiting for a tool right now. Ten named users exist before line one of code. |
| 2 | Reachable buyer | 8/10 | Homeschool co-ops, parent groups, and the AI4B audience (parents heavy) are all reachable today; "financial literacy for kids" is an evergreen parent hot button. |
| 3 | Monetization path | 6/10 | Primary path: family/classroom SaaS (~$9/mo family, ~$29/mo classroom) *later*. v1 is free for Courtney's class. Secondary: PSA on PushTen ("run your own kids' investing class"). Deliberately deferred, hence the lower score. |
| 4 | Buildable scope | 9/10 | Fits Lovable + Supabase in 7 batches. Real market data via one free-tier API behind one edge function. No AI surface in v1, which removes the hardest kid-safety problem entirely. |
| 5 | Differentiation | 8/10 | Existing paper-trading apps (Investopedia sim, Stock Trainer, etc.) are built for adults — full market, dense UI, ads. Nothing pairs **real data + a curated kid-safe universe + a teacher-led classroom layer**. The teacher layer is the moat: this is a classroom, not a casino. |

**Total: 39/50 — PASS** (threshold 30; no line at 3 or below).

## Buyer & price hypothesis (parked for v2)

- **Buyer:** homeschool parent or micro-school teacher, kids 8–14.
- **Price hypothesis:** $9/mo family (up to 4 kids) · $29/mo classroom (up to 30 kids).
- **v1 customer:** Courtney's class. Free. The job is learning outcomes and
  session evidence, which becomes the marketing later.

## What v1 is NOT (scope kills, decided now)

- No real money, no brokerage links, ever — this is structural, not v2.
- No AI chat/tutor surface in v1 (would require the full Gateway apparatus).
- No crypto, options, shorting, margin, or penny stocks — walled garden.
- No public leaderboard by dollar value (teaches the wrong lesson and shames
  slow learners); recognition happens through badges and teacher shout-outs.
- No kid-to-kid chat or social features of any kind.
