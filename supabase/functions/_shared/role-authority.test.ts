import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Contract test for the role-authority follow-up migration. The linter
 * / production DB is the ultimate proof; this test protects against
 * regressions where the migration file is renamed, its trigger
 * accidentally dropped, or the has_role hardening is reverted.
 *
 * We assert on the ADDITIVE follow-up migration (the original
 * user_roles/app_role migration is already applied to production and is
 * not editable). The follow-up must ship:
 *   (1) profiles backfill mapping 'student' -> 'user'.
 *   (2) A SECURITY DEFINER trigger function with locked search_path that
 *       REPLACES rather than accumulates roles.
 *   (3) Revocation of INSERT/UPDATE/DELETE on user_roles from
 *       authenticated and anon (no client-writable path).
 *   (4) has_role hardening that scopes authenticated callers to their
 *       own auth.uid() and leaves service_role able to probe any id.
 *   (5) A profiles.role comment calling it a synchronized display mirror.
 */

async function readFollowupMigration(): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  // The follow-up is the newest role-authority migration (contains both
  // sync_user_role_from_profile and has_role together).
  for (const name of [...names].reverse()) {
    const path = new URL(name, dir);
    const sql = await Deno.readTextFile(path);
    if (sql.includes("sync_user_role_from_profile") && sql.includes("has_role")) {
      return sql;
    }
  }
  throw new Error("role-authority follow-up migration not found");
}

Deno.test("role-authority follow-up: backfill maps student -> user", async () => {
  const sql = await readFollowupMigration();
  // Backfill INSERT that maps the display 'student' to the app_role 'user'.
  assertStringIncludes(sql, "insert into public.user_roles");
  assertStringIncludes(sql, "'user'::public.app_role");
  assertStringIncludes(sql, "left join public.user_roles ur on ur.user_id = p.id");
});

Deno.test("role-authority follow-up: sync trigger REPLACES roles, does not accumulate", async () => {
  const sql = await readFollowupMigration();
  assertStringIncludes(sql, "create or replace function public.sync_user_role_from_profile()");
  assertStringIncludes(sql, "security definer");
  assertStringIncludes(sql, "set search_path = public");
  // Replace, don't accumulate: DELETE differing rows before INSERT.
  assertStringIncludes(sql, "delete from public.user_roles");
  assertStringIncludes(sql, "where user_id = new.id and role <> _role");
  // Trigger wiring.
  assertStringIncludes(sql, "create trigger profiles_sync_user_role");
  assertStringIncludes(sql, "after insert or update of role on public.profiles");
  assertStringIncludes(sql, "execute function public.sync_user_role_from_profile()");
});

Deno.test("role-authority follow-up: user_roles has NO client-writable path", async () => {
  const sql = await readFollowupMigration();
  // Explicit revocation on both authenticated and anon.
  assertStringIncludes(sql, "revoke insert, update, delete on public.user_roles from authenticated");
  assertStringIncludes(sql, "revoke insert, update, delete on public.user_roles from anon");
  // Belt-and-braces: no CREATE POLICY grants writes.
  assert(
    !/create\s+policy[^;]+on\s+public\.user_roles\s+for\s+(insert|update|delete|all)/i.test(sql),
    "user_roles must not gain a client-writable RLS policy",
  );
});

Deno.test("role-authority follow-up: has_role scopes authenticated callers to auth.uid()", async () => {
  const sql = await readFollowupMigration();
  assertStringIncludes(sql, "create or replace function public.has_role");
  // Cross-user probes from authenticated clients return false.
  assertStringIncludes(sql, "auth.role() <> 'service_role'");
  assertStringIncludes(sql, "_user_id is distinct from auth.uid()");
  assertStringIncludes(sql, "return false");
  // service_role must still be able to check any id — the check is a
  // "not service_role AND mismatched id" gate, so leaving the check on
  // ensures service_role passes through.
  assertStringIncludes(sql, "grant execute on function public.has_role(uuid, public.app_role) to service_role");
});

Deno.test("role-authority follow-up: profiles.role is documented as a display mirror", async () => {
  const sql = await readFollowupMigration();
  assertStringIncludes(sql, "comment on column public.profiles.role");
  assertStringIncludes(sql, "Synchronized display mirror only");
  assertStringIncludes(sql, "user_roles");
});
