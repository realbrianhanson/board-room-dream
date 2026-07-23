// Pure helper for selecting the first meaningful load error across the
// parallel queries that back the cohort project detail view. Keeps the
// route component testable without mocking Supabase directly.

export type NamedError = { label: string; error: { message?: string | null } | null | undefined };

export function selectLoadError(errors: NamedError[]): string | null {
  for (const { label, error } of errors) {
    if (error) {
      const msg = (error.message ?? "").toString().trim();
      return msg ? `${label}: ${msg}` : label;
    }
  }
  return null;
}
