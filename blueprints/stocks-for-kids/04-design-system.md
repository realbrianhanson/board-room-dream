# Design System Prompt — Stocks For Kids

Paste-ready as the design foundation for Batch 1. The bar: a kid says
"whoa," a parent says "this looks trustworthy," Courtney says "I get it."
Bright without babyish — the audience is 8–14 and hates being talked down
to; the register is "junior Wall Street," not "toddler bank."

## Signature element — **The Big Board**

Every product gets one distinctive structural move. Ours: the kid's
portfolio renders as a **split-flap departures board** (airport/old stock
exchange style). Dark board surface, rows of flap tiles; when a price
updates or the kid lands on `/home`, tiles flip with a staggered
CSS 3D-flip animation (respects `prefers-reduced-motion`). Cash, total
value, and each holding are board rows; day change shows as ▲ jade / ▼
coral flaps. The Big Board is the home screen, the brand, and the
screenshot that sells the app. Build it as a reusable `<BigBoard rows={…}>`
component — the teacher dashboard reuses a mini version per kid.

## Palette (light-first, tokens as CSS variables)

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#F7F5EF` warm paper | App background |
| `--surface` | `#FFFFFF` | Cards |
| `--board` | `#101B2D` deep navy | Big Board surface, footer |
| `--board-tile` | `#1B2A44` | Flap tiles |
| `--primary` | `#1D6FF2` bright blue | Actions, links, focus |
| `--gain` | `#1FA97C` jade | Up moves, buys confirmed |
| `--loss` | `#E4573D` warm coral | Down moves — **warm, not alarming**; a dip is a lesson, not an emergency |
| `--gold` | `#F5B72E` | Badges, star, join-code |
| `--ink` | `#1A2233` | Text |
| `--ink-soft` | `#5A6478` | Secondary text |

Loss-red is deliberately softened toward coral; never use alarm-red on a
kid surface. All pairings must clear WCAG AA.

## Type

- **Display:** Fraunces (already in stack) — headlines, Big Board labels,
  ticker symbols. Optical size high, a little wonky-friendly.
- **Body/UI:** Inter Variable — everything else.
- **Numbers:** JetBrains Mono — every price, share count, and dollar amount
  app-wide, `tabular-nums`. Money always mono. Non-negotiable.

Scale: 12/14/16/18/22/28/36/48. Kid surfaces never below 14px.

## Spacing, shape, depth

4px base scale (4·8·12·16·24·32·48). Radius: cards 16px, buttons 12px,
flap tiles 6px. Shadows soft and single-direction; the Big Board gets a
subtle inner glow instead of a drop shadow. Buttons are big (min 44px
touch target) — kid thumbs on tablets are the primary input.

## Components & motion

- Ticker cards: emoji as the "logo", symbol in Fraunces, price in mono,
  change chip ▲/▼.
- Trade ticket: renders like a physical ticket stub, perforated edge,
  confirmation tears the stub with a small animation + one confetti burst
  (first trade only — celebration is earned, not ambient).
- Badges: gold-foil circular chips on a shelf.
- Charts (recharts): single line, `--primary` stroke, gradient fill to
  transparent, no gridlines clutter, big friendly tooltip with mono price.
- Motion: flap-flip 300ms staggered 40ms; everything else 150–200ms
  ease-out. `prefers-reduced-motion` collapses all of it to fades.

## Voice on surfaces

Buttons say what happens: "Buy a piece of Disney", "Sell my shares",
"Show me the market." Empty states teach: empty portfolio → "Your board is
empty. Every investor starts here. Find your first company →". Errors are
warm and blame-free. The word "loser/failure" never appears; "dip,"
"down day," and "lesson" do.
