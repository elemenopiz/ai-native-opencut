/**
 * Interpreter semantics + the sandbox's NEGATIVE SPACE.
 *
 * The security half of this file is the important half. Every case below is
 * an escape a reviewer would reasonably worry about — prototype reach,
 * ambient globals, callable values, unbounded work — and each asserts the
 * engine's answer is a typed refusal rather than an effect. A green run here
 * is the evidence behind `executor.ts`'s threat model; without it the threat
 * model is just prose.
 *
 * Driven through `runProgram` rather than `Interpreter` directly, because
 * that is the surface a caller actually gets and the one an escape would have
 * to come out of.
 */

import { describe, expect, it } from "bun:test";
import { runProgram } from "./executor";

/** Programs observe themselves through `log()`, which the executor collects onto the run result. */
function logs(source: string): string[] {
	const result = runProgram({ source });
	if (!result.ok) throw new Error(result.message);
	return result.logs;
}

function failure(source: string) {
	const result = runProgram({ source });
	expect(result.ok).toBe(false);
	// biome-ignore lint/style/noNonNullAssertion: a failed run always carries one.
	return result.failure!;
}

describe("interpreter — semantics", () => {
	it("evaluates arithmetic, comparison and logical operators", () => {
		expect(logs("log(1 + 2 * 3)")).toEqual(["7"]);
		expect(logs("log(7 % 3)")).toEqual(["1"]);
		expect(logs("log(2 < 3 && 3 <= 3)")).toEqual(["true"]);
		expect(logs("log(!0)")).toEqual(["true"]);
		expect(logs("log(-4)")).toEqual(["-4"]);
		expect(logs('log("a" + 1)')).toEqual(["a1"]);
	});

	it("short-circuits && and ||", () => {
		// If `||` evaluated its right side eagerly the unknown name would throw.
		expect(logs("log(1 || nope)")).toEqual(["1"]);
		expect(logs("log(0 && nope)")).toEqual(["0"]);
	});

	it("scopes `let` per block and per loop iteration", () => {
		expect(
			logs(`
let out = ""
for (x of [1, 2]) {
  let doubled = x * 2
  out = out + doubled
}
log(out)`),
		).toEqual(["24"]);
	});

	it("refuses to assign to an undeclared variable", () => {
		expect(failure("x = 1").message).toContain("never declared");
	});

	it("refuses to redeclare in the same scope", () => {
		expect(failure("let a = 1\nlet a = 2").message).toContain(
			"already declared",
		);
	});

	it("supports member/index reads and nested writes", () => {
		expect(
			logs(`
let bag = { list: [1, 2, 3], nested: { k: "v" } }
bag.list[1] = 20
bag.nested.k = "w"
log(bag.list[1], bag.nested.k, bag.list.length)`),
		).toEqual(["20 w 3"]);
	});

	it("appends at exactly length and refuses a sparse write past it", () => {
		expect(logs("let a = []\na[0] = 1\na[1] = 2\nlog(a.length)")).toEqual([
			"2",
		]);
		expect(failure("let a = []\na[5] = 1").message).toContain("out of range");
	});

	it("iterates a snapshot, so a body cannot extend the array it is walking", () => {
		expect(
			logs(`
let xs = [1, 2]
let n = 0
for (x of xs) {
  xs[len(xs)] = x
  n = n + 1
}
log(n, len(xs))`),
		).toEqual(["2 4"]);
	});

	it("returns undefined for a missing own property but throws on null/undefined", () => {
		expect(logs("let o = { a: 1 }\nlog(o.b)")).toEqual(["undefined"]);
		expect(failure("let o = null\nlog(o.a)").message).toContain("Cannot read");
	});

	it("refuses arithmetic on non-numbers and division by zero", () => {
		expect(failure("let a = {}\nlog(1 + a)").message).toContain(
			"needs two numbers",
		);
		expect(failure("log(1 / 0)").message).toContain("Division by zero");
		expect(failure("log(1 % 0)").message).toContain("Modulo by zero");
	});

	it("refuses to compare objects or arrays for equality", () => {
		expect(failure("log([1] == [1])").message).toContain("compares numbers");
	});

	it("reports every failure as a typed runtime failure, never a throw", () => {
		const result = runProgram({ source: "log(nope)" });
		expect(result.ok).toBe(false);
		expect(result.failure?.kind).toBe("runtime");
	});
});

describe("interpreter — unknown-field reads teach, without breaking optional fields", () => {
	it("returns undefined for a short/unrelated missing key — no near-miss noise below 3 chars", () => {
		// "b" against "a" is edit-distance 1, which would clear almost any
		// budget — this is exactly the false-positive the length floor exists
		// to rule out before distance is even computed.
		expect(logs("let o = { a: 1 }\nlog(o.b)")).toEqual(["undefined"]);
	});

	it("returns undefined for a genuinely optional field with no near neighbor", () => {
		// The `mediaId`-on-a-non-media-element shape from the design doc: the
		// object's real keys are nothing like the probed name.
		expect(
			logs('let c = { id: "t1", type: "text", startSec: 0 }\nlog(c.mediaId)'),
		).toEqual(["undefined"]);
	});

	it("throws naming the field and the near neighbor for the canonical start/startSec typo", () => {
		const failed = failure(
			'let c = { id: "v1", startSec: 0, endSec: 4 }\nlog(c.start)',
		);
		expect(failed.message).toContain('"start"');
		expect(failed.message).toContain('did you mean "startSec"');
		expect(failed.message).toContain("startSec");
		expect(failed.message).toContain("endSec");
	});

	it("catches the same typo shape on the shorter end/endSec pair", () => {
		const failed = failure(
			'let c = { id: "v1", startSec: 0, endSec: 4 }\nlog(c.end)',
		);
		expect(failed.message).toContain('did you mean "endSec"');
	});

	it("catches duration against durationSec", () => {
		const failed = failure("let c = { durationSec: 4 }\nlog(c.duration)");
		expect(failed.message).toContain('did you mean "durationSec"');
	});

	it("does not confuse two honestly different sibling fields for a typo of each other", () => {
		// trimEnd is set, trimStart genuinely is not (an untrimmed head) — the
		// probe must read as "not set", not "you meant the other one".
		expect(
			logs('let c = { id: "v1", trimEnd: 0.5 }\nlog(c.trimStart)'),
		).toEqual(["undefined"]);
	});

	it("does not confuse mediaId with a similarly-shaped sibling id field", () => {
		expect(
			logs('let c = { id: "v1", trackId: "t_video" }\nlog(c.mediaId)'),
		).toEqual(["undefined"]);
	});

	it("applies the same rule through index reads, not just member reads", () => {
		const failed = failure('let c = { startSec: 0 }\nlog(c["start"])');
		expect(failed.message).toContain('did you mean "startSec"');
	});

	it("never throws on an empty object — there is nothing to be near", () => {
		// No keys at all means no candidate can ever clear the near-miss
		// budget, so every probe on `{}` reads as "not set", regardless of
		// how the attempted name is spelled.
		expect(logs("let o = {}\nlog(o.mediaIdentifier)")).toEqual(["undefined"]);
	});
});

describe("interpreter — near-miss tiers, against the real clip shape", () => {
	// The exact key set from the replayed prod failure: `id`, `trackId`,
	// `trackKind`, `kind`, `name`, `startSec`, `durationSec`, `endSec`,
	// `trimStart`, `trimEnd`, `isSlot`, `mediaId`. `kind` is the trap — it is
	// a REAL field, edit-distance 2 from `end`, closer by raw distance than
	// `endSec` (distance 3). Naming it as the suggestion isn't a wrong
	// guess, it is a wrong guess a program has no way to notice, because
	// `kind` is a real key that a `.` read will happily hand back a string
	// from — the exact silent-wrong-answer shape this rule exists to kill.
	const CLIP =
		'{ id: "v1", trackId: "t_video", trackKind: "video", kind: "clip", ' +
		'name: "shot one", startSec: 0, durationSec: 4, endSec: 4, ' +
		'trimStart: 0, trimEnd: 0, isSlot: false, mediaId: "m1" }';

	it("prefers the prefix match endSec over the closer-by-raw-distance kind", () => {
		const failed = failure(`let c = ${CLIP}\nlog(c.end)`);
		expect(failed.message).toContain('did you mean "endSec"');
		// "kind" legitimately appears later, in the "Actual keys" dump — the
		// regression is specifically about the SUGGESTION, so assert the
		// suggestion clause is exactly `"endSec"?`, not `"endSec" or "kind"?`.
		expect(failed.message).toContain('did you mean "endSec"?');
	});

	it("start -> startSec", () => {
		const failed = failure(`let c = ${CLIP}\nlog(c.start)`);
		expect(failed.message).toContain('did you mean "startSec"');
	});

	it("duration -> durationSec", () => {
		const failed = failure(`let c = ${CLIP}\nlog(c.duration)`);
		expect(failed.message).toContain('did you mean "durationSec"');
	});

	it("case-only miss: startsec -> startSec", () => {
		const failed = failure(`let c = ${CLIP}\nlog(c.startsec)`);
		expect(failed.message).toContain('did you mean "startSec"');
	});

	it("case-only miss: trackid -> trackId, not the longer trackKind", () => {
		const failed = failure(`let c = ${CLIP}\nlog(c.trackid)`);
		// Same "check the suggestion clause, not the whole message" reasoning
		// as the `end` case above — "trackKind" also appears in the "Actual
		// keys" dump.
		expect(failed.message).toContain('did you mean "trackId"?');
	});

	it("still returns undefined for a genuine optional probe: mediaId absent", () => {
		const withoutMedia =
			'{ id: "v1", trackId: "t_video", trackKind: "video", kind: "clip", ' +
			'name: "shot one", startSec: 0, durationSec: 4, endSec: 4, ' +
			"trimStart: 0, trimEnd: 0, isSlot: false }";
		expect(logs(`let c = ${withoutMedia}\nlog(c.mediaId)`)).toEqual([
			"undefined",
		]);
	});

	it("still returns undefined for trimStart absent while only trimEnd is set, against the full key set", () => {
		const trimEndOnly =
			'{ id: "v1", trackId: "t_video", trackKind: "video", kind: "clip", ' +
			'name: "shot one", startSec: 0, durationSec: 4, endSec: 4, ' +
			'trimEnd: 0, isSlot: false, mediaId: "m1" }';
		expect(logs(`let c = ${trimEndOnly}\nlog(c.trimStart)`)).toEqual([
			"undefined",
		]);
	});

	it("the suggestion is stable regardless of the object's key insertion order", () => {
		const forwardOrder = CLIP;
		const reversedOrder =
			'{ mediaId: "m1", isSlot: false, trimEnd: 0, trimStart: 0, ' +
			'endSec: 4, durationSec: 4, startSec: 0, name: "shot one", ' +
			'kind: "clip", trackKind: "video", trackId: "t_video", id: "v1" }';

		const forward = failure(`let c = ${forwardOrder}\nlog(c.end)`);
		const reversed = failure(`let c = ${reversedOrder}\nlog(c.end)`);
		expect(forward.message).toContain('did you mean "endSec"');
		expect(reversed.message).toContain('did you mean "endSec"');
	});
});

describe("interpreter — arithmetic on a missed field read points at keys()", () => {
	it("hints at keys() when one side of a numeric op is undefined", () => {
		// `mediaId` is a genuine optional-field probe here (no near neighbor
		// among startSec/trackId), so the member read returns `undefined`
		// rather than throwing, and the failure surfaces one statement later,
		// at the subtraction — exactly the bug-report shape from prod.
		const failed = failure(
			'let c = { startSec: 0, trackId: "t1" }\nlog(c.mediaId - 1)',
		);
		expect(failed.message).toContain("needs two numbers");
		expect(failed.message).toContain("keys(obj)");
	});

	it("does not add the hint when neither side is undefined", () => {
		const failed = failure("let a = {}\nlog(1 + a)");
		expect(failed.message).toContain("needs two numbers");
		expect(failed.message).not.toContain("keys(obj)");
	});
});

describe("interpreter — the sandbox's negative space", () => {
	it("has no ambient globals", () => {
		for (const name of [
			"globalThis",
			"window",
			"process",
			"require",
			"fetch",
			"Object",
			"Array",
			"JSON",
			"Math",
			"Date",
		]) {
			const result = runProgram({ source: `log(${name})` });
			expect(result.ok).toBe(false);
			expect(result.failure?.message).toContain(`Unknown variable "${name}"`);
		}
	});

	it("has no dynamic code construction of any spelling", () => {
		// Built by interpolation rather than written literally so this file
		// itself contains no call to any of them.
		for (const name of ["eval", "Function", "setTimeout", "importScripts"]) {
			const result = runProgram({ source: `${name}("1")` });
			expect(result.ok).toBe(false);
			expect(result.failure?.message).toContain(`Unknown function "${name}"`);
		}
	});

	it("refuses __proto__ / constructor / prototype at EVERY property site", () => {
		const sites = [
			["member read", "let o = {}\nlog(o.__proto__)"],
			["member read (constructor)", "let o = {}\nlog(o.constructor)"],
			["member read (prototype)", "let o = {}\nlog(o.prototype)"],
			["array member read", "let a = []\nlog(a.constructor)"],
			["index read", 'let o = {}\nlog(o["__proto__"])'],
			["object literal key", 'let o = { "__proto__": 1 }'],
			["member assignment", "let o = {}\no.__proto__ = 1"],
			["index assignment", 'let o = {}\no["constructor"] = 1'],
			["nested path read", "let o = { a: {} }\no.a.__proto__ = 1"],
		];
		for (const [name, source] of sites) {
			const result = runProgram({ source });
			expect(`${name}: ${result.ok}`).toBe(`${name}: false`);
			expect(result.failure?.message).toContain(
				"not accessible from a program",
			);
		}
	});

	it("cannot pollute Object.prototype", () => {
		const canary = "__director_program_canary__";
		const result = runProgram({
			source: `let o = {}\no["__proto__"] = { ${canary}: 1 }`,
		});
		expect(result.ok).toBe(false);
		expect(
			(Object.prototype as unknown as Record<string, unknown>)[canary],
		).toBeUndefined();
		expect(({} as unknown as Record<string, unknown>)[canary]).toBeUndefined();
	});

	it("does not expose inherited keys as data", () => {
		// `toString`/`hasOwnProperty` exist on every JS object; a program must
		// see plain `undefined`, not a function it could then try to reach.
		expect(logs("let o = {}\nlog(o.toString)")).toEqual(["undefined"]);
		expect(logs("let o = {}\nlog(o.hasOwnProperty)")).toEqual(["undefined"]);
	});

	it("treats a host function as callable-only, never as a value", () => {
		expect(failure("let f = log").message).toContain("call it as log(…)");
	});

	it("lists the available functions when a program calls an unknown one", () => {
		const message = failure("slice([1], 0)").message;
		expect(message).toContain('Unknown function "slice"');
		expect(message).toContain("trim");
		expect(message).toContain("roundSec");
	});

	it("refuses to iterate a non-array", () => {
		expect(failure("for (x of 5) { }").message).toContain(
			'"for … of" needs an array',
		);
	});
});

describe("interpreter — runtime caps, each naming itself", () => {
	it("caps interpreter steps", () => {
		const result = runProgram({
			source: "let n = 0\nfor (x of [1,2,3,4,5]) { n = n + 1 }",
			limits: { maxSteps: 10 },
		});
		expect(result.failure?.kind).toBe("budget");
		expect(result.failure?.cap).toBe("steps");
		expect(result.failure?.limit).toBe(10);
		expect(result.message).toContain('"steps"');
	});

	it("caps total loop iterations across nested loops", () => {
		const result = runProgram({
			source: `
let xs = [1, 2, 3, 4]
for (a of xs) { for (b of xs) { log(a) } }`,
			limits: { maxLoopIterations: 5, maxSteps: 1_000_000 },
		});
		expect(result.failure?.cap).toBe("loopIterations");
		expect(result.failure?.limit).toBe(5);
	});

	it("caps wall clock on a driven clock", () => {
		// A clock that jumps 10ms per read; the cap is 5ms, so the first
		// loop-iteration check trips it. Deterministic — no race against the
		// host's actual speed.
		let ticks = 0;
		const result = runProgram({
			source: "for (x of [1, 2, 3]) { log(x) }",
			limits: { maxWallClockMs: 5 },
			now: () => {
				ticks += 1;
				return ticks * 10;
			},
		});
		expect(result.failure?.cap).toBe("wallClockMs");
		expect(result.failure?.limit).toBe(5);
	});

	it("keeps the op log and usage counters on a failed run", () => {
		const result = runProgram({
			source: `
trim({ slotId: "a", duration: 1 })
trim({ slotId: "b", duration: 2 })
log(nope)`,
		});
		expect(result.ok).toBe(false);
		expect(result.ops.length).toBe(2);
		expect(result.usage.operations).toBe(2);
		expect(result.usage.steps).toBeGreaterThan(0);
	});

	it("bounds the log buffer instead of letting a loop grow it forever", () => {
		// 10³ = 1000 `log` calls against a 200-line cap.
		const result = runProgram({
			source: `
let xs = []
for (i of [1,2,3,4,5,6,7,8,9,10]) { xs[len(xs)] = i }
for (a of xs) { for (b of xs) { for (c of xs) { log("line", a, b, c) } } }`,
		});
		expect(result.ok).toBe(true);
		expect(result.logs.length).toBe(200);
		expect(result.logs[199]).toContain("further log line(s) dropped");
	});
});
