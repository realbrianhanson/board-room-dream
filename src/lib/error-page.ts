/**
 * Static fallback rendered when SSR or the router can't hand the browser a
 * live React tree. Uses the same dark App Blueprint palette (background
 * 220 15% 8%, surface 220 13% 11%, brass primary 38 65% 55%) and the same
 * type stack (Fraunces display, Inter body, JetBrains Mono monospace) so
 * a load failure still looks like the same product, not a stock error
 * screen. No new fonts, no new palette — just inlined tokens because this
 * HTML runs before the app's stylesheet loads.
 */
export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>This page didn’t load — App Blueprint</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="description" content="App Blueprint couldn’t render this view. Retry, or return to your dashboard." />
    <style>
      :root {
        color-scheme: dark;
        --background: hsl(220 15% 8%);
        --surface-1: hsl(220 13% 11%);
        --surface-2: hsl(220 12% 14%);
        --foreground: hsl(40 30% 94%);
        --muted-foreground: hsl(40 10% 62%);
        --border: hsl(40 15% 24% / 0.4);
        --primary: hsl(38 65% 55%);
        --primary-fg: hsl(220 15% 8%);
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        background: var(--background);
        color: var(--foreground);
        font: 15px/1.55 "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
        -webkit-font-smoothing: antialiased;
        display: grid;
        place-items: center;
        padding: 1.5rem;
      }
      .frame {
        width: 100%;
        max-width: 32rem;
        background: var(--surface-1);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 2.25rem 2rem 2rem;
      }
      .eyebrow {
        font: 500 10px/1 "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
        text-transform: uppercase;
        letter-spacing: 0.28em;
        color: var(--muted-foreground);
        margin: 0 0 0.9rem;
      }
      h1 {
        font: 600 1.75rem/1.15 "Fraunces", ui-serif, Georgia, serif;
        letter-spacing: -0.02em;
        margin: 0 0 0.6rem;
        color: var(--foreground);
      }
      p { margin: 0 0 1.5rem; color: var(--muted-foreground); }
      .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      a, button {
        display: inline-flex; align-items: center; gap: 0.4rem;
        padding: 0.6rem 1rem;
        border-radius: 8px;
        font: 500 13px/1 "Inter", ui-sans-serif, system-ui, sans-serif;
        text-decoration: none;
        border: 1px solid transparent;
        cursor: pointer;
      }
      .primary { background: var(--primary); color: var(--primary-fg); }
      .primary:hover { filter: brightness(1.08); }
      .secondary {
        background: var(--surface-2);
        color: var(--foreground);
        border-color: var(--border);
      }
      .secondary:hover { border-color: var(--primary); }
    </style>
  </head>
  <body>
    <main class="frame" role="alert" aria-live="polite">
      <p class="eyebrow">App Blueprint · load error</p>
      <h1>This page didn’t load.</h1>
      <p>Something went wrong rendering the view. Retry, or return to the dashboard.</p>
      <div class="actions">
        <button type="button" class="primary" onclick="location.reload()">Try again</button>
        <a class="secondary" href="/dashboard">Back to dashboard</a>
      </div>
    </main>
  </body>
</html>`;
}
