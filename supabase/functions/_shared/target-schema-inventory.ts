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

// ---------------- Balanced scanner used by column extraction ----------------
//
// Scan forward from an opening '(' and return the substring inside the outer
// parens plus the index just past the closing ')'. Tracks single-quote,
// double-quote, backtick, and Postgres dollar-quoted strings so commas /
// parens inside a default expression or a quoted default do NOT break the
// split.

function findBalancedParenBody(
  src: string,
  openIdx: number,
): { body: string; endIdx: number } | null {
  if (src[openIdx] !== "(") return null;
  let depth = 0;
  let i = openIdx;
  const N = src.length;
  while (i < N) {
    const c = src[i];
    // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty)
    if (c === "$") {
      const m = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        if (end < 0) return null;
        i = end + tag.length;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === "`") {
      // Skip string literal; handle SQL doubled-quote escape ('' or "")
      const quote = c;
      i++;
      while (i < N) {
        if (src[i] === quote) {
          if (src[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") {
      depth--;
      i++;
      if (depth === 0) {
        return { body: src.slice(openIdx + 1, i - 1), endIdx: i };
      }
      continue;
    }
    i++;
  }
  return null;
}

function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const N = body.length;
  let i = 0;
  while (i < N) {
    const c = body[i];
    if (c === "$") {
      const m = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(body.slice(i));
      if (m) {
        const tag = m[0];
        const end = body.indexOf(tag, i + tag.length);
        if (end < 0) { i = N; break; }
        i = end + tag.length;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < N) {
        if (body[i] === quote) {
          if (body[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (start < N) out.push(body.slice(start));
  return out;
}

const TABLE_CONSTRAINT_HEAD =
  /^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\s*(?:\(|USING\b)|CHECK\s*\(|EXCLUDE\b|LIKE\b)/i;

function extractInlineColumnsForTable(bodyAfterOpen: string): Set<string> {
  const cols = new Set<string>();
  for (const rawItem of splitTopLevelCommas(bodyAfterOpen)) {
    const item = rawItem.trim();
    if (!item) continue;
    if (TABLE_CONSTRAINT_HEAD.test(item)) continue;
    // Column definition: first token is the column identifier.
    const m = /^("[^"]+"|`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)/.exec(item);
    if (!m) continue;
    const name = normalizeIdent(m[1]);
    if (!name) continue;
    cols.add(name);
  }
  return cols;
}

/**
 * Parse an ordered list of migration files into an effective schema
 * inventory. Files are ALWAYS re-sorted lexicographically by path inside
 * this function — callers cannot subvert Supabase's own apply order by
 * passing files in a different sequence.
 */
export function parseMigrationsToInventory(
  files: readonly MigrationFile[],
): TargetSchemaInventory {
  const inv = empty();

  // Enforce lexicographic order (Supabase's own migration apply order).
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const f of ordered) {
    const src = stripComments(f.sql ?? "");

    // CREATE TABLE [IF NOT EXISTS] [schema.]name ( column_defs )
    const tableRe = new RegExp(
      String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}\s*\(`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(src))) {
      const name = normalizeIdent(m[1]);
      inv.tables.add(name);
      // Parse the column list from the balanced parenthesized body.
      const openIdx = tableRe.lastIndex - 1;
      const scan = findBalancedParenBody(src, openIdx);
      if (!inv.columns.has(name)) inv.columns.set(name, new Set());
      if (scan) {
        const cols = extractInlineColumnsForTable(scan.body);
        const target = inv.columns.get(name)!;
        for (const c of cols) target.add(c);
        // Advance the regex cursor so column-body parens don't confuse it.
        tableRe.lastIndex = scan.endIdx;
      }
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
/** Cap on how many provenance entries we persist to compile_meta so a
 * ~400-file ledger cannot make the row unreasonably large. */
export const MIGRATION_PROVENANCE_MAX_ENTRIES = 400;

export type ProvenanceEntry = { path: string; bytes: number };

export type LedgerFetchStatus =
  | {
      ok: true;
      headSha: string;
      files: MigrationFile[];
      totalBytes: number;
      provenance: ProvenanceEntry[];
    }
  | {
      ok: false;
      code: "SCHEMA_LEDGER_TOO_LARGE" | "SCHEMA_LEDGER_FETCH_FAILED";
      message: string;
    };

/** Per-path attempt result used by the pure finalizer. */
export type MigrationAttempt =
  | { ok: true; path: string; sql: string; reportedBytes: number | null }
  | { ok: false; path: string; reason: string };

export type FinalizeInput = {
  headSha: string;
  attempts: readonly MigrationAttempt[];
};

/** UTF-8 byte length of a decoded SQL string. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(String(s ?? "")).byteLength;
}

/**
 * Pure ledger-finalization helper. Fails closed on:
 *  - zero attempts (no matching supabase/migrations/*.sql),
 *  - any per-path failure (never silently skips),
 *  - any decoded/reported size exceeding the per-file cap,
 *  - decoded UTF-8 total exceeding the 1.5 MiB ceiling.
 * Returns ordered provenance and files on success.
 */
export function finalizeMigrationLedger(input: FinalizeInput): LedgerFetchStatus {
  const { headSha, attempts } = input;
  if (!attempts || attempts.length === 0) {
    return {
      ok: false,
      code: "SCHEMA_LEDGER_FETCH_FAILED",
      message:
        "no migration ledger: linked repo has zero supabase/migrations/*.sql files — add the migrations folder and retry",
    };
  }
  const files: MigrationFile[] = [];
  const provenance: ProvenanceEntry[] = [];
  let total = 0;
  // Preserve caller order (already-sorted lexicographically upstream).
  for (const a of attempts) {
    if (!a.ok) {
      return {
        ok: false,
        code: "SCHEMA_LEDGER_FETCH_FAILED",
        message: `failed to fetch ${a.path}: ${a.reason}`,
      };
    }
    const decodedBytes = utf8Bytes(a.sql);
    const reported = typeof a.reportedBytes === "number" ? a.reportedBytes : decodedBytes;
    const worst = Math.max(decodedBytes, reported);
    if (worst > MIGRATION_MAX_FILE_BYTES) {
      return {
        ok: false,
        code: "SCHEMA_LEDGER_TOO_LARGE",
        message: `migration ${a.path} is ${worst} bytes (cap ${MIGRATION_MAX_FILE_BYTES})`,
      };
    }
    total += decodedBytes;
    if (total > MIGRATION_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        code: "SCHEMA_LEDGER_TOO_LARGE",
        message: `migrations exceed ${MIGRATION_MAX_TOTAL_BYTES} bytes (UTF-8 decoded)`,
      };
    }
    files.push({ path: a.path, sql: a.sql });
    provenance.push({ path: a.path, bytes: decodedBytes });
  }
  return { ok: true, headSha, files, totalBytes: total, provenance };
}

// -------- Schema-touch heuristic + compile-block policy --------

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

export type LedgerAuthority = {
  /** true only when we have a usable target ledger to feed the model. */
  targetInvOk: boolean;
  /** true when the caller MUST block/persist a 'blocked' compile. */
  blocked: boolean;
};

/**
 * Deterministic policy for how the compiler treats an empty/failed ledger.
 *  - github + schema-touching + no usable ledger → blocked (fail-closed).
 *  - github + UI-only batch + no ledger → proceed, but with no schema authority.
 *  - non-github source → no target inventory considered.
 */
export function decideLedgerAuthority(input: {
  source: "github" | "paste" | string;
  schemaTouching: boolean;
  ledgerOk: boolean;
  ledgerFileCount: number;
}): LedgerAuthority {
  if (input.source !== "github") {
    return { targetInvOk: false, blocked: false };
  }
  const usable = input.ledgerOk && input.ledgerFileCount > 0;
  if (input.schemaTouching && !usable) {
    return { targetInvOk: false, blocked: true };
  }
  return { targetInvOk: usable, blocked: false };
}
