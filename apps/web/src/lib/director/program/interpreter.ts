/**
 * {@link Program} → effects. A tree-walking evaluator over the CLOSED node set
 * in `ast.ts`, with every runtime budget from `limits.ts` metered here.
 *
 * The security argument for this file is structural, not defensive:
 *  - Values are the closed {@link ProgramValue} domain (`values.ts`). A script
 *    can never HOLD a function, a class instance, a `Map`, a `Date`, or
 *    anything else with a prototype chain worth walking, so there is nothing
 *    to walk TO.
 *  - Calls are `CallExpr { callee: string }` — a literal NAME looked up in a
 *    host-supplied table. There is no AST shape for "call whatever this
 *    expression evaluates to", so `x.constructor(...)`, `f()()` and
 *    `arr["map"](...)` are not expressible, let alone reachable.
 *  - `__proto__`/`constructor`/`prototype` are refused at EVERY property site
 *    (member read, index read, object-literal key, assignment path) — see
 *    {@link FORBIDDEN_PROPERTY_NAMES}. One unguarded site would be enough to
 *    lose this, which is why the check lives in a single helper used by all
 *    four.
 *  - Reads of a script object use `Object.hasOwn`, so an inherited key
 *    (`toString`, `hasOwnProperty`) is never visible as data.
 *
 * BUDGETS. `steps` ticks once per statement run and once per expression node
 * evaluated; `loopIterations` ticks once per `for` body entry; `wallClockMs`
 * is checked on every loop iteration and every
 * {@link WALL_CLOCK_STEP_INTERVAL} steps (a tight allocation-free loop can
 * burn a lot of steps between two `Date.now()` calls, and `Date.now()` on
 * every step is a measurable tax on a 200k-step budget). `operations` is NOT
 * ticked here — it belongs to the primitive layer, which owns the op log, so
 * the meter is shared rather than duplicated.
 */

import type { Expr, PathStep, Program, Statement } from "./ast";
import { FORBIDDEN_PROPERTY_NAMES } from "./ast";
import { ProgramBudgetExceededError, ProgramRuntimeError } from "./errors";
import type { ProgramLimits } from "./limits";
import {
	cloneProgramValue,
	describeProgramValue,
	isProgramArray,
	isProgramObject,
	type ProgramValue,
	truthy,
} from "./values";

/** How many steps may pass between two wall-clock checks. Small enough that a step-cheap runaway loop still trips the clock promptly; large enough that `Date.now()` isn't the dominant cost of a legitimate run. */
export const WALL_CLOCK_STEP_INTERVAL = 256;

/**
 * A host-provided function a program may call by name. Receives already-
 * evaluated, already-cloned arguments; must return a {@link ProgramValue}
 * (host values outside that domain are a host bug, not a script one).
 * Throwing a {@link ProgramRuntimeError} from here is the correct way to
 * report bad arguments — it surfaces as an ordinary program failure.
 */
export type HostFunction = (args: ProgramValue[]) => ProgramValue;

/**
 * The complete set of names a program can reference that it did not itself
 * declare: host functions (primitives, derived-data accessors, math helpers)
 * and host constants. Anything not in here and not `let`-bound is an
 * undeclared-variable error — there is no ambient global object, no
 * `globalThis`, no `window`.
 */
export interface Globals {
	functions: Record<string, HostFunction>;
	constants: Record<string, ProgramValue>;
}

/** Shared, mutable run budget. `operations` is owned by the primitive layer; everything else by this interpreter. */
export interface ProgramMeter {
	steps: number;
	loopIterations: number;
	operations: number;
	/** `Date.now()` at which the run must stop. */
	deadline: number;
}

export function createMeter(
	limits: ProgramLimits,
	now = Date.now(),
): ProgramMeter {
	return {
		steps: 0,
		loopIterations: 0,
		operations: 0,
		deadline: now + limits.maxWallClockMs,
	};
}

/** Lexical scope chain. `let` declares here; assignment walks up to find an existing binding and never creates one implicitly. */
class Scope {
	private readonly bindings = new Map<string, ProgramValue>();

	constructor(private readonly parent?: Scope) {}

	declare(name: string, value: ProgramValue): void {
		// Redeclaration in the SAME scope is refused: in a program a model wrote
		// and a human is about to read, a silently-shadowed variable is a bug
		// waiting to be misread as intent.
		if (this.bindings.has(name)) {
			throw new ProgramRuntimeError(
				`Variable "${name}" is already declared in this scope.`,
			);
		}
		this.bindings.set(name, value);
	}

	has(name: string): boolean {
		return this.bindings.has(name) || (this.parent?.has(name) ?? false);
	}

	get(name: string): ProgramValue {
		if (this.bindings.has(name)) return this.bindings.get(name) as ProgramValue;
		if (this.parent) return this.parent.get(name);
		throw new ProgramRuntimeError(`Unknown variable "${name}".`);
	}

	set(name: string, value: ProgramValue): void {
		if (this.bindings.has(name)) {
			this.bindings.set(name, value);
			return;
		}
		if (this.parent) {
			this.parent.set(name, value);
			return;
		}
		throw new ProgramRuntimeError(
			`Cannot assign to "${name}" — it was never declared (use "let ${name} = …").`,
		);
	}
}

/** The one place a property name is vetted. Used by member read, index read, object-literal key and every assignment path step — see this module's header for why that matters. */
function assertSafeProperty(name: string): void {
	if (FORBIDDEN_PROPERTY_NAMES.has(name)) {
		throw new ProgramRuntimeError(
			`Property "${name}" is not accessible from a program.`,
		);
	}
}

// -- unknown-field reads ------------------------------------------------------
//
// A read of a key an object does not own is either a TYPO (the field exists,
// spelled differently — `clip.start` when the real field is `startSec`) or a
// genuine OPTIONAL-FIELD PROBE (`if (c.mediaId)` on a clip that has no
// media). Those need opposite answers: a typo left silent surfaces two frames
// later as an arithmetic error naming neither the field nor the object (see
// this package's design doc, §5, row 3) — it must throw, right here, naming
// the field. A probe must return `undefined`, because `mediaId`/`trimStart`/
// `trimEnd` are real, sometimes-absent fields and a program that checks for
// them is doing exactly the right thing; throwing there would make the
// "optional" in "optional field" a lie.
//
// The rule: throw when the attempted key has a near-miss among the object's
// OWN keys (this object, this read — never a schema kept elsewhere); return
// `undefined` when it does not. "Near" is intentionally asymmetric, not a
// flat percentage: `kernel/ids.ts`'s `editDistance` (copied below rather than
// imported — `program/` stays self-contained, see this package's various
// module headers on why) with a budget of HALF the longer string's length,
// and a floor that skips the comparison below three characters altogether.
//
// The floor matters first: almost any two 1–2 character strings sit within a
// couple of edits of each other (`o.b` against a key named `a` is edit
// distance 1), so treating that as a typo would flag unrelated short names
// constantly. Below three characters a missing key is always read as a
// probe.
//
// The half-length budget on the edit-distance FALLBACK is tuned against the
// actual collision this rule has to survive. `startSec`/`endSec`/
// `durationSec` are the real field names behind the `start`/`end`/`duration`
// a model reaches for, and the gap is always the same 3-character `"Sec"`
// suffix — proportionally BIGGER against a short base (`end`, 3 chars,
// distance 3) than a long one (`duration`, 8 chars, distance 3). A flat
// edit-distance budget loose enough to catch `end`→`endSec` unassisted (3
// edits over a 6-char pair — half its length, exactly) is ALSO loose enough
// to call two honestly different sibling fields a typo for each other
// (`trimStart` against `trimEnd` sits 5 edits apart over 9 characters;
// `mediaId` against `trackId` sits 5 over 7) — and, worse, loose enough to
// prefer an UNRELATED short field over the real one: on a real clip's key
// set `end` sits distance 2 from `kind` and distance 3 from `endSec` — raw
// edit distance alone picks `kind`, a real field of the wrong type, and a
// model that trusts the suggestion writes a string into a numeric edit and
// gets a WRONG answer with no error at all. That failure is worse than the
// silent `undefined` this rule exists to replace, which at least surfaces
// downstream.
//
// So edit distance is the LAST tier, not the only one. Three cheaper, more
// specific shapes are checked first, because each one is a stronger, less
// coincidental signal than "close in character count":
//   1. `attempted` is a strict PREFIX of a real key — the dominant real
//      shape (a model reaches for the bare noun; the field carries a unit
//      suffix): `end`→`endSec`, `start`→`startSec`, `duration`→
//      `durationSec`.
//   2. The reverse — a real key is a strict prefix of `attempted`:
//      `startSecond`→`startSec`.
//   3. Case-insensitive equality — same letters, wrong case:
//      `startsec`→`startSec`.
//   4. Edit distance, budgeted as above, for everything not shaped like the
//      first three.
// A tier that finds anything wins outright over every tier below it,
// `kind`'s edit-distance-2 head start over `endSec`'s edit-distance-3 never
// gets a vote once tier 1 has already matched `endSec` as a prefix hit.
//
// Ties within a tier, and the object's key ORDER, must never change the
// answer — a suggestion that depends on `Object.keys` insertion order is not
// a rule, it's a coin flip that happens to be deterministic per-run. Keys
// are sorted before any tier is scanned; a tie is broken by shorter
// candidate length, then alphabetically. When the best two candidates in the
// end-of-the-line edit-distance tier are within one edit of each other, both
// are offered — "did you mean X or Y?" is an honest answer when the rule
// genuinely can't tell, and cheap to compute since the whole candidate list
// is already scored.
const MIN_NEAR_MISS_LENGTH = 3;

/** How many suggestions {@link nearestKeys} will ever return — see the section header on why a genuine near-tie is offered as a pair rather than an arbitrary pick. */
const MAX_SUGGESTIONS = 2;

/** Levenshtein distance. Only ever run over a handful of one object's own key names (see {@link nearestKeys}), so it carries no budget concern of its own. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	let prev = Array.from({ length: cols }, (_, i) => i);
	for (let i = 1; i < rows; i += 1) {
		const next = [i];
		for (let j = 1; j < cols; j += 1) {
			next[j] = Math.min(
				prev[j] + 1,
				next[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = next;
	}
	return prev[cols - 1];
}

/** Deterministic ordering for candidates tied on whatever score got them into a tier: shorter first (the tighter match), then alphabetical — never insertion order. */
function byLengthThenAlpha(a: string, b: string): number {
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** The shortest-and-then-alphabetically-first `count` entries of an already-sorted-by-tier `candidates` list, all tied at the best score in that tier. */
function bestOf(candidates: string[], count: number): string[] {
	return [...candidates].sort(byLengthThenAlpha).slice(0, count);
}

/**
 * The 1–2 keys closest to `attempted`, in confidence order, or `[]` when
 * nothing is close enough to call a typo rather than a coincidence — see the
 * section header above for the tier order and why each one outranks the
 * next.
 */
function nearestKeys(attempted: string, ownKeys: string[]): string[] {
	if (attempted.length < MIN_NEAR_MISS_LENGTH) return [];
	// Sorted once, up front — every tier below reads from this, never from
	// `ownKeys` in its original (insertion) order.
	const keys = [...ownKeys]
		.filter((key) => key.length >= MIN_NEAR_MISS_LENGTH)
		.sort();
	if (keys.length === 0) return [];

	// Tier 1: attempted is a strict prefix of the candidate.
	const forwardPrefix = keys.filter(
		(key) => key.startsWith(attempted) && key.length > attempted.length,
	);
	if (forwardPrefix.length > 0) {
		const shortest = Math.min(...forwardPrefix.map((key) => key.length));
		return bestOf(
			forwardPrefix.filter((key) => key.length === shortest),
			MAX_SUGGESTIONS,
		);
	}

	// Tier 2: the candidate is a strict prefix of attempted.
	const reversePrefix = keys.filter(
		(key) => attempted.startsWith(key) && attempted.length > key.length,
	);
	if (reversePrefix.length > 0) {
		const longest = Math.max(...reversePrefix.map((key) => key.length));
		return bestOf(
			reversePrefix.filter((key) => key.length === longest),
			MAX_SUGGESTIONS,
		);
	}

	// Tier 3: case-insensitive equality.
	const attemptedLower = attempted.toLowerCase();
	const caseInsensitive = keys.filter(
		(key) => key.toLowerCase() === attemptedLower,
	);
	if (caseInsensitive.length > 0) {
		return bestOf(caseInsensitive, MAX_SUGGESTIONS);
	}

	// Tier 4: edit distance, budgeted at half the longer string's length —
	// the fallback for everything not shaped like the first three.
	const scored = keys
		.map((key) => ({
			key,
			distance: editDistance(attempted, key),
			budget: Math.floor(Math.max(attempted.length, key.length) / 2),
		}))
		.filter((entry) => entry.distance <= entry.budget);
	if (scored.length === 0) return [];
	scored.sort(
		(a, b) => a.distance - b.distance || byLengthThenAlpha(a.key, b.key),
	);
	const bestDistance = scored[0].distance;
	// A second candidate is offered only when it is genuinely almost as good
	// — within one more edit than the best — not just because a slot is
	// free.
	return bestOf(
		scored
			.filter((entry) => entry.distance <= bestDistance + 1)
			.map((entry) => entry.key),
		MAX_SUGGESTIONS,
	);
}

/** `"a"` or `"a" or "b"` — how a 1- or 2-item suggestion list reads in the thrown message. */
function formatSuggestions(suggestions: string[]): string {
	return suggestions.map((name) => `"${name}"`).join(" or ");
}

/**
 * Read `property` off a script object, applying the near-miss rule above.
 * Shared by member reads (`o.property`) and index reads with a string key
 * (`o["property"]`) — both hit the identical missing-key question.
 */
function readObjectProperty(
	object: { [key: string]: ProgramValue },
	property: string,
): ProgramValue {
	if (Object.hasOwn(object, property)) return object[property];
	const keys = Object.keys(object);
	const suggestions = nearestKeys(property, keys);
	if (suggestions.length === 0) return undefined;
	throw new ProgramRuntimeError(
		`"${property}" is not a field on this object — did you mean ${formatSuggestions(suggestions)}? Actual keys: ${
			keys.length > 0 ? keys.join(", ") : "(none)"
		}.`,
	);
}

export interface InterpretOptions {
	globals: Globals;
	limits: ProgramLimits;
	meter: ProgramMeter;
	/** Injectable clock for the wall-clock cap. Defaults to `Date.now`; a test drives it so the cap is deterministic rather than a race against the host's speed. */
	now?: () => number;
}

export class Interpreter {
	private readonly globals: Globals;
	private readonly limits: ProgramLimits;
	private readonly meter: ProgramMeter;
	private readonly now: () => number;

	constructor(options: InterpretOptions) {
		this.globals = options.globals;
		this.limits = options.limits;
		this.meter = options.meter;
		this.now = options.now ?? Date.now;
	}

	run(program: Program): void {
		this.runBlock(program.body, new Scope());
	}

	// -- budget --

	private tick(): void {
		this.meter.steps += 1;
		if (this.meter.steps > this.limits.maxSteps) {
			throw new ProgramBudgetExceededError("steps", this.limits.maxSteps);
		}
		if (this.meter.steps % WALL_CLOCK_STEP_INTERVAL === 0) this.checkClock();
	}

	private checkClock(): void {
		if (this.now() > this.meter.deadline) {
			throw new ProgramBudgetExceededError(
				"wallClockMs",
				this.limits.maxWallClockMs,
			);
		}
	}

	// -- statements --

	private runBlock(body: Statement[], scope: Scope): void {
		for (const statement of body) this.runStatement(statement, scope);
	}

	private runStatement(statement: Statement, scope: Scope): void {
		this.tick();
		switch (statement.type) {
			case "LetStatement":
				scope.declare(statement.name, this.evaluate(statement.init, scope));
				return;
			case "AssignStatement":
				this.runAssign(statement.base, statement.path, statement.value, scope);
				return;
			case "IfStatement": {
				if (truthy(this.evaluate(statement.test, scope))) {
					this.runBlock(statement.consequent, new Scope(scope));
				} else if (statement.alternate) {
					this.runBlock(statement.alternate, new Scope(scope));
				}
				return;
			}
			case "ForOfStatement":
				this.runForOf(statement, scope);
				return;
			case "ExprStatement":
				this.evaluate(statement.expr, scope);
				return;
		}
	}

	private runForOf(
		statement: Extract<Statement, { type: "ForOfStatement" }>,
		scope: Scope,
	): void {
		const iterable = this.evaluate(statement.iterable, scope);
		if (!isProgramArray(iterable)) {
			throw new ProgramRuntimeError(
				`"for … of" needs an array to iterate, got ${describeProgramValue(iterable)}.`,
			);
		}
		// Iterate a SNAPSHOT of the array taken before the body runs. The body
		// may legitimately push onto some other array; it must not be able to
		// extend the one it is iterating into an unbounded loop (the
		// loop-iteration cap would catch that, but failing a run on a budget is
		// a worse explanation than simply having well-defined semantics).
		const items = iterable.slice();
		for (let index = 0; index < items.length; index += 1) {
			this.meter.loopIterations += 1;
			if (this.meter.loopIterations > this.limits.maxLoopIterations) {
				throw new ProgramBudgetExceededError(
					"loopIterations",
					this.limits.maxLoopIterations,
				);
			}
			this.checkClock();
			// Fresh scope per iteration: a body's `let` must not collide with
			// itself on the next pass, and the loop bindings are loop-local.
			const iterationScope = new Scope(scope);
			if (statement.indexName !== undefined) {
				iterationScope.declare(statement.indexName, index);
			}
			iterationScope.declare(statement.itemName, items[index]);
			this.runBlock(statement.body, iterationScope);
		}
	}

	private runAssign(
		base: string,
		path: PathStep[],
		valueExpr: Expr,
		scope: Scope,
	): void {
		const value = this.evaluate(valueExpr, scope);
		if (path.length === 0) {
			scope.set(base, value);
			return;
		}
		// Walk to the container holding the FINAL step, then write through it.
		// Intermediate steps must already exist — a program never auto-vivifies
		// a path, because a typo that silently creates `a.b.c` is exactly the
		// kind of "did something, just not what you meant" failure that makes a
		// dry-run list unreadable.
		let container: ProgramValue = scope.get(base);
		for (let i = 0; i < path.length - 1; i += 1) {
			container = this.readStep(container, path[i], scope, base);
		}
		const last = path[path.length - 1];
		if (last.kind === "member") {
			assertSafeProperty(last.property);
			if (!isProgramObject(container)) {
				throw new ProgramRuntimeError(
					`Cannot set property "${last.property}" on ${describeProgramValue(container)}.`,
				);
			}
			container[last.property] = value;
			return;
		}
		const index = this.evaluate(last.index, scope);
		if (isProgramArray(container)) {
			if (typeof index !== "number" || !Number.isInteger(index)) {
				throw new ProgramRuntimeError(
					`Array index must be a whole number, got ${describeProgramValue(index)}.`,
				);
			}
			// In range, or exactly one past the end (append). A sparse write at
			// an arbitrary index would let `a[1e9] = 1` allocate for free.
			if (index < 0 || index > container.length) {
				throw new ProgramRuntimeError(
					`Array index ${index} is out of range (length ${container.length}).`,
				);
			}
			container[index] = value;
			return;
		}
		if (isProgramObject(container)) {
			const key = String(index);
			assertSafeProperty(key);
			container[key] = value;
			return;
		}
		throw new ProgramRuntimeError(
			`Cannot index-assign into ${describeProgramValue(container)}.`,
		);
	}

	private readStep(
		container: ProgramValue,
		step: PathStep,
		scope: Scope,
		baseName: string,
	): ProgramValue {
		if (step.kind === "member") {
			assertSafeProperty(step.property);
			if (!isProgramObject(container)) {
				throw new ProgramRuntimeError(
					`Cannot read "${step.property}" while assigning into "${baseName}" — ${describeProgramValue(container)} is not an object.`,
				);
			}
			return container[step.property];
		}
		return this.readIndex(container, this.evaluate(step.index, scope));
	}

	// -- expressions --

	private evaluate(expr: Expr, scope: Scope): ProgramValue {
		this.tick();
		switch (expr.type) {
			case "NumberLiteral":
			case "StringLiteral":
			case "BooleanLiteral":
				return expr.value;
			case "NullLiteral":
				return null;
			case "Identifier":
				return this.evaluateIdentifier(expr.name, scope);
			case "ArrayLiteral":
				return expr.elements.map((element) => this.evaluate(element, scope));
			case "ObjectLiteral": {
				const out: { [key: string]: ProgramValue } = {};
				for (const { key, value } of expr.properties) {
					assertSafeProperty(key);
					out[key] = this.evaluate(value, scope);
				}
				return out;
			}
			case "MemberExpr": {
				assertSafeProperty(expr.property);
				return this.readMember(
					this.evaluate(expr.object, scope),
					expr.property,
				);
			}
			case "IndexExpr":
				return this.readIndex(
					this.evaluate(expr.object, scope),
					this.evaluate(expr.index, scope),
				);
			case "CallExpr":
				return this.evaluateCall(expr.callee, expr.args, scope);
			case "UnaryExpr": {
				const value = this.evaluate(expr.argument, scope);
				if (expr.op === "!") return !truthy(value);
				if (typeof value !== "number") {
					throw new ProgramRuntimeError(
						`Unary "-" needs a number, got ${describeProgramValue(value)}.`,
					);
				}
				return -value;
			}
			case "BinaryExpr":
				return this.evaluateBinary(
					expr.op,
					this.evaluate(expr.left, scope),
					this.evaluate(expr.right, scope),
				);
			case "LogicalExpr": {
				const left = this.evaluate(expr.left, scope);
				if (expr.op === "&&") {
					return truthy(left) ? this.evaluate(expr.right, scope) : left;
				}
				return truthy(left) ? left : this.evaluate(expr.right, scope);
			}
		}
	}

	private evaluateIdentifier(name: string, scope: Scope): ProgramValue {
		if (scope.has(name)) return scope.get(name);
		if (Object.hasOwn(this.globals.constants, name)) {
			return cloneProgramValue(this.globals.constants[name]);
		}
		if (Object.hasOwn(this.globals.functions, name)) {
			// Host functions are callable, not first-class: there is nowhere for a
			// function VALUE to go in this language (see `values.ts`), so naming
			// one without calling it is a mistake worth reporting rather than a
			// value worth producing.
			throw new ProgramRuntimeError(
				`"${name}" is a function — call it as ${name}(…) rather than using it as a value.`,
			);
		}
		throw new ProgramRuntimeError(`Unknown variable "${name}".`);
	}

	private evaluateCall(
		callee: string,
		args: Expr[],
		scope: Scope,
	): ProgramValue {
		const fn = Object.hasOwn(this.globals.functions, callee)
			? this.globals.functions[callee]
			: undefined;
		if (!fn) {
			// Names the closed alternative set rather than just refusing: a model
			// that reached for `slice()` should be able to see what does exist.
			throw new ProgramRuntimeError(
				`Unknown function "${callee}". Available: ${Object.keys(this.globals.functions).sort().join(", ")}.`,
			);
		}
		// Clone on the way IN so a host function can never be handed a live
		// reference into the script's own memory (and on the way OUT so the
		// reverse also holds) — the two-sided isolation `cloneProgramValue`'s
		// doc describes.
		const evaluated = args.map((arg) =>
			cloneProgramValue(this.evaluate(arg, scope)),
		);
		return cloneProgramValue(fn(evaluated));
	}

	private readMember(object: ProgramValue, property: string): ProgramValue {
		if (object === null || object === undefined) {
			throw new ProgramRuntimeError(
				`Cannot read "${property}" of ${object === null ? "null" : "undefined"}.`,
			);
		}
		if (isProgramArray(object)) {
			if (property === "length") return object.length;
			throw new ProgramRuntimeError(
				`Arrays have no "${property}" — use .length, an index, a helper like len()/append(), or append in place with a[len(a)] = value.`,
			);
		}
		if (typeof object === "string") {
			if (property === "length") return object.length;
			throw new ProgramRuntimeError(`Strings have no "${property}".`);
		}
		if (isProgramObject(object)) {
			// `hasOwn`-gated inside `readObjectProperty`, never a plain read: an
			// inherited key must never be visible as data.
			return readObjectProperty(object, property);
		}
		throw new ProgramRuntimeError(
			`Cannot read "${property}" of ${describeProgramValue(object)}.`,
		);
	}

	private readIndex(object: ProgramValue, index: ProgramValue): ProgramValue {
		if (object === null || object === undefined) {
			throw new ProgramRuntimeError(
				`Cannot index ${object === null ? "null" : "undefined"}.`,
			);
		}
		if (isProgramArray(object) || typeof object === "string") {
			if (typeof index !== "number" || !Number.isInteger(index)) {
				throw new ProgramRuntimeError(
					`Index must be a whole number, got ${describeProgramValue(index)}.`,
				);
			}
			if (index < 0 || index >= object.length) return undefined;
			return object[index];
		}
		if (isProgramObject(object)) {
			if (typeof index !== "string" && typeof index !== "number") {
				throw new ProgramRuntimeError(
					`Object key must be a string or number, got ${describeProgramValue(index)}.`,
				);
			}
			const key = String(index);
			assertSafeProperty(key);
			return readObjectProperty(object, key);
		}
		throw new ProgramRuntimeError(
			`Cannot index ${describeProgramValue(object)}.`,
		);
	}

	private evaluateBinary(
		op: Extract<Expr, { type: "BinaryExpr" }>["op"],
		left: ProgramValue,
		right: ProgramValue,
	): ProgramValue {
		const leftIsComposite = isProgramObject(left) || isProgramArray(left);
		const rightIsComposite = isProgramObject(right) || isProgramArray(right);

		if (op === "==" || op === "!=") {
			// Only primitives compare. Comparing two objects/arrays in JS is
			// reference identity, which in a cloning interpreter means "almost
			// always false" — a result no author would predict, so it is refused
			// instead of silently answered.
			if (leftIsComposite || rightIsComposite) {
				throw new ProgramRuntimeError(
					`"${op}" compares numbers, strings, booleans and null — not ${describeProgramValue(leftIsComposite ? left : right)}.`,
				);
			}
			const equal = left === right;
			return op === "==" ? equal : !equal;
		}

		if (op === "+" && (typeof left === "string" || typeof right === "string")) {
			if (leftIsComposite || rightIsComposite) {
				throw new ProgramRuntimeError(
					`Cannot concatenate a string with ${describeProgramValue(leftIsComposite ? left : right)}.`,
				);
			}
			return `${stringify(left)}${stringify(right)}`;
		}

		return numericOp(op, left, right);
	}
}

/** Value→string for `+` concatenation. Deliberately narrow: only primitives ever reach here (composites are refused above). */
function stringify(value: ProgramValue): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	return String(value);
}

function numericOp(
	op: string,
	left: ProgramValue,
	right: ProgramValue,
): ProgramValue {
	if (typeof left !== "number" || typeof right !== "number") {
		// `undefined` reaching arithmetic is, in practice, almost always a field
		// read that missed — and by the time it gets here the read itself is a
		// statement or two back, so the message needs to point somewhere rather
		// than just restate the symptom.
		const hint =
			left === undefined || right === undefined
				? " A field read that came back undefined usually means a missing or misspelled key — check the object's real keys with keys(obj)."
				: "";
		throw new ProgramRuntimeError(
			`"${op}" needs two numbers, got ${describeProgramValue(left)} and ${describeProgramValue(right)}.${hint}`,
		);
	}
	switch (op) {
		case "+":
			return left + right;
		case "-":
			return left - right;
		case "*":
			return left * right;
		case "/":
			// Division by zero yields Infinity in JS and then silently poisons
			// every downstream time value. A program doing arithmetic on a
			// timeline should hear about it at the division, not three trims
			// later when a clip lands at NaN seconds.
			if (right === 0) throw new ProgramRuntimeError("Division by zero.");
			return left / right;
		case "%":
			if (right === 0) throw new ProgramRuntimeError("Modulo by zero.");
			return left % right;
		case "<":
			return left < right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		case ">=":
			return left >= right;
		default:
			throw new ProgramRuntimeError(`Unsupported operator "${op}".`);
	}
}
