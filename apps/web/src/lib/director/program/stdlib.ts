/**
 * The program language's standard library: pure, total, side-effect-free
 * helpers plus one diagnostic sink (`log`).
 *
 * WHY THESE AND NOT MORE. The grammar has no method-call syntax (`xs.map(…)`)
 * and no closures, by design (`ast.ts`'s header) — so anything array-shaped
 * has to arrive as a named function or not at all. The set below is the
 * minimum that lets a real editing program be written without them: absolute
 * value and min/max for "nearest beat", rounding for emitting stable seconds,
 * `len`/`append` for building an op list, and `log` so a dry-run can explain
 * its own reasoning back to a human. Everything else a program needs is
 * ordinary arithmetic and `for`.
 *
 * NO MUTATING HELPERS. Every value crossing into a host function is cloned
 * (`interpreter.ts`'s `evaluateCall`), so a `push(xs, v)` could only ever
 * mutate a copy and silently do nothing. `append(xs, v)` returns a NEW array
 * instead, and in-place growth is spelled `xs[len(xs)] = v` (the interpreter
 * allows an index write at exactly `length`). Both are honest about what they
 * do; a no-op `push` would not be.
 */

import { roundSec as craftRoundSec } from "../craft/types";
import { ProgramRuntimeError } from "./errors";
import type { HostFunction } from "./interpreter";
import {
	describeProgramValue,
	isProgramArray,
	type ProgramValue,
} from "./values";

function num(fn: string, value: ProgramValue, position: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ProgramRuntimeError(
			`${fn}() argument ${position + 1} must be a finite number, got ${describeProgramValue(value)}.`,
		);
	}
	return value;
}

/** `min(a, b, …)` or `min(arrayOfNumbers)` — both spellings, because a program that just read `beats()` has an array and a program comparing two candidates has scalars. */
function reducer(
	fn: string,
	pick: (a: number, b: number) => number,
): HostFunction {
	return (args) => {
		const values =
			args.length === 1 && isProgramArray(args[0])
				? (args[0] as ProgramValue[])
				: args;
		if (values.length === 0) {
			throw new ProgramRuntimeError(`${fn}() needs at least one number.`);
		}
		let best = num(fn, values[0], 0);
		for (let i = 1; i < values.length; i += 1) {
			best = pick(best, num(fn, values[i], i));
		}
		return best;
	};
}

export interface StdlibOptions {
	/** Sink for `log(…)`. The executor owns the array so the lines ride back on the run result. */
	logs: string[];
	/** Hard cap on retained log lines — a program inside a 50k-iteration loop must not be able to grow an unbounded string buffer. */
	maxLogLines?: number;
}

export const DEFAULT_MAX_LOG_LINES = 200;

export function createStdlibFunctions(
	options: StdlibOptions,
): Record<string, HostFunction> {
	const maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
	let dropped = 0;

	return {
		abs: (args) => Math.abs(num("abs", args[0], 0)),
		floor: (args) => Math.floor(num("floor", args[0], 0)),
		ceil: (args) => Math.ceil(num("ceil", args[0], 0)),
		round: (args) => Math.round(num("round", args[0], 0)),
		sqrt: (args) => {
			const value = num("sqrt", args[0], 0);
			if (value < 0) {
				throw new ProgramRuntimeError("sqrt() of a negative number.");
			}
			return Math.sqrt(value);
		},
		min: reducer("min", Math.min),
		max: reducer("max", Math.max),
		clamp: (args) => {
			const value = num("clamp", args[0], 0);
			const low = num("clamp", args[1], 1);
			const high = num("clamp", args[2], 2);
			if (low > high) {
				throw new ProgramRuntimeError(
					`clamp(): low (${low}) is greater than high (${high}).`,
				);
			}
			return Math.min(high, Math.max(low, value));
		},

		/**
		 * The repo's own `craft/types.ts` rounding — 1e-6 precision — so a
		 * program's emitted seconds carry exactly the float noise the craft
		 * macros' do, and a program/macro comparison is an equality test rather
		 * than an epsilon dance.
		 */
		roundSec: (args) => craftRoundSec(num("roundSec", args[0], 0)),

		len: (args) => {
			const value = args[0];
			if (isProgramArray(value)) return value.length;
			if (typeof value === "string") return value.length;
			throw new ProgramRuntimeError(
				`len() needs an array or string, got ${describeProgramValue(value)}.`,
			);
		},

		/** Returns a NEW array with `value` appended — see this module's header on why nothing here mutates. */
		append: (args) => {
			const array = args[0];
			if (!isProgramArray(array)) {
				throw new ProgramRuntimeError(
					`append() needs an array as its first argument, got ${describeProgramValue(array)}.`,
				);
			}
			return [...array, args[1]];
		},

		/**
		 * Diagnostic line for the run result. The whole point of a dry-run is a
		 * human reading what the program MEANT to do; `log("held shot 3 long
		 * against the grid")` is how a program says why, next to the op list
		 * that says what.
		 */
		log: (args) => {
			if (options.logs.length >= maxLogLines) {
				dropped += 1;
				// Replace the last line rather than appending, so the cap holds
				// exactly and the reader still learns the tail was cut.
				options.logs[maxLogLines - 1] =
					`…${dropped} further log line(s) dropped (cap ${maxLogLines}).`;
				return null;
			}
			options.logs.push(args.map(formatLogValue).join(" "));
			return null;
		},
	};
}

/** Compact, bounded rendering of a logged value — never dumps a whole beat grid into the transcript. */
function formatLogValue(value: ProgramValue): string {
	if (typeof value === "string") return value;
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	const json = JSON.stringify(value);
	return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
