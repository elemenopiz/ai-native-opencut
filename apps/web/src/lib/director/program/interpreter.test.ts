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
