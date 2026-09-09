// Single source of truth: the wire protocol lives next to the orchestrator.
// Workers Builds clones the whole repository and only changes directory into
// cloudflare/executor, so this relative path resolves at build time (spec §10).
export * from "../../../supabase/functions/_shared/executor-protocol.ts";
