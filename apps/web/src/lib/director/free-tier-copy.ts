/**
 * Shared 429 copy for the Director LLM relays (`/api/llm/agent` and
 * `/api/llm/gemini`). Director chat is a FREE feature (no credit metering),
 * so these are the only cost floor — pulled into one module so both routes
 * give the user identical, accurate guidance instead of drifting copies.
 */

/** Per-minute burst cap tripped — a transient "slow down", not "come back tomorrow". */
export const DIRECTOR_BURST_LIMIT_MESSAGE =
	"You're sending Director messages too quickly. Wait a moment and try again.";

/**
 * Daily free-turn cap tripped (see DIRECTOR_FREE_TURNS_PER_DAY in
 * `lib/rate-limit.ts`). Mentions the MCP escape hatch — connecting your own
 * agent over MCP runs on YOUR LLM key, so it isn't subject to this cap.
 */
export const DIRECTOR_DAILY_LIMIT_MESSAGE =
	"You've used today's free Director allowance. It resets tomorrow — " +
	"for unlimited use right now, connect your own agent via MCP (it runs " +
	"on your own LLM key, not ours).";
