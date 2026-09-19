/**
 * `runProgram` — the one entry point of the Director's program engine, and
 * the mechanism behind `docs/plans/2026-09-18-director-autonomy-architecture.
 * md` §2's central claim: forty frozen macro verbs collapse into ~fifteen
 * primitives plus composition, and `cutOnBeat` stops being a ceiling and
 * becomes ONE POSSIBLE PROGRAM over that surface
 * (`cut-on-beat.program.test.ts` is the receipt).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE THREAT MODEL
 * ──────────────────────────────────────────────────────────────────────────
 * A program is a STRING WRITTEN BY A LANGUAGE MODEL, and a language model's
 * output is untrusted input: it can be steered by a prompt-injection payload
 * sitting in a filename, a transcript, an asset's metadata, or a user
 * message. So the assumption here is not "the model is careless" but "the
 * program is adversarial", and the defense is that the reachable set is
 * closed by construction rather than filtered by inspection:
 *
 *  1. NO DYNAMIC CODE EVALUATION. Not `eval`, not the `Function` constructor,
 *     not dynamic `import`, not a worker, not `setTimeout` with a string. The
 *     engine is a whitelisted-AST interpreter (`parser.ts` →
 *     `interpreter.ts`); the host's JS scope is unreachable from a program
 *     because a program is never JS.
 *  2. NO AMBIENT AUTHORITY. The only names a program can resolve are the ones
 *     the host puts in its `Globals` table for that one run: ten primitives,
 *     the derived-data accessors whose sources were actually wired, and a
 *     dozen pure helpers. There is no `globalThis`, `window`, `process`,
 *     `fetch`, `require`, `import`, filesystem or network — not blocked, but
 *     absent from the grammar and the name table alike.
 *  3. NO CALLABLE VALUES. `CallExpr` holds a literal NAME, not an expression
 *     (`ast.ts`), and the value domain (`values.ts`) contains no functions.
 *     `x.constructor("…")()`, `f()()`, `arr["map"](…)` have no spelling.
 *  4. NO PROTOTYPE REACH. `__proto__`/`constructor`/`prototype` are refused
 *     at every property site — member read, index read, object-literal key,
 *     assignment path (`interpreter.ts`'s `assertSafeProperty`) — and object
 *     reads go through `Object.hasOwn`, so inherited keys are not data.
 *  5. BOUNDED, WITH THE CAP NAMED. Source length, AST nodes, nesting depth,
 *     interpreter steps, loop iterations, primitive operations and wall clock
 *     each have a limit in `limits.ts` and a matching `ProgramCapName` in
 *     `errors.ts`; exceeding one throws `ProgramBudgetExceededError` that
 *     says WHICH cap and WHAT its value was. 1:1, no unnamed "budget
 *     exceeded".
 *  6. NO CROSS-RUN STATE. Every run builds a fresh globals table, a fresh
 *     meter and a fresh op log; values crossing the host boundary are cloned
 *     in both directions. Two concurrent runs cannot see each other, and a
 *     program cannot leave anything behind for the next one.
 *  7. INSPECTABLE BEFORE IT ACTS. {@link runProgram} defaults to `"dry-run"`,
 *     which returns the complete ordered op list and applies NOTHING. This is
 *     the safety story the architecture doc asks for, so it is the default
 *     rather than a flag someone has to remember.
 *
 * WHAT THIS DOES *NOT* DEFEND AGAINST, stated plainly:
 *  - A program authorized to edit can still make a BAD EDIT. Nothing here
 *    judges taste; `dry-run` + a human/critic read of the op list is the
 *    control, not the sandbox.
 *  - The primitives it calls are the same `DirectorApi` verbs the agent can
 *    already call one at a time. This engine changes the COMPOSITION, not the
 *    authority: it grants no capability the tool catalog did not already
 *    grant. If a verb is dangerous alone it is dangerous here.
 *  - Timing side channels and memory pressure inside the caps are not
 *    modelled. The caps bound cost, not information flow.
 *  - `structuredClone` is the cloning primitive; a host that puts a
 *    non-clonable value into the globals table breaks the run with a host
 *    error, not a security failure.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ATOMICITY / UNDO
 * ──────────────────────────────────────────────────────────────────────────
 * An applied run collapses to ONE undo entry when an {@link ProgramUndoScope}
 * is supplied — pass `editor.command` (a `CommandManager`) verbatim; the
 * structural type is shaped to accept it with no adapter. The mechanism is
 * the one `director-api.ts` already relies on and commit e8bd66f established
 * for bulk inserts: `beginTransaction`/`commitTransaction` around the whole
 * sequence. Each `DirectorApi` verb opens its own transaction inside
 * (`withAgentOrigin`), and `CommandManager`'s frame stack merges a nested
 * commit upward, so N verb calls land as one entry tagged with the OUTERMOST
 * call's origin/name — `{ origin: "agent", name: "applyEdit" }` here.
 *
 * ROLLBACK SEMANTICS, inherited verbatim from `executeCraftPlan`: on failure
 * this calls `rollbackTransaction()`, which per `CommandManager`'s own
 * contract discards the transaction's UNDO-HISTORY registration only — ops
 * that already succeeded REMAIN APPLIED to the live timeline. A failed run is
 * therefore "state may have partially changed — read the op log and the
 * timeline", never "clean no-op". The op log makes that recoverable: every
 * op that ran is in it, in order, with its result.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * KNOWN GAPS
 * ──────────────────────────────────────────────────────────────────────────
 *  - Slot-only targeting. `trim`/`move`/`split`/`remove`/`applyTransition`/
 *    `applyEffect` address GENERATIVE REEL SLOTS only, because the
 *    `DirectorApi` verbs they wrap resolve through `findSlot` — see
 *    `primitives.ts`'s TARGETING CAVEAT. A program cannot yet trim plain
 *    placed footage, which is precisely what an editing-first program most
 *    wants to do. Closing it is a `director-api.ts` change (widen those verbs
 *    to `findElement`, as `executeCraftPlan` already does internally), not a
 *    change in this package.
 *  - Dry run is not a simulation. It records what WOULD be called; it does
 *    not model the resulting timeline. Ids minted by `split`/`addClip`/
 *    `addText`/`applyEffect` are `dry-run:` placeholders, and derived-data
 *    accessors keep returning the CURRENT timeline, so a program whose later
 *    decisions depend on earlier edits will produce a faithful op list only
 *    up to its first such dependency. Programs that compute their whole plan
 *    from initial state (the beat-cut shape) dry-run exactly.
 *  - Synchronous only. Every primitive wrapped here is a synchronous
 *    `DirectorApi` verb; nothing in this engine awaits. That is deliberate —
 *    holding an undo transaction across a real `await` is the exact hazard
 *    `withAgentOrigin` documents — and it is why generation verbs are absent
 *    from the primitive set (architecture doc §2 Layer 3 is a later step).
 */

import { CRAFT_EPSILON } from "../craft/types";
import {
	createDerivedDataFunctions,
	listAvailableDerivedAccessors,
	type DerivedDataSources,
} from "./derived-data";
import {
	ProgramBudgetExceededError,
	ProgramError,
	ProgramParseError,
	ProgramPrimitiveError,
	type ProgramCapName,
	type ProgramErrorKind,
} from "./errors";
import { createMeter, type Globals, Interpreter } from "./interpreter";
import {
	DEFAULT_PROGRAM_LIMITS,
	resolveProgramLimits,
	type ProgramLimits,
} from "./limits";
import { parseProgram } from "./parser";
import {
	createPrimitiveFunctions,
	PRIMITIVE_VERBS,
	type ProgramOp,
	type ProgramPrimitiveApi,
} from "./primitives";
import { createStdlibFunctions } from "./stdlib";

export type ProgramRunMode = "dry-run" | "apply";

/**
 * The undo-batching capability, shaped so a `CommandManager` (i.e.
 * `editor.command`) satisfies it with no adapter. Method syntax is deliberate
 * — see `primitives.ts`'s header on bivariance.
 */
export interface ProgramUndoScope {
	beginTransaction(meta?: { origin?: "agent" | "user"; name?: string }): void;
	commitTransaction(): void;
	rollbackTransaction(): void;
}

export interface RunProgramOptions {
	/** The model-authored program text. */
	source: string;
	/**
	 * `"dry-run"` (DEFAULT) records the op list and applies nothing;
	 * `"apply"` executes each primitive against `api` as it is reached. The
	 * default is the safe one on purpose — see threat model point 7.
	 */
	mode?: ProgramRunMode;
	/** The live Director api. Required for `"apply"`; ignored in a dry run. */
	api?: ProgramPrimitiveApi;
	/** Read-only project data the program may consult. Each source is independently optional. */
	data?: DerivedDataSources;
	/** Per-run cap overrides; unset fields keep `DEFAULT_PROGRAM_LIMITS`. */
	limits?: Partial<ProgramLimits>;
	/** Supply `editor.command` to collapse an applied run into one undo entry. Omitted ⇒ each verb keeps its own entry. */
	undo?: ProgramUndoScope;
	/** Undo-entry label. Defaults to {@link DEFAULT_UNDO_NAME}. */
	undoName?: string;
	/** Injectable clock for the wall-clock cap — tests drive it; production omits it. */
	now?: () => number;
}

/** The label an applied run's single undo entry carries. Named for the verb this engine is destined to sit behind (architecture doc §2: "one verb, `applyEdit(program)`"). */
export const DEFAULT_UNDO_NAME = "applyEdit";

/** Structured failure detail — enough for a UI, an agent transcript or a test to branch without parsing `message`. */
export interface ProgramRunFailure {
	kind: ProgramErrorKind | "host";
	message: string;
	/** Parse failures only, 1-based. */
	line?: number;
	column?: number;
	/** Budget failures only — exactly which cap tripped, and its configured value. */
	cap?: ProgramCapName;
	limit?: number;
	/** Primitive failures only — which op in {@link ProgramRunResult.ops} came back `ok: false`. */
	opIndex?: number;
	verb?: string;
}

export interface ProgramRunResult {
	ok: boolean;
	mode: ProgramRunMode;
	/**
	 * Every primitive call the run reached, in order. In a dry run this is the
	 * whole product; in an applied run each entry also carries the verb's own
	 * `{ ok, message }`. Present on FAILURE too — a partial list is how you
	 * learn where a run stopped.
	 */
	ops: ProgramOp[];
	/** Lines the program emitted with `log(…)` — its own account of why. */
	logs: string[];
	/** Plain-language summary, same "self-describing guarded return" discipline as `DirectorResult` (`lib/director/types.ts`). */
	message: string;
	failure?: ProgramRunFailure;
	usage: {
		steps: number;
		loopIterations: number;
		operations: number;
		elapsedMs: number;
	};
}

/**
 * Parse and run one program. NEVER THROWS for anything a program can cause:
 * a parse error, a blown cap, a runtime type error and a failed primitive all
 * come back as `{ ok: false, failure }` with the op log intact — the same
 * guarded-return contract every `DirectorApi` verb keeps, for the same reason
 * (an agent reads results; it does not catch exceptions).
 */
export function runProgram(options: RunProgramOptions): ProgramRunResult {
	const mode: ProgramRunMode = options.mode ?? "dry-run";
	const limits = resolveProgramLimits(options.limits);
	const now = options.now ?? Date.now;
	const started = now();

	const ops: ProgramOp[] = [];
	const logs: string[] = [];
	const meter = createMeter(limits, started);

	const finish = (
		ok: boolean,
		message: string,
		failure?: ProgramRunFailure,
	): ProgramRunResult => ({
		ok,
		mode,
		ops,
		logs,
		message,
		...(failure ? { failure } : {}),
		usage: {
			steps: meter.steps,
			loopIterations: meter.loopIterations,
			operations: meter.operations,
			elapsedMs: now() - started,
		},
	});

	if (mode === "apply" && !options.api) {
		// A host bug, not a program one — fail before anything runs rather than
		// halfway through, when some ops would already be applied.
		return finish(
			false,
			'Cannot run in apply mode without a DirectorApi — pass `api`, or run with mode: "dry-run".',
			{ kind: "host", message: "apply mode requires `api`" },
		);
	}

	const globals: Globals = {
		functions: {
			...createStdlibFunctions({ logs }),
			...createDerivedDataFunctions(options.data ?? {}),
			...createPrimitiveFunctions({
				api: options.api,
				dryRun: mode === "dry-run",
				ops,
				meter,
				limits,
			}),
		},
		// The only ambient values. `EPSILON` is the repo's own `CRAFT_EPSILON`
		// so a program's boundary comparisons agree with `lib/director/craft/*`
		// rather than inventing their own slop.
		constants: { EPSILON: CRAFT_EPSILON },
	};

	// Parse BEFORE opening any undo transaction: a program that doesn't parse
	// must not leave an empty transaction frame open on the command manager.
	let parsed: ReturnType<typeof parseProgram>;
	try {
		parsed = parseProgram(options.source, limits);
	} catch (error) {
		return finish(false, describeError(error), toFailure(error));
	}

	const undo = mode === "apply" ? options.undo : undefined;
	undo?.beginTransaction({
		origin: "agent",
		name: options.undoName ?? DEFAULT_UNDO_NAME,
	});

	try {
		new Interpreter({ globals, limits, meter, now }).run(parsed);
	} catch (error) {
		// See ROLLBACK SEMANTICS in this module's header: this un-registers the
		// history entry, it does not un-apply the ops that already ran.
		undo?.rollbackTransaction();
		return finish(false, describeError(error), toFailure(error));
	}

	undo?.commitTransaction();

	const noun = ops.length === 1 ? "operation" : "operations";
	return finish(
		true,
		mode === "dry-run"
			? `Dry run: ${ops.length} ${noun} planned, nothing applied.`
			: `Applied ${ops.length} ${noun}${undo ? " as one undo step" : ""}.`,
	);
}

/**
 * Names of everything a program could call in the given context — for a
 * prompt, a catalog entry, or an error message. Allocation-only: no api, no
 * execution.
 *
 * `data` lists only the accessors whose sources are actually WIRED here, not
 * every accessor that exists. Telling a model it can call `loudness()` in a
 * context with no decoded audio would be an invitation to write a program
 * that cannot run.
 */
export function describeProgramSurface(data?: DerivedDataSources): {
	primitives: readonly string[];
	data: string[];
	helpers: string[];
	constants: string[];
} {
	const logs: string[] = [];
	return {
		primitives: PRIMITIVE_VERBS,
		data: listAvailableDerivedAccessors(data ?? {}),
		helpers: Object.keys(createStdlibFunctions({ logs })).sort(),
		constants: ["EPSILON"],
	};
}

function toFailure(error: unknown): ProgramRunFailure {
	if (error instanceof ProgramParseError) {
		return {
			kind: error.kind,
			message: error.message,
			line: error.line,
			column: error.column,
		};
	}
	if (error instanceof ProgramBudgetExceededError) {
		return {
			kind: error.kind,
			message: error.message,
			cap: error.cap,
			limit: error.limit,
		};
	}
	if (error instanceof ProgramPrimitiveError) {
		return {
			kind: error.kind,
			message: error.message,
			opIndex: error.opIndex,
			verb: error.verb,
		};
	}
	if (error instanceof ProgramError) {
		return { kind: error.kind, message: error.message };
	}
	// A non-`ProgramError` escaping the interpreter is a HOST bug (a wired
	// source threw, a clone failed). Reported as `"host"` rather than
	// laundered into a program error, so the distinction survives into
	// whatever reads this.
	return {
		kind: "host",
		message: error instanceof Error ? error.message : String(error),
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Re-exported so a caller can reason about the caps without importing `limits.ts` separately. */
export { DEFAULT_PROGRAM_LIMITS };
