import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  batchTouchesSchema,
  normalizeIdent,
  parseMigrationsToInventory,
  renderTargetInventory,
  toCollisionSet,
} from "./target-schema-inventory.ts";

Deno.test("normalizeIdent strips quoting and public prefix", () => {
  assertEquals(normalizeIdent(`"MyTable"`), "mytable");
  assertEquals(normalizeIdent("public.Alerts"), "alerts");
  assertEquals(normalizeIdent("`foo`"), "foo");
});

Deno.test("parses CREATE TABLE variants including quoted / schema-prefixed / IF NOT EXISTS", () => {
  const files = [
    { path: "supabase/migrations/1_a.sql", sql: `CREATE TABLE public.profiles (id uuid PRIMARY KEY);` },
    { path: "supabase/migrations/2_b.sql", sql: `CREATE TABLE IF NOT EXISTS "Orders" (id uuid);` },
    { path: "supabase/migrations/3_c.sql", sql: "CREATE TABLE `things` (id uuid);" },
  ];
  const inv = parseMigrationsToInventory(files);
  assert(inv.tables.has("profiles"));
  assert(inv.tables.has("orders"));
  assert(inv.tables.has("things"));
});

Deno.test("platform-only tables never appear in an unrelated target inventory", () => {
  // Target repo's migrations, with no App Blueprint platform table.
  const files = [
    {
      path: "supabase/migrations/20260101_users.sql",
      sql: `CREATE TABLE public.users (id uuid); CREATE TABLE public.posts (id uuid);`,
    },
  ];
  const inv = parseMigrationsToInventory(files);
  assertFalse(inv.tables.has("batches"));
  assertFalse(inv.tables.has("audit_findings"));
  assertFalse(inv.tables.has("boardroom_runs"));
  assertFalse(inv.tables.has("cost_ledger"));
  assert(inv.tables.has("users"));
  assert(inv.tables.has("posts"));
});

Deno.test("later ALTER TABLE ADD COLUMN and CREATE TABLE IF NOT EXISTS are reflected in effective inventory", () => {
  const files = [
    {
      path: "supabase/migrations/20260101_a.sql",
      sql: `CREATE TABLE public.plan_versions (id uuid PRIMARY KEY, version int);`,
    },
    {
      path: "supabase/migrations/20260201_b.sql",
      sql: `ALTER TABLE public.plan_versions ADD COLUMN is_build_safe boolean NOT NULL DEFAULT true;`,
    },
    {
      path: "supabase/migrations/20260301_c.sql",
      sql: `CREATE TABLE IF NOT EXISTS public.cohorts (id uuid);`,
    },
  ];
  const inv = parseMigrationsToInventory(files);
  assert(inv.tables.has("plan_versions"));
  assert(inv.tables.has("cohorts"));
  const cols = inv.columns.get("plan_versions")!;
  assert(cols.has("is_build_safe"));
});

Deno.test("later DROP TABLE removes an earlier CREATE from effective inventory", () => {
  const files = [
    { path: "supabase/migrations/20260101_a.sql", sql: `CREATE TABLE public.legacy_tbl (id uuid);` },
    { path: "supabase/migrations/20260202_b.sql", sql: `DROP TABLE IF EXISTS public.legacy_tbl;` },
  ];
  const inv = parseMigrationsToInventory(files);
  assertFalse(inv.tables.has("legacy_tbl"));
});

Deno.test("ALTER TABLE ... RENAME TO moves the table entry", () => {
  const files = [
    { path: "supabase/migrations/20260101_a.sql", sql: `CREATE TABLE public.old_name (id uuid); ALTER TABLE public.old_name ADD COLUMN foo text;` },
    { path: "supabase/migrations/20260202_b.sql", sql: `ALTER TABLE public.old_name RENAME TO new_name;` },
  ];
  const inv = parseMigrationsToInventory(files);
  assertFalse(inv.tables.has("old_name"));
  assert(inv.tables.has("new_name"));
  assert(inv.columns.get("new_name")?.has("foo"));
});

Deno.test("CREATE FUNCTION / POLICY / INDEX / VIEW captured; DROPs remove them", () => {
  const files = [
    {
      path: "supabase/migrations/1.sql",
      sql: `CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _r text) RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql;
            CREATE POLICY "users_read_self" ON public.profiles FOR SELECT USING (true);
            CREATE INDEX idx_profiles_email ON public.profiles(email);
            CREATE OR REPLACE VIEW public.active_users AS SELECT * FROM users;`,
    },
    {
      path: "supabase/migrations/2.sql",
      sql: `DROP INDEX IF EXISTS idx_profiles_email; DROP VIEW public.active_users;`,
    },
  ];
  const inv = parseMigrationsToInventory(files);
  assert(inv.functions.has("has_role"));
  assert(inv.policies.has("users_read_self"));
  assertFalse(inv.indexes.has("idx_profiles_email"));
  assertFalse(inv.views.has("active_users"));
});

Deno.test("toCollisionSet merges tables/functions/policies/indexes/views", () => {
  const files = [
    { path: "1.sql", sql: `CREATE TABLE t (id uuid); CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;` },
  ];
  const set = toCollisionSet(parseMigrationsToInventory(files));
  assert(set.has("t"));
  assert(set.has("f"));
});

Deno.test("renderTargetInventory produces stable compact text", () => {
  const inv = parseMigrationsToInventory([
    { path: "1.sql", sql: `CREATE TABLE t (id uuid); ALTER TABLE t ADD COLUMN name text;` },
  ]);
  const txt = renderTargetInventory(inv);
  assert(txt.includes("TABLES (1)"));
  assert(txt.includes("- t(id, name)") || txt.includes("- t(name)"));
});

Deno.test("batchTouchesSchema flags supabase channel or DDL text", () => {
  assert(batchTouchesSchema({ channel: "supabase", compiledOrRoadmap: "" }));
  assert(batchTouchesSchema({ channel: "lovable", compiledOrRoadmap: "Add CREATE TABLE public.notes ..." }));
  assert(batchTouchesSchema({ channel: "lovable", compiledOrRoadmap: "Create migration under supabase/migrations/" }));
  assertFalse(batchTouchesSchema({ channel: "lovable", compiledOrRoadmap: "Add a button to the header." }));
});
