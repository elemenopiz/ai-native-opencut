/**
 * The program engine's hard caps — see `executor.ts`'s module docblock
 * ("THE THREAT MODEL") for what each one defends against. Every field here
 * maps 1:1 to a `ProgramCapName` in `errors.ts`; when a run exceeds one it
 * fails with a `ProgramBudgetExceededError` naming exactly this field.
 *
 * Two are explicitly required by the spec this module implements
 * (`docs/plans/2026-09-18-director-autonomy-architecture.md` §2 — "Bounded:
 * caps on operation count, wall-clock, and loop iterations"): `maxOperations`
 * and `maxWallClockMs` directly, `maxLoopIterations` directly. The rest
 * (`maxSourceLength`, `maxAstNodes`, `maxNestingDepth`, `maxSteps`) are
 * defense-in-depth the spec doesn't name explicitly but the threat model
 * does: `maxSteps` is what actually stops a tight allocation-free loop like
 * `while(true){}`-shaped iteration from spinning between wall-clock checks
 * on a slow host, and the parse-time trio stop a pathological SOURCE
 * document (not a slow loop, just a huge or absurdly-nested one) from
 * costing real memory/stack before a single step even runs.
 */
export interface ProgramLimits {
	/** Max program source length, UTF-16 code units. Rejects a pathologically large document before it's even tokenized. */
	maxSourceLength: number;
	/** Max AST nodes the parser will build. A cheap proxy for "program complexity" independent of loop counts. */
	maxAstNodes: number;
	/** Max nesting depth of blocks (`if`/`for` bodies). Bounds the parser's/interpreter's own recursion depth — never let the SCRIPT pick how deep our call stack goes. */
	maxNestingDepth: number;
	/** Max interpreter steps (one per statement executed / expression node evaluated). The real backstop against runaway iteration between wall-clock checks. */
	maxSteps: number;
	/** Max primitive verb calls (`trim`, `move`, `split`, …) in one run — matches the spec's "operation count" cap verbatim. */
	maxOperations: number;
	/** Max total loop-body iterations across every `for` in the run — matches the spec's "loop iterations" cap verbatim. */
	maxLoopIterations: number;
	/** Max wall-clock budget for the whole run, milliseconds — matches the spec's "wall-clock" cap verbatim. */
	maxWallClockMs: number;
}

/**
 * Defaults sized for what a real editing program looks like: dozens to a
 * few hundred primitive calls over a beat grid / transcript that's itself a
 * few hundred to a few thousand entries (a multi-minute vlog's beat count or
 * word count, roughly) — generous headroom over realistic programs, hard
 * enough to make a runaway one fail fast. Callers doing something unusual
 * (a very long-form edit) can override any field per run; see
 * `RunProgramOptions.limits` in `executor.ts`.
 */
export const DEFAULT_PROGRAM_LIMITS: ProgramLimits = {
	maxSourceLength: 20_000,
	maxAstNodes: 5_000,
	maxNestingDepth: 24,
	maxSteps: 200_000,
	maxOperations: 500,
	maxLoopIterations: 50_000,
	maxWallClockMs: 2_000,
};

/** Merge caller overrides over the defaults — same "explicit `undefined` never clobbers" discipline `lib/auto-cut/engine.ts`'s `resolveOptions` uses. */
export function resolveProgramLimits(
	overrides?: Partial<ProgramLimits>,
): ProgramLimits {
	const resolved: ProgramLimits = { ...DEFAULT_PROGRAM_LIMITS };
	if (!overrides) return resolved;
	// Walk the DEFAULTS' keys rather than the overrides' own: every key is then
	// statically a `keyof ProgramLimits`, so the assignment needs no cast, and a
	// stray key on an untyped `overrides` (one parsed from JSON, say) can't be
	// copied onto the limits at all.
	for (const key of Object.keys(
		DEFAULT_PROGRAM_LIMITS,
	) as (keyof ProgramLimits)[]) {
		const value = overrides[key];
		if (value !== undefined) {
			resolved[key] = value;
		}
	}
	return resolved;
}
