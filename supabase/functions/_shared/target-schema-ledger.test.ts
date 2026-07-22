// TARGET-SCHEMA-LEDGER-R2 pure tests.
//
// Covers:
//  - CREATE TABLE column parsing (uuid PK, text default with comma,
//    numeric(10,2), quoted, table-level constraints skipped, FK skipped).
//  - Lexicographic ordering forced even when caller passes out of order.
//  - Pure finalizer: tree failure / zero paths / one failed content fetch /
//    UTF-8 byte accounting / ordered provenance.
//  - Compiler policy helper: schema-touching + empty ledger blocks;
//    UI-only batch proceeds with no schema authority.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideLedgerAuthority,
  finalizeMigrationLedger,
  MIGRATION_MAX_FILE_BYTES,
  parseMigrationsToInventory,
  renderTargetInventory,
  utf8Bytes,
} from "./target-schema-inventory.ts";

// ============================== Column parsing =============================

Deno.test("CREATE TABLE column parser: real columns only", () => {
  const sql = `
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "Customer Name" text NOT NULL DEFAULT 'unknown, guest',
      total numeric(10, 2) NOT NULL,
      user_id uuid NOT NULL REFERENCES public.users(id),
      notes text DEFAULT '',
      CONSTRAINT orders_total_positive CHECK (total >= 0),
      PRIMARY KEY (id),
      FOREIGN KEY (user_id) REFERENCES public.users(id),
      UNIQUE (id, user_id),
      CHECK (total < 1000000)
    );
  `;
  const inv = parseMigrationsToInventory([{ path: "1.sql", sql }]);
  const cols = inv.columns.get("orders")!;
  assert(cols, "orders columns present");
  assertEquals(
    [...cols].sort(),
    ["customer name", "id", "notes", "total", "user_id"].sort(),
  );
  // Constraint keywords MUST NOT leak in as columns.
  for (const bad of ["constraint", "primary", "foreign", "unique", "check"]) {
    assertFalse(cols.has(bad), `column set must not contain '${bad}'`);
  }
});

Deno.test("column parser respects nested parens and quoted strings with commas", () => {
  const sql = `
    CREATE TABLE t (
      id uuid,
      price numeric(10,2) DEFAULT 0,
      label text DEFAULT 'a, b, c'
    );
  `;
  const cols = parseMigrationsToInventory([{ path: "1.sql", sql }]).columns.get("t")!;
  assertEquals([...cols].sort(), ["id", "label", "price"]);
});

// ============================== Ordering ==================================

Deno.test("parseMigrationsToInventory sorts input lexicographically even when caller passes out of order", () => {
  const early = { path: "supabase/migrations/20260101_create.sql", sql: `CREATE TABLE t (id uuid);` };
  const later = { path: "supabase/migrations/20260202_add.sql", sql: `ALTER TABLE t ADD COLUMN name text;` };
  const invOrdered = parseMigrationsToInventory([early, later]);
  const invReversed = parseMigrationsToInventory([later, early]);
  assertEquals([...invOrdered.columns.get("t")!].sort(), ["id", "name"]);
  assertEquals([...invReversed.columns.get("t")!].sort(), ["id", "name"]);
});

Deno.test("later ALTER TABLE / DROP / RENAME still reflected in effective inventory", () => {
  const files = [
    { path: "1.sql", sql: `CREATE TABLE a (id uuid);` },
    { path: "2.sql", sql: `ALTER TABLE a ADD COLUMN foo text;` },
    { path: "3.sql", sql: `ALTER TABLE a RENAME TO b;` },
    { path: "4.sql", sql: `ALTER TABLE b DROP COLUMN foo;` },
    { path: "5.sql", sql: `ALTER TABLE b ADD COLUMN bar int;` },
  ];
  const inv = parseMigrationsToInventory(files);
  assertFalse(inv.tables.has("a"));
  assert(inv.tables.has("b"));
  assertEquals([...inv.columns.get("b")!].sort(), ["bar", "id"]);
});

Deno.test("renderTargetInventory shows initial + later-added columns", () => {
  const inv = parseMigrationsToInventory([
    { path: "1.sql", sql: `CREATE TABLE t (id uuid PRIMARY KEY, kind text);` },
    { path: "2.sql", sql: `ALTER TABLE t ADD COLUMN added_at timestamptz;` },
  ]);
  const txt = renderTargetInventory(inv);
  assert(txt.includes("- t("), "table line present");
  assert(txt.includes("id"), "renders initial column");
  assert(txt.includes("kind"), "renders inline column");
  assert(txt.includes("added_at"), "renders later-added column");
});

// ============================== Pure finalizer =============================

Deno.test("finalizeMigrationLedger: zero attempts → SCHEMA_LEDGER_FETCH_FAILED with actionable message", () => {
  const r = finalizeMigrationLedger({ headSha: "abc", attempts: [] });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.code, "SCHEMA_LEDGER_FETCH_FAILED");
    assert(/no migration ledger/i.test(r.message));
  }
});

Deno.test("finalizeMigrationLedger: any failed per-path attempt fails the whole ledger", () => {
  const r = finalizeMigrationLedger({
    headSha: "abc",
    attempts: [
      { ok: true, path: "1.sql", sql: "CREATE TABLE t (id uuid);", reportedBytes: 27 },
      { ok: false, path: "2.sql", reason: "HTTP 404: not found" },
    ],
  });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.code, "SCHEMA_LEDGER_FETCH_FAILED");
    assert(r.message.includes("2.sql"));
    assert(r.message.includes("404"));
  }
});

Deno.test("finalizeMigrationLedger: UTF-8 byte accounting counts multi-byte codepoints correctly", () => {
  // "π" is 2 bytes in UTF-8 but 1 JS code unit.
  const sql = "-- π\nCREATE TABLE t (id uuid);";
  const jsUnits = sql.length;
  const bytes = utf8Bytes(sql);
  assert(bytes > jsUnits, "UTF-8 byte length must exceed JS code-unit count");
  const r = finalizeMigrationLedger({
    headSha: "sha",
    attempts: [{ ok: true, path: "1.sql", sql, reportedBytes: bytes }],
  });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.totalBytes, bytes);
    assertEquals(r.provenance[0], { path: "1.sql", bytes });
    assertEquals(r.headSha, "sha");
  }
});

Deno.test("finalizeMigrationLedger: preserves ordered provenance matching attempt order", () => {
  const attempts = [
    { ok: true as const, path: "a.sql", sql: "CREATE TABLE a (id uuid);", reportedBytes: null },
    { ok: true as const, path: "b.sql", sql: "CREATE TABLE b (id uuid);", reportedBytes: null },
    { ok: true as const, path: "c.sql", sql: "CREATE TABLE c (id uuid);", reportedBytes: null },
  ];
  const r = finalizeMigrationLedger({ headSha: "sha", attempts });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.provenance.map((p) => p.path), ["a.sql", "b.sql", "c.sql"]);
    assertEquals(r.files.map((f) => f.path), ["a.sql", "b.sql", "c.sql"]);
  }
});

Deno.test("finalizeMigrationLedger: per-file byte cap is enforced against the worst of reported and decoded", () => {
  const bigSql = "x".repeat(MIGRATION_MAX_FILE_BYTES + 1);
  const r = finalizeMigrationLedger({
    headSha: "sha",
    attempts: [{ ok: true, path: "big.sql", sql: bigSql, reportedBytes: 10 }],
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SCHEMA_LEDGER_TOO_LARGE");
});

// ============================== Policy helper =============================

Deno.test("decideLedgerAuthority: schema-touching supabase batch + zero files → blocked", () => {
  const d = decideLedgerAuthority({
    source: "github",
    schemaTouching: true,
    ledgerOk: false,
    ledgerFileCount: 0,
  });
  assertEquals(d.blocked, true);
  assertEquals(d.targetInvOk, false);
});

Deno.test("decideLedgerAuthority: UI-only batch + zero files → proceed without schema authority", () => {
  const d = decideLedgerAuthority({
    source: "github",
    schemaTouching: false,
    ledgerOk: false,
    ledgerFileCount: 0,
  });
  assertEquals(d.blocked, false);
  assertEquals(d.targetInvOk, false);
});

Deno.test("decideLedgerAuthority: usable ledger enables schema authority for any batch", () => {
  const d = decideLedgerAuthority({
    source: "github",
    schemaTouching: true,
    ledgerOk: true,
    ledgerFileCount: 3,
  });
  assertEquals(d.blocked, false);
  assertEquals(d.targetInvOk, true);
});

Deno.test("decideLedgerAuthority: non-github source never asserts target schema authority", () => {
  const d = decideLedgerAuthority({
    source: "paste",
    schemaTouching: true,
    ledgerOk: false,
    ledgerFileCount: 0,
  });
  assertEquals(d.blocked, false);
  assertEquals(d.targetInvOk, false);
});
