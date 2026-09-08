// Byte-correct base64 decode for GitHub Contents API payloads.
// Regression cover for the "false mojibake findings" incident where atob() +
// binary-string handoff corrupted every multi-byte UTF-8 codepoint.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decodeGithubBase64 } from "./github-payload.ts";

function encodeUtf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

Deno.test("decodeGithubBase64 round-trips ASCII exactly", () => {
  const src = "export const x = 1;\nconsole.log('hi');\n";
  assertEquals(decodeGithubBase64(encodeUtf8Base64(src)), src);
});

Deno.test("decodeGithubBase64 round-trips non-ASCII punctuation exactly (mojibake regression)", () => {
  const src = "Legacy session — Reconvening… Paused · →";
  assertEquals(decodeGithubBase64(encodeUtf8Base64(src)), src);
});

Deno.test("decodeGithubBase64 tolerates the newlines GitHub embeds in its base64", () => {
  const src = "Fraunces · JetBrains Mono → Inter";
  const b64 = encodeUtf8Base64(src);
  // GitHub inserts \n every ~60 chars; also handle whitespace defensively.
  const chunked = b64.match(/.{1,10}/g)!.join("\n");
  assertEquals(decodeGithubBase64(chunked), src);
});

Deno.test("decodeGithubBase64 returns empty string for empty/blank input", () => {
  assertEquals(decodeGithubBase64(""), "");
  assertEquals(decodeGithubBase64("\n  \n"), "");
});

// ============================== RC-6: selection diet ==============================
import { assert, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AUDIT_EXCLUDE,
  COMPARE_FILE_CAP,
  isExcludedPath,
  keyFileScore,
  mapPool,
  MIGRATION_INVENTORY_PATH,
  NoChangesSinceBase,
  planFileSelection,
  renderMigrationInventoryFile,
  type TreeEntry,
} from "./github-payload.ts";

const t = (path: string, size = 1_000): TreeEntry => ({ path, size });

Deno.test("AUDIT_EXCLUDE drops tests, generated files, editor config and prose but keeps source", () => {
  for (
    const p of [
      "src/lib/audit-retry.test.ts",
      "src/foo.spec.tsx",
      "src/__tests__/x.ts",
      "src/routeTree.gen.ts",
      "src/api.gen.ts",
      "src/integrations/supabase/types.ts",
      ".lovable/plan.md",
      "README.md",
      ".prettierrc",
      "eslint.config.js",
      "components.json",
    ]
  ) assert(isExcludedPath(p), `${p} should be excluded`);
  for (
    const p of [
      "src/routes/index.tsx",
      "supabase/functions/boardroom-orchestrator/index.ts",
      "supabase/functions/_shared/openrouter-proxy.ts",
      "src/lib/testing-helpers.ts",
      "package.json",
    ]
  ) assert(!isExcludedPath(p), `${p} should be kept`);
  assert(!isExcludedPath("README.md", null), "null disables the exclusion");
  assertEquals(AUDIT_EXCLUDE.test("src/x.test.ts"), true);
});

Deno.test("keyFileScore ranks edge-function entrypoints and shared server modules with UI components", () => {
  const orchestrator = keyFileScore("supabase/functions/boardroom-orchestrator/index.ts");
  const proxy = keyFileScore("supabase/functions/_shared/openrouter-proxy.ts");
  const component = keyFileScore("src/components/ui/button.tsx");
  const helper = keyFileScore("src/lib/utils.ts");
  const migration = keyFileScore("supabase/migrations/20260101_x.sql");
  assert(orchestrator >= component, `orchestrator ${orchestrator} < component ${component}`);
  assert(proxy > helper, `proxy ${proxy} <= helper ${helper}`);
  assert(orchestrator > migration);
});

const TREE: TreeEntry[] = [
  t("src/routes/index.tsx"),
  t("src/lib/big.ts", 200 * 1024),
  t("src/lib/big.test.ts"),
  t("supabase/functions/audit-runner/index.ts"),
  t("supabase/migrations/20260101_a.sql"),
  t("supabase/migrations/20260102_b.sql"),
  t("assets/logo.png"),
  t("bun.lock"),
  t(".env.production"),
  t("README.md"),
];

Deno.test("planFileSelection: whole tree when there is no base; exclusions, oversize and secrets are skipped, migrations fold", () => {
  const sel = planFileSelection({
    tree: TREE,
    compare: null,
    baseSha: null,
    maxFileBytes: 100 * 1024,
    preferKeyFiles: true,
    exclude: AUDIT_EXCLUDE,
    foldMigrations: true,
  });
  assertEquals(sel.incremental, false);
  assertEquals(sel.changedPaths, []);
  // Key-file order: the route (UI) still leads, the edge-function entrypoint
  // now follows it instead of sinking below every helper.
  assertEquals(sel.toFetch.map((f) => f.path), ["src/routes/index.tsx", "supabase/functions/audit-runner/index.ts"]);
  assertEquals(sel.migrationPaths, ["supabase/migrations/20260101_a.sql", "supabase/migrations/20260102_b.sql"]);
  assertEquals(sel.skippedPaths.sort(), ["README.md", "src/lib/big.test.ts", "src/lib/big.ts"].sort());
  // Binaries, lock files and secret files are dropped silently (as before) and
  // never appear in the tree either.
  assert(!sel.fileTree.includes(".env.production"));
  assert(!sel.fileTree.includes("assets/logo.png"));
  assert(sel.fileTree.includes("README.md"), "the tree still lists prose for orientation");
});

Deno.test("planFileSelection: migrations stay raw when folding is off", () => {
  const sel = planFileSelection({
    tree: TREE,
    compare: null,
    baseSha: null,
    maxFileBytes: 100 * 1024,
    preferKeyFiles: false,
    exclude: AUDIT_EXCLUDE,
    foldMigrations: false,
  });
  assertEquals(sel.migrationPaths, []);
  assert(sel.toFetch.some((f) => f.path === "supabase/migrations/20260101_a.sql"));
});

Deno.test("planFileSelection: a successful compare narrows the read set to changed files and keeps the whole tree", () => {
  const sel = planFileSelection({
    tree: TREE,
    compare: {
      ok: true,
      files: [
        { filename: "src/routes/index.tsx", status: "modified" },
        { filename: "src/lib/big.test.ts", status: "added" },
        { filename: "src/lib/old.ts", status: "removed" },
      ],
    },
    baseSha: "abc1234def",
    maxFileBytes: 100 * 1024,
    preferKeyFiles: true,
    exclude: AUDIT_EXCLUDE,
    foldMigrations: true,
  });
  assertEquals(sel.incremental, true);
  assertEquals(sel.toFetch.map((f) => f.path), ["src/routes/index.tsx"]);
  assertEquals(sel.changedPaths, ["src/routes/index.tsx", "src/lib/big.test.ts"]);
  assertEquals(sel.removedPaths, ["src/lib/old.ts"]);
  assertEquals(sel.migrationPaths, [], "no migration changed, so none are folded");
  assertEquals(sel.fileTree.length, 7);
});

Deno.test("planFileSelection: a changed migration folds EVERY migration at HEAD and marks the inventory as changed", () => {
  const sel = planFileSelection({
    tree: TREE,
    compare: { ok: true, files: [{ filename: "supabase/migrations/20260102_b.sql", status: "added" }] },
    baseSha: "abc1234def",
    maxFileBytes: 100 * 1024,
    preferKeyFiles: true,
    exclude: AUDIT_EXCLUDE,
    foldMigrations: true,
  });
  assertEquals(sel.toFetch, []);
  assertEquals(sel.migrationPaths.length, 2);
  assertEquals(sel.changedPaths, ["supabase/migrations/20260102_b.sql", MIGRATION_INVENTORY_PATH]);
});

Deno.test("planFileSelection: zero non-removed changes is an explicit error, never a silent full read", () => {
  const err = assertThrows(
    () =>
      planFileSelection({
        tree: TREE,
        compare: { ok: true, files: [{ filename: "src/lib/old.ts", status: "removed" }] },
        baseSha: "abc1234def",
        maxFileBytes: 100 * 1024,
        preferKeyFiles: true,
        exclude: AUDIT_EXCLUDE,
        foldMigrations: true,
      }),
    NoChangesSinceBase,
  );
  assert(err.message.includes("abc1234"), err.message);
  assert(err.message.includes("push first"), err.message);
  assertThrows(
    () =>
      planFileSelection({
        tree: TREE,
        compare: { ok: true, files: [] },
        baseSha: "abc1234def",
        maxFileBytes: 100 * 1024,
        preferKeyFiles: true,
        exclude: AUDIT_EXCLUDE,
        foldMigrations: true,
      }),
    NoChangesSinceBase,
  );
});

Deno.test("planFileSelection: changes made only of excluded or oversize files are an explicit error too", () => {
  const err = assertThrows(
    () =>
      planFileSelection({
        tree: TREE,
        compare: {
          ok: true,
          files: [
            { filename: "README.md", status: "modified" },
            { filename: "src/lib/big.test.ts", status: "added" },
            { filename: "src/lib/big.ts", status: "modified" },
          ],
        },
        baseSha: "abc1234def",
        maxFileBytes: 100 * 1024,
        preferKeyFiles: true,
        exclude: AUDIT_EXCLUDE,
        foldMigrations: true,
      }),
    NoChangesSinceBase,
  );
  assert(err.message.includes("auditable"), err.message);
  assert(err.message.includes("README.md"), err.message);
  assert(err.message.includes("full rescan"), err.message);
  // A changed migration alone is auditable: the inventory is re-derived.
  const inv = planFileSelection({
    tree: TREE,
    compare: { ok: true, files: [{ filename: "README.md", status: "modified" }, { filename: "supabase/migrations/20260102_b.sql", status: "modified" }] },
    baseSha: "abc1234def",
    maxFileBytes: 100 * 1024,
    preferKeyFiles: true,
    exclude: AUDIT_EXCLUDE,
    foldMigrations: true,
  });
  assertEquals(inv.toFetch, []);
  assertEquals(inv.migrationPaths.length, 2);
});

Deno.test("planFileSelection: a failed compare or a diff at GitHub's file cap falls back to the whole tree", () => {
  const failed = planFileSelection({
    tree: TREE,
    compare: { ok: false },
    baseSha: "abc1234def",
    maxFileBytes: 100 * 1024,
    preferKeyFiles: false,
    exclude: AUDIT_EXCLUDE,
    foldMigrations: false,
  });
  assertEquals(failed.incremental, false);
  // routes + audit-runner + both raw migrations (folding off); big.ts is
  // oversize, big.test.ts and README.md are excluded.
  assertEquals(failed.toFetch.length, 4);
  const huge = Array.from({ length: COMPARE_FILE_CAP }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified" }));
  const capped = planFileSelection({
    tree: TREE,
    compare: { ok: true, files: huge },
    baseSha: "abc1234def",
    maxFileBytes: 100 * 1024,
    preferKeyFiles: false,
    exclude: AUDIT_EXCLUDE,
    foldMigrations: false,
  });
  assertEquals(capped.incremental, false);
  assertEquals(capped.changedPaths, []);
});

Deno.test("mapPool preserves order and never exceeds its width", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([5, 1, 4, 2, 3, 6, 7, 8, 9, 10], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, n));
    active--;
    return n * 2;
  });
  assertEquals(out, [10, 2, 8, 4, 6, 12, 14, 16, 18, 20]);
  assert(peak <= 3, `peak ${peak}`);
  assertEquals(await mapPool([], 8, async (x: number) => x), []);
});

Deno.test("renderMigrationInventoryFile folds raw SQL into the effective schema", () => {
  const out = renderMigrationInventoryFile([
    { path: "supabase/migrations/20260101_a.sql", sql: "CREATE TABLE public.profiles (id uuid primary key, email text);" },
    { path: "supabase/migrations/20260102_b.sql", sql: "ALTER TABLE public.profiles ADD COLUMN role text;\nCREATE POLICY \"own rows\" ON public.profiles FOR SELECT USING (auth.uid() = id);" },
  ], 2);
  assert(out.startsWith("EFFECTIVE SCHEMA INVENTORY derived from 2 of 2"));
  assert(out.includes("profiles("), out);
  assert(out.includes("role"), out);
  assert(!out.includes("CREATE TABLE"), "raw SQL must not be shipped");
});
