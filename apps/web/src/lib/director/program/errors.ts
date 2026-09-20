/**
 * Typed error taxonomy for `lib/director/program/*`.
 *
 * Every failure mode the program engine can produce is one of these four
 * classes, never a bare `Error`/string throw — so a caller (the executor
 * itself, a future `applyEdit` verb, or a test) can `instanceof`-branch
 * without parsing messages. Each carries enough structured data to explain
 * itself in a UI or an agent transcript without re-deriving it.
 */

/** Discriminant every program-engine error carries, mirroring `DirectorLookupFailureCode`'s "stable machine-readable code" convention in `lib/director/types.ts`. */
export type ProgramErrorKind = "parse" | "budget" | "runtime" | "primitive";

/** Base class for every error this package throws. Never thrown directly. */
export abstract class ProgramError extends Error {
	abstract readonly kind: ProgramErrorKind;
}

/**
 * The program's source text does not parse under the whitelisted grammar
 * (`parser.ts`) — a syntax error, not a security violation. `line`/`column`
 * are 1-based, best-effort (the tokenizer's position when it gave up).
 */
export class ProgramParseError extends ProgramError {
	readonly kind = "parse" as const;
	constructor(
		message: string,
		readonly line: number,
		readonly column: number,
	) {
		super(`Program parse error at ${line}:${column}: ${message}`);
		this.name = "ProgramParseError";
	}
}

/** Every bound the executor enforces — see `limits.ts`'s `ProgramLimits` for the matching numeric value. */
export type ProgramCapName =
	| "sourceLength"
	| "astNodes"
	| "nestingDepth"
	| "steps"
	| "operations"
	| "loopIterations"
	| "wallClockMs";

/**
 * A run was stopped because it hit one of the hard caps in `limits.ts` —
 * NEVER because something looked unsafe (that's a design goal, not a runtime
 * check: the interpreter has no path to anything unsafe in the first place).
 * `cap` names exactly which bound tripped, `limit` is the configured value,
 * so a caller can report "loop ran past 50,000 iterations" instead of a bare
 * "budget exceeded".
 */
export class ProgramBudgetExceededError extends ProgramError {
	readonly kind = "budget" as const;
	constructor(
		readonly cap: ProgramCapName,
		readonly limit: number,
	) {
		super(`Program exceeded its "${cap}" cap (limit: ${limit}).`);
		this.name = "ProgramBudgetExceededError";
	}
}

/**
 * The program parsed fine but failed while being interpreted: an undeclared
 * variable, a type mismatch (e.g. `1 + {}`), a forbidden property name
 * (`__proto__`/`constructor`/`prototype`), an out-of-bounds array write, or a
 * call to a name that isn't in the whitelisted global table. This is the
 * class that proves the sandbox's negative space — every one of these is a
 * program doing something the language doesn't allow, not the language
 * reaching outside itself.
 */
export class ProgramRuntimeError extends ProgramError {
	readonly kind = "runtime" as const;
	constructor(message: string) {
		super(message);
		this.name = "ProgramRuntimeError";
	}
}

/**
 * A primitive verb call (`trim`, `move`, `split`, …) came back
 * `{ ok: false }` from the real `DirectorApi`. The whole run is all-or-
 * nothing (see `executor.ts`'s docblock on atomicity), so this always aborts
 * the run — `opIndex` and `verb` say which call in the op sequence failed.
 */
export class ProgramPrimitiveError extends ProgramError {
	readonly kind = "primitive" as const;
	constructor(
		readonly opIndex: number,
		readonly verb: string,
		message: string,
	) {
		super(`Program op ${opIndex} ("${verb}") failed: ${message}`);
		this.name = "ProgramPrimitiveError";
	}
}
