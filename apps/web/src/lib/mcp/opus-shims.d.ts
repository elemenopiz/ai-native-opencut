/**
 * ⚠️ TEMPORARY TYPE SHIMS — DELETE AT INTEGRATION. ⚠️
 *
 * These ambient module declarations mirror the FROZEN interfaces of the two
 * modules being built in a parallel worktree (Opus's slice). They exist ONLY
 * so this slice typechecks before those files land:
 *
 *   1. `@/lib/director/tool-catalog`  → apps/web/src/lib/director/tool-catalog.ts
 *   2. `@/lib/mcp/auth`               → apps/web/src/lib/mcp/auth.ts
 *
 * TypeScript falls back to an ambient `declare module` only when the path
 * alias fails to resolve to a real file — so the moment the real modules are
 * merged, delete this file (leaving it in place risks duplicate/augmentation
 * errors and, worse, silently masking signature drift).
 *
 * NOTE: these shims satisfy `tsc` but NOT the bundler — the app will not RUN
 * until the real modules exist. That is expected for this slice.
 */

declare module "@/lib/director/tool-catalog" {
	import type { DirectorApi } from "@/lib/director/director-api";
	import type { DirectorResult } from "@/lib/director/types";

	/** One agent-facing tool over the Director API (frozen interface). */
	export interface ToolDescriptor {
		name: string;
		description: string;
		/** JSON Schema draft-07 for the tool's arguments. */
		inputSchema: Record<string, unknown>;
		/** True when the tool mutates the reel (drives reel:write scope). */
		mutating: boolean;
		/** The ONLY executor path — runs in the browser tab against a live DirectorApi. */
		handler: (
			director: DirectorApi,
			args: Record<string, unknown>,
		) => Promise<DirectorResult<unknown>> | DirectorResult<unknown>;
	}

	/** The 21-tool shared catalog (frozen interface). */
	export function toolCatalog(): ToolDescriptor[];
}

declare module "@/lib/mcp/auth" {
	/**
	 * Verify a raw project-scoped bearer token (frozen interface).
	 * Resolves null for invalid/expired tokens.
	 */
	export function verifyProjectToken(rawToken: string): Promise<{
		userId: string;
		projectId: string;
		scopes: string[];
	} | null>;

	/** Scope required to invoke the named tool (frozen interface). */
	export function scopeForTool(name: string): "reel:read" | "reel:write";
}
