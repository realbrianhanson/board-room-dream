// deno-lint-ignore-file no-explicit-any
// Batch 17 — wire protocol between the boardroom-orchestrator edge function
// and the Cloudflare executor Worker (spec §6). Types, constants and shared
// test fixtures ONLY: no I/O, no Deno.*, no imports, so the same file is
// imported by Deno (../_shared/executor-protocol.ts) and by the Worker
// (cloudflare/executor/src/protocol.ts re-exports it by relative path).

export const EXECUTOR_PROTOCOL_VERSION = 1;

/** Dispatch bodies above this many bytes are refused by the Worker (413). */
export const MAX_DISPATCH_BYTES = 900_000;

/** OpenRouter keepalive comment sent while the provider thinks (SSE only). */
export const SSE_KEEPALIVE_PREFIX = ": OPENROUTER PROCESSING";

/**
 * The canonical callback path on BOTH sides. The orchestrator puts
 * `${SUPABASE_URL}/functions/v1/boardroom-orchestrator` in `callback_url`,
 * the Worker signs `new URL(callback_url).pathname`, and the orchestrator
 * verifies against this constant — never against `req.url`, whose path is
 * already stripped of `/functions/v1` inside a hosted edge function (§5.3).
 */
export const EXECUTOR_CALLBACK_PATH = "/functions/v1/boardroom-orchestrator";

export type ExecutorTransport = "sse" | "json";

/** Envelope-sealed OpenRouter key (HKDF + AES-256-GCM, AAD = call id; §6.2). */
export type SealedKey = { v: 1; iv: string; ct: string };

export type DispatchLabels = {
  run_id: string;
  step_id: string;
  step_key: string;
  seat: string;
  smoke: boolean;
};

/** POST /v1/calls body (§6.3). `openrouter.body` is exactly the proxy's buildBody(modelId) — no `stream`. */
export type DispatchRequest = {
  call_id: string;
  labels: DispatchLabels;
  timeout_ms: number;
  idle_ms: number;
  transport: ExecutorTransport;
  callback_url: string;
  openrouter: {
    key_sealed: SealedKey;
    headers: Record<string, string>;
    body: any;
  };
  orchestrator_build: string;
};

export type DispatchResponse = {
  call_id: string;
  state: "queued" | "running";
  created: boolean;
};

export type ExecutorErrorKind =
  | "timeout"
  | "idle"
  | "upstream_status"
  | "pre_response"
  | "body_transport"
  | "bad_dispatch";

/** Classified failure of one model call; rebuilt into the proxy's own error shapes by errorFromExecutor (§6.5). */
export type ExecutorError = {
  kind: ExecutorErrorKind;
  status?: number;
  message: string;
  model: string;
  ms?: number;
};

/** What a finished Workflow instance stored as its output (§6.4). */
export type CallOutput =
  | {
    ok: true;
    /** OpenRouter NON-streaming JSON shape (assembled from SSE when streamed). */
    response: any;
    model: string;
    latency_ms: number;
    ttft_ms: number | null;
    streamed: boolean;
    executor_version: string;
  }
  | { ok: false; error: ExecutorError };

export type ExecutorCallState =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "complete"
  | "errored"
  | "terminated"
  | "unknown";

/** GET /v1/calls/:id body (§6.4). */
export type StatusResponse = {
  call_id: string;
  state: ExecutorCallState;
  output: CallOutput | null;
  engine_error: string | null;
};

/** POST /v1/calls/:id/cancel body (§6.4). A complete instance is reported, not terminated. */
export type CancelResponse = {
  call_id: string;
  state: "terminated" | "complete" | "errored" | "not_found";
  was_running: boolean;
};

export type HealthResponse = { ok: true; version: string };

/** Worker → orchestrator callback body (§6.5), signed with EXECUTOR_CALLBACK_PATH. */
export type ExecutorResultCallback = {
  action: "executor_result";
  call_id: string;
  step_id: string;
  run_id: string;
  output: CallOutput;
  executor_version: string;
};

export type SettleOutcome =
  | "completed"
  | "failed"
  | "requeued"
  | "refusal_requeued"
  | "ledger_only"
  | "stale"
  | "stale_ledgered"
  | "budget_pause";

// ---------------------------------------------------------------------------
// Fixtures shared by the Deno suite (_shared/executor-auth.test.ts) and the
// Worker's vitest suite (cloudflare/executor/src/auth.test.ts). The literals
// below were produced ONCE by the Deno implementation; the Worker test proves
// Node's WebCrypto verifies what Deno signed and opens what Deno sealed.
// ---------------------------------------------------------------------------

/** Known-answer HMAC vector (§12). `sig` is the exact x-executor-sig for these inputs. */
export const EXECUTOR_AUTH_VECTOR = {
  secret: "0000000000000000000000000000000000000000000000000000000000000001",
  method: "POST",
  path: "/v1/calls",
  ts: "1757437331412",
  nonce: "000102030405060708090a0b0c0d0e0f",
  body: '{"a":1}',
  body_sha256: "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
  canonical: "v1\nPOST\n/v1/calls\n1757437331412\n000102030405060708090a0b0c0d0e0f\n015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
  sig: "v1=09dc8f83a483c14635f35931a76264ff8c7113384db4997b7b6f275b0ededd63",
} as const;

/** A key sealed by Deno for call id `call_id`; openSealedKey must return `api_key` and throw for any other call id. */
export const SEALED_KEY_FIXTURE = {
  secret: EXECUTOR_AUTH_VECTOR.secret,
  call_id: "6c0f2b1e-1d3a-4c0e-9f3b-2f4a1b9c7d10-1",
  api_key: "sk-or-v1-fixture-not-a-real-key-0123456789abcdef",
  sealed: {
    v: 1,
    iv: "DghN46oyH0Zo/wak",
    ct: "4Wua0VZ5dgpOMVeCZRTmJAtz+t8YF1wAF315/slJI0HOiTBahpimQtOJ73ZehsnCBjS2SlDXGGjgPBsbbMmLgA==",
  } as SealedKey,
} as const;

const FIXTURE_CALL_ID = "6c0f2b1e-1d3a-4c0e-9f3b-2f4a1b9c7d10-1";

/** Representative wire bodies for both test suites. */
export const EXECUTOR_FIXTURES = {
  dispatch: {
    call_id: FIXTURE_CALL_ID,
    labels: {
      run_id: "0f9d2c44-7e1b-4b1a-8c3d-5a6b7c8d9e0f",
      step_id: "6c0f2b1e-1d3a-4c0e-9f3b-2f4a1b9c7d10",
      step_key: "r1_draft_chair",
      seat: "chair",
      smoke: false,
    },
    timeout_ms: 720_000,
    idle_ms: 90_000,
    transport: "sse",
    callback_url: "https://raiyybdrizlmtbvehzaj.supabase.co/functions/v1/boardroom-orchestrator",
    openrouter: {
      key_sealed: { v: 1, iv: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      headers: { "HTTP-Referer": "https://boardroom.lovable.app", "X-Title": "BOARDROOM" },
      body: {
        model: "anthropic/claude-fable-5.1",
        messages: [
          { role: "system", content: "CONSTITUTION\n…" },
          { role: "system", content: "You are the chair of the board." },
          { role: "user", content: "Draft the plan." },
        ],
        temperature: 0.85,
        usage: { include: true },
        max_tokens: 16_000,
        reasoning: { effort: "high" },
        response_format: { type: "json_object" },
      },
    },
    orchestrator_build: "2026-09-09.executor.r1",
  } as DispatchRequest,

  okOutput: {
    ok: true,
    response: {
      id: "gen-fixture-0001",
      model: "anthropic/claude-fable-5.1",
      choices: [
        {
          message: { role: "assistant", content: "{\"plan\":\"ok\"}" },
          finish_reason: "stop",
          native_finish_reason: "end_turn",
        },
      ],
      usage: {
        prompt_tokens: 21_740,
        completion_tokens: 6_120,
        cost: 0.4183,
        completion_tokens_details: { reasoning_tokens: 4_200 },
      },
    },
    model: "anthropic/claude-fable-5.1",
    latency_ms: 312_456,
    ttft_ms: 285_010,
    streamed: true,
    executor_version: "batch17",
  } as CallOutput & { ok: true },

  timeoutOutput: {
    ok: false,
    error: {
      kind: "timeout",
      message: "OpenRouter call to anthropic/claude-fable-5.1 timed out after 720000ms",
      model: "anthropic/claude-fable-5.1",
      ms: 720_000,
    },
  } as CallOutput & { ok: false },

  upstreamStatusOutput: {
    ok: false,
    error: {
      kind: "upstream_status",
      status: 429,
      message: "Rate limited",
      model: "anthropic/claude-fable-5.1",
    },
  } as CallOutput & { ok: false },

  statusComplete: {
    call_id: FIXTURE_CALL_ID,
    state: "complete",
    output: null as CallOutput | null,
    engine_error: null,
  } as StatusResponse,

  statusRunning: {
    call_id: FIXTURE_CALL_ID,
    state: "running",
    output: null,
    engine_error: null,
  } as StatusResponse,

  cancelComplete: {
    call_id: FIXTURE_CALL_ID,
    state: "complete",
    was_running: false,
  } as CancelResponse,
} as const;
