// Single source of truth: HMAC signing + key sealing shared with the
// orchestrator (spec §6.1 / §6.2). Pure WebCrypto, no Node built-ins.
export * from "../../../supabase/functions/_shared/executor-auth.ts";
