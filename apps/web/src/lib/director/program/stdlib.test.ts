/**
 * The stdlib additions: `keys`/`has` (introspection) and
 * `first`/`last`/`sum`/`contains`/`join`/`sort`/`sortBy` (the array helpers a
 * no-closures grammar cannot express any other way — see `stdlib.ts`'s
 * header). Driven through `runProgram`, same as `interpreter.test.ts`, so
 * these exercise the real host-function boundary (cloning, the closed
 * `ProgramValue` domain) rather than calling the table directly.
 */

import { describe, expect, it } from "bun:test";
import { runProgram } from "./executor";

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

describe("stdlib — keys / has", () => {
	it("keys() lists an object's own key names", () => {
		expect(logs('let o = { a: 1, b: "two" }\nlog(keys(o))')).toEqual([
			'["a","b"]',
		]);
	});

	it("keys() on an object with no fields is an empty array", () => {
		expect(logs("log(keys({}))")).toEqual(["[]"]);
	});

	it("keys() refuses a non-object", () => {
		expect(failure("keys([1,2])").message).toContain("keys() needs an object");
	});

	it("has() reports presence independent of truthiness", () => {
		expect(
			logs(
				'let c = { mediaId: "", trackId: "t1" }\nlog(has(c, "mediaId"), has(c, "trackId"), has(c, "nope"))',
			),
		).toEqual(["true true false"]);
	});

	it("has() refuses a non-string field name", () => {
		expect(failure("has({}, 1)").message).toContain(
			"needs a string field name",
		);
	});

	it("keys()/has() turn a shape probe into something explicit rather than a silent undefined", () => {
		expect(
			logs(`
let c = { id: "v1", type: "text", startSec: 0 }
if (has(c, "mediaId")) {
  log("has media")
} else {
  log("no media on this element")
}`),
		).toEqual(["no media on this element"]);
	});
});

describe("stdlib — first / last / sum / contains / join", () => {
	it("first()/last() return the ends of the array", () => {
		expect(logs("log(first([3, 1, 2]), last([3, 1, 2]))")).toEqual(["3 2"]);
	});

	it("first()/last() refuse an empty array rather than returning undefined", () => {
		expect(failure("first([])").message).toContain(
			"first() called on an empty array",
		);
		expect(failure("last([])").message).toContain(
			"last() called on an empty array",
		);
	});

	it("sum() totals a numeric array, and sum([]) is 0", () => {
		expect(logs("log(sum([1, 2, 3.5]))")).toEqual(["6.5"]);
		expect(logs("log(sum([]))")).toEqual(["0"]);
	});

	it("sum() names the offending element on a non-number", () => {
		expect(failure('sum([1, "x"])').message).toContain("argument 2");
	});

	it("contains() checks primitive membership", () => {
		expect(logs('log(contains([1,2,3], 2), contains(["a","b"], "z"))')).toEqual(
			["true false"],
		);
	});

	it("contains() refuses a composite needle, same rule as ==", () => {
		expect(failure("contains([1,2], {})").message).toContain(
			"compares numbers, strings, booleans and null",
		);
	});

	it("join() renders primitives with a default comma separator, or a caller-supplied one", () => {
		expect(logs('log(join([1, "a", true, null]))')).toEqual(["1,a,true,null"]);
		expect(logs('log(join(["a", "b", "c"], " / "))')).toEqual(["a / b / c"]);
	});

	it("join() refuses a composite element", () => {
		expect(failure("join([1, {}])").message).toContain("element 1");
	});
});

describe("stdlib — sort / sortBy", () => {
	it("sort() orders numbers ascending and returns a NEW array", () => {
		expect(
			logs(`
let xs = [3, 1, 2]
let sorted = sort(xs)
log(sorted)
log(xs)`),
		).toEqual(["[1,2,3]", "[3,1,2]"]);
	});

	it("sort() orders strings lexicographically, not the JS String() default", () => {
		// The JS `Array.prototype.sort()` default would read [10, 9] here —
		// this is exactly the surprise `sort()`'s type-checked comparator
		// exists to not reproduce, proven on strings where lexicographic and
		// numeric order would otherwise be easy to confuse.
		expect(logs('log(sort(["banana", "apple", "cherry"]))')).toEqual([
			'["apple","banana","cherry"]',
		]);
	});

	it("sort() refuses a mixed-type array, naming the offending element", () => {
		expect(failure('sort([1, "two", 3])').message).toContain("element 1");
	});

	it("sortBy() orders an array of objects by a named field", () => {
		expect(
			logs(`
let clips = [{ id: "b", startSec: 4 }, { id: "a", startSec: 1 }]
for (c of sortBy(clips, "startSec")) { log(c.id) }`),
		).toEqual(["a", "b"]);
	});

	it("sortBy() names the element and the field when it's missing", () => {
		const failed = failure(
			'sortBy([{ startSec: 1 }, { nope: 2 }], "startSec")',
		);
		expect(failed.message).toContain('field "startSec" is missing');
		expect(failed.message).toContain("element 1");
	});

	it("sortBy() takes the field name as a string, not a callable — there is no closure to pass instead", () => {
		expect(failure("sortBy([], 1)").message).toContain(
			"field name must be a string",
		);
	});
});
