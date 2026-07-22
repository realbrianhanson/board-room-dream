// deno-lint-ignore-file no-explicit-any
// Target-repo schema authority for the JIT batch compiler.
//
// The platform DB (App Blueprint's own Supabase) is NEVER evidence for a
// target project's schema. For GitHub-linked projects we derive a bounded
// "effective" schema ledger from the target repository's own
// supabase/migrations/*.sql files, processed in lexicographic order so
// later DROP/RENAME/ADD COLUMN edits produce the effective state.

export type MigrationFile = { path: string; sql: string };

export type TargetSchemaInventory = {
  tables: Set<string>;
  functions: Set<string>;
  policies: Set<string>;
  indexes: Set<string>;
  views: Set<string>;
  columns: Map<string, Set<string>>; // table -> column names
};

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|[a-zA-Z_][a-zA-Z0-9_]*)`;
const QNAME = String.raw`(?:(?:${IDENT})\.)?(${IDENT})`;

export function normalizeIdent(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^[`"](.*)[`"]$/, "$1")
    .replace(/^public\./i, "")
    .toLowerCase();
}

function stripComments(sql: string): string {
  // Remove line comments and /* ... */ block comments. Order matters.
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

function empty(): TargetSchemaInventory {
  return {
    tables: new Set(),
    functions: new Set(),
    policies: new Set(),
    indexes: new Set(),
    views: new Set(),
    columns: new Map(),
  };
}

/**
 * Parse an ordered list of migration files into an effective schema
 * inventory. Files are processed in the order supplied — callers MUST sort
 * lexicographically by path first, which is how Supabase applies them.
 */
export function parseMigrationsToInventory(
  files: readonly MigrationFile[],
): TargetSchemaInventory {
  const inv = empty();

  for (const f of files) {
    const src = stripComments(f.sql ?? "");

    // CREATE TABLE [IF NOT EXISTS] [schema.]name (...)
    const tableRe = new RegExp(
      String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(src))) {
      const name = normalizeIdent(m[1]);
      inv.tables.add(name);
      if (!inv.columns.has(name)) inv.columns.set(name, new Set());
    }

    // CREATE [OR REPLACE] FUNCTION [schema.]name(...)
    const fnRe = new RegExp(
      String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QNAME}\s*\(`,
      "gi",
    );
    while ((m = fnRe.exec(src))) {
      inv.functions.add(normalizeIdent(m[1]));
    }

    // CREATE POLICY "name" ON [schema.]table
    const polRe = new RegExp(
      String.raw`\bCREATE\s+POLICY\s+(${IDENT})\s+ON\s+${QNAME}`,
      "gi",
    );
    while ((m = polRe.exec(src))) {
      inv.policies.add(normalizeIdent(m[1]));
    }

    const idxRe = new RegExp(
      String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+`,
      "gi",
    );
    while ((m = idxRe.exec(src))) {
      inv.indexes.add(normalizeIdent(m[1]));
    }

    const viewRe = new RegExp(
      String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`,
      "gi",
    );
    while ((m = viewRe.exec(src))) {
      inv.views.add(normalizeIdent(m[1]));
    }

    // DROP TABLE [IF EXISTS] [schema.]name[, name2] [CASCADE]
    const dropTableRe = new RegExp(
      String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+?)\s*(?:CASCADE|RESTRICT)?\s*;`,
      "gi",
    );
    while ((m = dropTableRe.exec(src))) {
      for (const raw of m[1].split(",")) {
        const name = normalizeIdent(raw.replace(/^public\./i, ""));
        inv.tables.delete(name);
        inv.columns.delete(name);
      }
    }

    const dropFnRe = new RegExp(
      String.raw`\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?${QNAME}`,
      "gi",
    );
    while ((m = dropFnRe.exec(src))) {
      inv.functions.delete(normalizeIdent(m[1]));
    }

    const dropPolRe = new RegExp(
      String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+`,
      "gi",
    );
    while ((m = dropPolRe.exec(src))) {
      inv.policies.delete(normalizeIdent(m[1]));
    }

    const dropIdxRe = new RegExp(
      String.raw`\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(${IDENT})`,
      "gi",
    );
    while ((m = dropIdxRe.exec(src))) {
      inv.indexes.delete(normalizeIdent(m[1]));
    }

    const dropViewRe = new RegExp(
      String.raw`\bDROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?${QNAME}`,
      "gi",
    );
    while ((m = dropViewRe.exec(src))) {
      inv.views.delete(normalizeIdent(m[1]));
    }

    // ALTER TABLE [schema.]old RENAME TO new
    const renameRe = new RegExp(
      String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QNAME}\s+RENAME\s+TO\s+(${IDENT})`,
      "gi",
    );
    while ((m = renameRe.exec(src))) {
      const oldName = normalizeIdent(m[1]);
      const newName = normalizeIdent(m[2]);
      if (inv.tables.delete(oldName)) inv.tables.add(newName);
      const cols = inv.columns.get(oldName);
      if (cols) {
        inv.columns.delete(oldName);
        inv.columns.set(newName, cols);
      }
    }

    // ALTER TABLE [schema.]name ADD COLUMN [IF NOT EXISTS] col_name TYPE
    const addColRe = new RegExp(
      String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QNAME}\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`,
      "gi",
    );
    while ((m = addColRe.exec(src))) {
      const t = normalizeIdent(m[1]);
      const c = normalizeIdent(m[2]);
      if (!inv.columns.has(t)) inv.columns.set(t, new Set());
      inv.columns.get(t)!.add(c);
    }

    // ALTER TABLE ... DROP COLUMN [IF EXISTS] col
    const dropColRe = new RegExp(
      String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QNAME}\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(${IDENT})`,
      "gi",
    );
    while ((m = dropColRe.exec(src))) {
      const t = normalizeIdent(m[1]);
      const c = normalizeIdent(m[2]);
      inv.columns.get(t)?.delete(c);
    }
  }

  return inv;
}

/** Merge names from every kind into a single lower-case set for the
 * existing `findExistingCreateCollision` check. */
export function toCollisionSet(inv: TargetSchemaInventory): Set<string> {
  const s = new Set<string>();
  for (const n of inv.tables) s.add(n);
  for (const n of inv.functions) s.add(n);
  for (const n of inv.policies) s.add(n);
  for (const n of inv.indexes) s.add(n);
  for (const n of inv.views) s.add(n);
  return s;
}

/** Deterministic textual view of the target inventory for prompt injection.
 * Kept compact — tables + column names, function names, policy names. */
export function renderTargetInventory(inv: TargetSchemaInventory): string {
  const tableLines = [...inv.tables].sort().map((t) => {
    const cols = [...(inv.columns.get(t) ?? new Set())].sort();
    return cols.length
      ? `- ${t}(${cols.slice(0, 40).join(", ")}${cols.length > 40 ? ", …" : ""})`
      : `- ${t}`;
  });
  const fns = [...inv.functions].sort().map((n) => `- ${n}()`);
  const pols = [...inv.policies].sort().map((n) => `- ${n}`);
  return [
    `TABLES (${inv.tables.size}):`,
    tableLines.join("\n") || "(none)",
    "",
    `FUNCTIONS (${inv.functions.size}):`,
    fns.join("\n") || "(none)",
    "",
    `POLICIES (${inv.policies.size}):`,
    pols.join("\n") || "(none)",
  ].join("\n");
}

// ============================== Fetch caps ==============================

export const MIGRATION_MAX_FILES = 400;
export const MIGRATION_MAX_TOTAL_BYTES = 1_572_864; // 1.5 MiB
export const MIGRATION_MAX_FILE_BYTES = 262_144; // 256 KiB

export type LedgerFetchStatus =
  | { ok: true; files: MigrationFile[]; totalBytes: number }
  | { ok: false; code: "SCHEMA_LEDGER_TOO_LARGE" | "SCHEMA_LEDGER_FETCH_FAILED"; message: string };

export type SchemaTouchOpts = {
  channel: string;
  compiledOrRoadmap: string;
};

/** Heuristic: does this batch's roadmap or compiled markdown reference
 * schema-touching intent? Used to decide whether an empty target ledger
 * should block the compile. UI-only lovable batches may proceed with an
 * empty ledger and are simply not fed a target inventory. */
export function batchTouchesSchema(opts: SchemaTouchOpts): boolean {
  if (opts.channel === "supabase") return true;
  const t = String(opts.compiledOrRoadmap ?? "");
  if (!t) return false;
  return /\b(CREATE|ALTER|DROP)\s+(TABLE|POLICY|FUNCTION|TRIGGER|INDEX|VIEW)\b/i.test(t)
    || /supabase\/migrations\//i.test(t)
    || /\bRLS\b|\bROW\s+LEVEL\s+SECURITY\b/i.test(t);
}
