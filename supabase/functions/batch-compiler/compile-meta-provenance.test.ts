// SUPPORTED-FINDINGS-R3 static regression: the successful compile-meta
// construction path must reference the actually-defined
// targetMigrationsMeta variable — not the stale/undefined
// targetMigrationsProvenance identifier that appeared in an earlier
// revision and silently threw at runtime.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("batch-compiler no longer references the undefined targetMigrationsProvenance", () => {
  assertEquals(
    SRC.match(/targetMigrationsProvenance/g),
    null,
    "targetMigrationsProvenance is a stale/undefined identifier — use targetMigrationsMeta instead.",
  );
});

Deno.test("target_repo_migrations in compile_meta reads from targetMigrationsMeta", () => {
  // The success path builds compile_meta with target_repo_migrations set to
  // the constructed provenance/meta object.
  assert(
    /target_repo_migrations:\s*targetMigrationsMeta/.test(SRC),
    "compile_meta.target_repo_migrations must be assigned from targetMigrationsMeta",
  );
});
