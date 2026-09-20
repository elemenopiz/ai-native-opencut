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
 * do; a no-op `push` would not be. `sort`/`sortBy` follow the same rule —
 * each returns a NEW array, the input is never reordered in place.
 *
 * INTROSPECTION (`keys`/`has`). Reading a shape you're not sure of used to
 * mean a dry run: try `c.start`, watch it fail three statements later at an
 * arithmetic op that names neither the field nor the object
 * (`interpreter.ts`'s near-miss rule now catches the TYPO case directly at
 * the read). `keys`/`has` are for the other half — an object that legitimately
 * varies in shape (a non-media element has no `mediaId`) — so a program can
 * ask "does this even have that field" instead of probing it and reading the
 * failure. Both are pure and total: `keys` never throws on a shape it
 * doesn't like because there's no such thing, `has` never throws for a
 * field that doesn't exist because non-existence is exactly what it reports.
 *
 * ARRAY HELPERS (`first`/`last`/`sum`/`contains`/`join`/`sort`/`sortBy`). The
 * same no-closures argument as the module header's opening paragraph, applied
 * to the shapes an editing program actually reaches for: the first/last
 * candidate off a filtered list, a running total, "is this id already
 * spoken for", rendering an id list into a log line, and ordering
 * `clips()`/`beats()`-shaped arrays by a field. `sortBy` takes the field name
 * as a STRING (`sortBy(xs, "startSec")`) rather than a comparator function —
 * there is no function value in this language to pass one, which is exactly
 * why a named two-argument helper has to exist at all.
 */

import { roundSec as craftRoundSec } from "../craft/types";
import { ProgramRuntimeError } from "./errors";
import type { HostFunction } from "./interpreter";
import {
	describeProgramValue,
	isProgramArray,
	isProgramObject,
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

function arr(fn: string, value: ProgramValue, position = 0): ProgramValue[] {
	if (!isProgramArray(value)) {
		throw new ProgramRuntimeError(
			`${fn}() argument ${position + 1} must be an array, got ${describeProgramValue(value)}.`,
		);
	}
	return value;
}

/** A primitive rendered for `join()` — same "only things `+` can concatenate" rule as the interpreter's own string concatenation, so `join` never has to explain a different restriction than `+` already does. */
function joinablePrimitive(value: ProgramValue, index: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return String(value);
	}
	throw new ProgramRuntimeError(
		`join() element ${index} is ${describeProgramValue(value)} — only numbers, strings, booleans and null can be joined.`,
	);
}

/**
 * Check `xs` is entirely numbers or entirely strings — the only two orderable
 * types here — and return which, or throw naming the first offender.
 * `describeAt` renders "where": `sort` says "element 2", `sortBy` says
 * `element 2's "startSec"`, because a field-sort failure that only names the
 * array index makes you go count into the array by hand to see what broke.
 *
 * Validating up front rather than inside the comparator means `Array.sort`
 * itself never sees a value it could quietly coerce with `String()` (its own
 * default behaviour, and exactly the kind of surprise — `[10, 9].sort()`
 * reading `[10, 9]` unsorted — this engine exists to not reproduce): by the
 * time `.sort()` runs, every element is already known to be one comparable
 * type.
 */
function validateOrderable(
	fn: string,
	values: ProgramValue[],
	describeAt: (index: number) => string,
): "number" | "string" {
	const kind = typeof values[0] === "number" ? "number" : "string";
	for (let i = 0; i < values.length; i += 1) {
		const value = values[i];
		if (typeof value !== kind) {
			throw new ProgramRuntimeError(
				i === 0
					? `${fn}() can only order numbers or strings, got ${describeProgramValue(value)} at ${describeAt(i)}.`
					: `${fn}() values are not all ${kind}s — ${describeAt(i)} is ${describeProgramValue(value)}.`,
			);
		}
	}
	return kind;
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

		// -- introspection --

		/** An object's own key names — see this module's header on why this and `has` exist alongside the near-miss rule rather than instead of it. */
		keys: (args) => {
			const value = args[0];
			if (!isProgramObject(value)) {
				throw new ProgramRuntimeError(
					`keys() needs an object, got ${describeProgramValue(value)}.`,
				);
			}
			return Object.keys(value);
		},

		/** Whether `name` is one of `obj`'s own keys — independent of whether its value is truthy, so `has(c, "mediaId")` and `c.mediaId` answer different questions (the field exists vs. it's set to something truthy). */
		has: (args) => {
			const value = args[0];
			if (!isProgramObject(value)) {
				throw new ProgramRuntimeError(
					`has() needs an object as its first argument, got ${describeProgramValue(value)}.`,
				);
			}
			const name = args[1];
			if (typeof name !== "string") {
				throw new ProgramRuntimeError(
					`has() needs a string field name as its second argument, got ${describeProgramValue(name)}.`,
				);
			}
			return Object.hasOwn(value, name);
		},

		// -- array helpers --

		first: (args) => {
			const xs = arr("first", args[0]);
			if (xs.length === 0) {
				throw new ProgramRuntimeError("first() called on an empty array.");
			}
			return xs[0];
		},

		last: (args) => {
			const xs = arr("last", args[0]);
			if (xs.length === 0) {
				throw new ProgramRuntimeError("last() called on an empty array.");
			}
			return xs[xs.length - 1];
		},

		/** `sum([])` is `0` — unlike `min`/`max`, addition has a natural identity element, so an empty array is a real (if boring) answer rather than a missing one. */
		sum: (args) => {
			const xs = arr("sum", args[0]);
			let total = 0;
			for (let i = 0; i < xs.length; i += 1) total += num("sum", xs[i], i);
			return total;
		},

		/** `===` over primitives only — the same restriction the interpreter's own `==`/`!=` puts on comparing objects/arrays (`interpreter.ts`'s `evaluateBinary`), for the identical reason: reference identity across a cloning boundary is not a result anyone could predict. */
		contains: (args) => {
			const xs = arr("contains", args[0]);
			const needle = args[1];
			if (isProgramObject(needle) || isProgramArray(needle)) {
				throw new ProgramRuntimeError(
					`contains() compares numbers, strings, booleans and null — not ${describeProgramValue(needle)}.`,
				);
			}
			return xs.some((item) => item === needle);
		},

		/** Default separator `","`, matching `Array.prototype.join`'s own default — one fewer thing to remember when the rest of this stdlib deliberately does NOT mirror JS array methods. */
		join: (args) => {
			const xs = arr("join", args[0]);
			const sep = args.length > 1 ? args[1] : ",";
			if (typeof sep !== "string") {
				throw new ProgramRuntimeError(
					`join() separator must be a string, got ${describeProgramValue(sep)}.`,
				);
			}
			return xs.map((item, i) => joinablePrimitive(item, i)).join(sep);
		},

		/** Ascending, same-type only. Returns a NEW array — see this module's header. */
		sort: (args) => {
			const xs = arr("sort", args[0]).slice();
			if (xs.length <= 1) return xs;
			const kind = validateOrderable("sort", xs, (i) => `element ${i}`);
			return kind === "number"
				? (xs as number[]).sort((a, b) => a - b)
				: (xs as string[]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		},

		/**
		 * Ascending by `xs[i][field]`, `field` given as a STRING — see this
		 * module's header on why a comparator function isn't the shape here.
		 * Every element must be an object that OWNS `field` (missing it is
		 * reported by index, same spirit as the interpreter's near-miss rule:
		 * name what's wrong and where, don't return a plausible-looking
		 * `undefined` that sorts to one end silently) and every value must be
		 * the same orderable type.
		 */
		sortBy: (args) => {
			const xs = arr("sortBy", args[0]);
			const field = args[1];
			if (typeof field !== "string") {
				throw new ProgramRuntimeError(
					`sortBy() field name must be a string, got ${describeProgramValue(field)}.`,
				);
			}
			const entries = xs.map((item, index) => {
				if (!isProgramObject(item)) {
					throw new ProgramRuntimeError(
						`sortBy() element ${index} is ${describeProgramValue(item)} — sortBy() needs an array of objects.`,
					);
				}
				if (!Object.hasOwn(item, field)) {
					const ownKeys = Object.keys(item);
					throw new ProgramRuntimeError(
						`sortBy() field "${field}" is missing on element ${index}. Its keys: ${
							ownKeys.length > 0 ? ownKeys.join(", ") : "(none)"
						}.`,
					);
				}
				return { item, value: item[field] };
			});
			if (entries.length <= 1) return entries.map((entry) => entry.item);
			const kind = validateOrderable(
				"sortBy",
				entries.map((entry) => entry.value),
				(i) => `element ${i}'s "${field}"`,
			);
			const sorted =
				kind === "number"
					? entries.sort((a, b) => (a.value as number) - (b.value as number))
					: entries.sort((a, b) =>
							(a.value as string) < (b.value as string)
								? -1
								: (a.value as string) > (b.value as string)
									? 1
									: 0,
						);
			return sorted.map((entry) => entry.item);
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
