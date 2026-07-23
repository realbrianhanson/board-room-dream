# Stocks For Kids — App Blueprint Package

**Product:** Stocks For Kids · **Domain:** stocks.kids
**One-liner:** Kids trade real stocks with fake money — real market data, zero real risk — while a teacher (Courtney) guides every lesson.

This folder is the complete Appreneur Blueprint package, produced before the
first build prompt is sent. Read in order:

| Doc | Stage | Contents |
| --- | --- | --- |
| [01-validation.md](./01-validation.md) | Validate | Portfolio gate + 5-dimension scorecard |
| [02-concept-brief.md](./02-concept-brief.md) | Blueprint | Transformation, users, 3 core jobs |
| [03-prd.md](./03-prd.md) | Blueprint | User types, data model, pages, edge functions, integrations |
| [04-design-system.md](./04-design-system.md) | Blueprint | Tokens, type, palette, signature element |
| [05-build-batches.md](./05-build-batches.md) | Build | 7 numbered Lovable batches, paste-ready |
| [06-hardening-plan.md](./06-hardening-plan.md) | Harden | P0–P2 checklist + kid-safety regression list |

## Non-negotiables (from the kid-safety constitution)

- **Parent/teacher creates every account.** Kids never self-register, never
  enter an email, never enter personal info beyond first name + age band.
- **Walled garden.** Curated ticker universe only (~50 kid-recognizable
  companies). No penny stocks, no crypto, no options, no external links out.
- **Real data, fake money, server-side truth.** Market data is real (delayed
  is fine); trades execute server-side at the server's price. The client is
  never trusted with a price or a balance.
- **Safety beats features, features beat polish.**

## Build target

New Lovable + Supabase project (do NOT build inside BOARDROOM's repo).
Market data via a free-tier provider (Finnhub recommended) with the API key
held server-side and quotes cached in Postgres.

## Legal flags (encode the posture, don't self-certify)

- COPPA posture per the data model in the PRD — qualified legal review
  before any public/commercial launch.
- "Not investment advice — this is a learning game" disclaimer on every
  surface a grown-up sees.
- Market-data licensing: free-tier delayed data is fine for personal/
  educational use; re-check provider terms before charging money.
