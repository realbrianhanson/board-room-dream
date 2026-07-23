// Every user/DB-influenced string flowing into digest HTML MUST be escaped.
// Ampersand FIRST so we don't double-escape entity refs emitted for the
// other characters.
export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
