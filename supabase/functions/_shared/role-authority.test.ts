import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Contract test for the role-authority migrations. Production repair
 * ships across TWO additive migrations because the first was already
 * applied before we discovered `set search_path = public` is not
 * actually locked unless public CREATE is revoked. The tests therefore
 * check the aggregate of all role-authority migrations for the additive
 * pieces (backfill, comment, revokes, trigger wiring) and check the
 * NEWEST hardening migration for the tight function definitions
 * (search_path = '' with fully qualified public/auth references).
 */

async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const dir = new URL("../../migrations/", import.meta.url);
  const out: { name: string; sql: string }[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".sql")) {
      out.push({ name: entry.name, sql: await Deno.readTextFile(new URL(entry.name, dir)) });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function allRoleAuthoritySql(): Promise<string> {
  const mig = await readMigrations();
  const parts = mig
    .filter((m) => m.sql.includes("sync_user_role_from_profile") || m.sql.includes("has_role"))
    .map((m) => m.sql);
  assert(parts.length > 0, "no role-authority migrations found");
  return parts.join("\n\n");
}

async function newestHardeningSql(): Promise<string> {
  const mig = await readMigrations();
  for (const m of [...mig].reverse()) {
    if (
      m.sql.includes("sync_user_role_from_profile") &&
      m.sql.includes("has_role") &&
      m.sql.includes("set search_path = ''")
    ) {
      return m.sql;
    }
  }
  throw new Error(
    "newest role-authority hardening migration with set search_path = '' not found",
  );
}

Deno.test("role-authority: backfill maps student -> user", async () => {
  const sql = await allRoleAuthoritySql();
  assertStringIncludes(sql, "insert into public.user_roles");
  assertStringIncludes(sql, "'user'::public.app_role");
  assertStringIncludes(sql, "left join public.user_roles ur on ur.user_id = p.id");
});

Deno.test("role-authority: sync trigger REPLACES roles, does not accumulate", async () => {
  const sql = await allRoleAuthoritySql();
  assertStringIncludes(sql, "create or replace function public.sync_user_role_from_profile()");
  assertStringIncludes(sql, "security definer");
  assertStringIncludes(sql, "delete from public.user_roles");
  assertStringIncludes(sql, "where user_id = new.id and role <> _role");
  assertStringIncludes(sql, "create trigger profiles_sync_user_role");
  assertStringIncludes(sql, "after insert or update of role on public.profiles");
  assertStringIncludes(sql, "execute function public.sync_user_role_from_profile()");
});

Deno.test("role-authority: user_roles has NO client-writable path", async () => {
  const sql = await allRoleAuthoritySql();
  assertStringIncludes(sql, "revoke insert, update, delete on public.user_roles from authenticated");
  assertStringIncludes(sql, "revoke insert, update, delete on public.user_roles from anon");
  assert(
    !/create\s+policy[^;]+on\s+public\.user_roles\s+for\s+(insert|update|delete|all)/i.test(sql),
    "user_roles must not gain a client-writable RLS policy",
  );
});

Deno.test("role-authority: profiles.role is documented as a display mirror", async () => {
  const sql = await allRoleAuthoritySql();
  assertStringIncludes(sql, "comment on column public.profiles.role");
  assertStringIncludes(sql, "Synchronized display mirror only");
  assertStringIncludes(sql, "user_roles");
});

/**
 * The following assertions target the NEWEST hardening migration only.
 * That migration is what the running database ends up executing for the
 * two function bodies, so we require it — not the earlier
 * search_path=public version — to define both functions with an empty
 * search_path and fully qualified references.
 */

Deno.test("role-authority hardening: sync_user_role_from_profile uses search_path = '' and qualified refs", async () => {
  const sql = await newestHardeningSql();
  // Find the sync function body specifically.
  const match = sql.match(
    /create or replace function public\.sync_user_role_from_profile\(\)[\s\S]*?\$fn\$;/,
  );
  assert(match, "sync_user_role_from_profile body missing in hardening migration");
  const body = match[0];
  assertStringIncludes(body, "set search_path = ''");
  assertStringIncludes(body, "public.user_roles");
  assertStringIncludes(body, "public.app_role");
  // No unqualified table refs like " user_roles" (must be public.user_roles).
  assert(
    !/\s(?:from|into|update|delete\s+from)\s+user_roles\b/i.test(body),
    "sync function must fully qualify user_roles",
  );
});

Deno.test("role-authority hardening: has_role uses search_path = '' and qualified auth/public refs", async () => {
  const sql = await newestHardeningSql();
  const match = sql.match(
    /create or replace function public\.has_role\(_user_id uuid, _role public\.app_role\)[\s\S]*?\$fn\$;/,
  );
  assert(match, "has_role body missing in hardening migration");
  const body = match[0];
  assertStringIncludes(body, "set search_path = ''");
  // Self-probe restriction plus service_role bypass, using fully
  // qualified auth.role() / auth.uid() so an empty search_path cannot
  // resolve to a shadow function in public.
  assertStringIncludes(body, "auth.role() <> 'service_role'");
  assertStringIncludes(body, "auth.uid()");
  assertStringIncludes(body, "public.user_roles");
  // Preserved grants for signed-in self-probes and server callers.
  assertStringIncludes(sql, "grant execute on function public.has_role(uuid, public.app_role) to authenticated");
  assertStringIncludes(sql, "grant execute on function public.has_role(uuid, public.app_role) to service_role");
});
