/**
 * Grammar tests. Two jobs, and the second matters more than the first:
 *  1. The shapes a real program needs actually parse.
 *  2. The shapes the whitelist deliberately EXCLUDES do not — `while`,
 *     `function`, `new`, method calls, spread, template strings, regex,
 *     `try`/`catch`, `break`. Each of those is a class of interpreter bug
 *     this engine gets to not have, and a test is the only thing that keeps
 *     someone from "just adding one" later without reading `ast.ts`'s header.
 */

import { describe, expect, it } from "bun:test";
import { ProgramBudgetExceededError, ProgramParseError } from "./errors";
import { resolveProgramLimits, type ProgramLimits } from "./limits";
import { parseProgram } from "./parser";

function parse(source: string, overrides?: Partial<ProgramLimits>) {
	return parseProgram(source, resolveProgramLimits(overrides));
}

describe("parseProgram — what the grammar accepts", () => {
	it("parses let / assignment / if / for / calls / literals", () => {
		const program = parse(`
let xs = [1, 2, 3]
let total = 0
for (i, x of xs) {
  if (x % 2 == 0 && i > 0) {
    total = total + x
  } else {
    total = total - x
  }
}
let bag = { a: 1, "b": "two", c: true, d: null }
bag.a = total
bag["b"] = "three"
xs[0] = 9
log(total)
`);
		expect(program.type).toBe("Program");
		expect(program.body.length).toBe(8);
	});

	it("treats semicolons as optional and stray ones as no-ops", () => {
		// let a / let b / let c, plus one empty statement for the stray `;`.
		expect(parse("let a = 1; let b = 2\nlet c = 3;;").body.length).toBe(4);
	});

	it("accepts both `for (x of xs)` and `for (let x of xs)`", () => {
		expect(parse("for (x of []) { }").body.length).toBe(1);
		expect(parse("for (let x of []) { }").body.length).toBe(1);
	});

	it("chains else-if without requiring braces on the inner if", () => {
		const program = parse("if (1) { } else if (2) { } else { }");
		expect(program.body[0].type).toBe("IfStatement");
	});

	it("supports line and block comments", () => {
		expect(
			parse("// hi\nlet a = 1 /* mid */ + 2\n/* tail */").body.length,
		).toBe(1);
	});

	it("reads `[` on a fresh line as a new array literal, not an index of the line above", () => {
		// The one place optional semicolons could misparse silently. `b` must
		// stay an identifier read, and the array must be its own statement.
		const program = parse("let a = 1\nlet b = a\n[1, 2]");
		expect(program.body.length).toBe(3);
		expect(program.body[2].type).toBe("ExprStatement");
	});
});

describe("parseProgram — what the whitelist excludes", () => {
	const rejected: Array<[string, string]> = [
		["while loops", "while (true) { }"],
		["function declarations", "function f() { }"],
		["arrow functions", "let f = () => 1"],
		["new", "let x = new Thing()"],
		["method calls", "let x = xs.map(f)"],
		["computed calls", "let x = fns[0]()"],
		["call on a call", "let x = f()()"],
		["spread", "let x = [...xs]"],
		["template strings", "let x = `hi`"],
		["regex literals", "let x = /a/"],
		["try/catch", "try { } catch (e) { }"],
		["break", "for (x of xs) { break }"],
		["continue", "for (x of xs) { continue }"],
		["return", "return 1"],
		["import", 'import x from "y"'],
		["await", "let x = await f()"],
		["typeof", "let x = typeof y"],
		["ternary", "let x = a ? b : c"],
		["increment", "let x = 0\nx++"],
		["compound assignment", "let x = 0\nx += 1"],
		["bitwise ops", "let x = 1 & 2"],
		["assigning to a call result", "f() = 1"],
	];

	for (const [name, source] of rejected) {
		it(`rejects ${name}`, () => {
			expect(() => parse(source)).toThrow(ProgramParseError);
		});
	}

	it("reports a 1-based line and column", () => {
		try {
			parse("let a = 1\nlet b = @");
			throw new Error("expected a parse error");
		} catch (error) {
			expect(error).toBeInstanceOf(ProgramParseError);
			const parseError = error as ProgramParseError;
			expect(parseError.line).toBe(2);
			expect(parseError.column).toBe(9);
			expect(parseError.kind).toBe("parse");
		}
	});

	it("rejects an unterminated string and an unterminated block comment", () => {
		expect(() => parse('let a = "oops')).toThrow(ProgramParseError);
		expect(() => parse("/* oops")).toThrow(ProgramParseError);
	});
});

describe("parseProgram — parse-time caps", () => {
	it("rejects an over-long source before tokenizing, naming the cap", () => {
		try {
			parse("let a = 1", { maxSourceLength: 4 });
			throw new Error("expected a budget error");
		} catch (error) {
			expect(error).toBeInstanceOf(ProgramBudgetExceededError);
			expect((error as ProgramBudgetExceededError).cap).toBe("sourceLength");
			expect((error as ProgramBudgetExceededError).limit).toBe(4);
		}
	});

	it("caps AST node count", () => {
		try {
			parse("let a = 1 + 2 + 3 + 4 + 5 + 6", { maxAstNodes: 5 });
			throw new Error("expected a budget error");
		} catch (error) {
			expect((error as ProgramBudgetExceededError).cap).toBe("astNodes");
		}
	});

	it("caps block nesting depth", () => {
		try {
			parse("if (1) { if (1) { if (1) { log(1) } } }", { maxNestingDepth: 2 });
			throw new Error("expected a budget error");
		} catch (error) {
			expect((error as ProgramBudgetExceededError).cap).toBe("nestingDepth");
		}
	});

	it("caps expression nesting depth independently of block depth", () => {
		try {
			parse("let a = ((((((1))))))", { maxNestingDepth: 3 });
			throw new Error("expected a budget error");
		} catch (error) {
			expect((error as ProgramBudgetExceededError).cap).toBe("nestingDepth");
		}
	});
});
