/**
 * Text → {@link Program}. The ONLY way a model-authored string becomes
 * something this package will interpret.
 *
 * WHY A HAND-WRITTEN PARSER AND NOT `JSON.parse` OF AN AST, OR A JS PARSER:
 *  - Accepting an AST as JSON would push the grammar's surface onto the model
 *    (it would have to emit node shapes correctly) AND leave us validating an
 *    arbitrary object graph anyway. Parsing text is less code and the
 *    validation is structural: a shape the grammar can't spell simply has no
 *    token sequence that produces it.
 *  - Reusing a real JS parser (acorn/meriyah/`Function`) would hand us the
 *    WHOLE language and make safety a matter of subtracting node kinds — a
 *    denylist, and denylists on a language this big are how sandboxes leak.
 *    Here the whitelist IS the parser: there is no production for `while`,
 *    `function`, `new`, `x.f()`, `import`, spread, template strings or regex,
 *    so no input text can produce them (see `ast.ts`'s header).
 *
 * PARSE-TIME BUDGETS (`limits.ts`): source length, AST node count and nesting
 * depth are all checked HERE, before the interpreter sees anything — a
 * pathological document (10MB of text, 100k nodes, 500-deep nesting) costs
 * memory and parser stack even if it would never execute a single step. Each
 * failure throws {@link ProgramBudgetExceededError} naming the cap; a merely
 * malformed program throws {@link ProgramParseError} with a 1-based line and
 * column.
 *
 * Both `blockDepth` (nested `if`/`for` bodies) and `exprDepth` (nested
 * parens/unary/call args) are capped independently against
 * `maxNestingDepth`, because each one bounds a different arm of this parser's
 * — and later the interpreter's — own recursion. Never let the SCRIPT choose
 * how deep our call stack goes.
 */

import type { Expr, PathStep, Program, Statement, UnaryOp } from "./ast";
import { ProgramBudgetExceededError, ProgramParseError } from "./errors";
import { DEFAULT_PROGRAM_LIMITS, type ProgramLimits } from "./limits";

// ---- Tokenizer --------------------------------------------------------------

type TokenType = "number" | "string" | "ident" | "keyword" | "punct" | "eof";

interface Token {
	type: TokenType;
	/** Raw lexeme for `ident`/`keyword`/`punct`; the DECODED value for `number`/`string`. */
	value: string;
	numberValue?: number;
	line: number;
	column: number;
	/** True when a line break separates this token from the previous one — used to stop `[` on a fresh line from being read as an index of the line above. */
	newlineBefore: boolean;
}

const KEYWORDS = new Set([
	"let",
	"if",
	"else",
	"for",
	"of",
	"true",
	"false",
	"null",
]);

/**
 * JS keywords this grammar deliberately does NOT implement. Without this set
 * they would tokenize as ordinary identifiers and parse into something
 * plausible-looking but wrong — `while (c) { }` becomes a call to a function
 * named `while` followed by an object literal, and the author learns about it
 * as a confusing runtime error three layers down. Rejecting them by name at
 * the tokenizer turns "this keyword does not exist here" into exactly that
 * message, at the right line.
 *
 * Consequence, accepted deliberately: a reserved word cannot be used as an
 * object key or property name either (`{ class: 1 }`, `x.default`). No field
 * in the Director's data or verb surface is spelled like a JS keyword, and
 * the clarity is worth more than the generality.
 */
const RESERVED_WORDS = new Set([
	"var",
	"const",
	"function",
	"return",
	"while",
	"do",
	"switch",
	"case",
	"default",
	"break",
	"continue",
	"new",
	"class",
	"extends",
	"super",
	"this",
	"try",
	"catch",
	"finally",
	"throw",
	"import",
	"export",
	"async",
	"await",
	"yield",
	"typeof",
	"instanceof",
	"in",
	"delete",
	"void",
	"with",
	"debugger",
	"static",
]);

/**
 * Longest-first so `<=` never tokenizes as `<` then `=`, and `==` never as two
 * assignments. `=` and `!` stay in the list as their own one-char tokens
 * (assignment, logical not).
 */
const PUNCTUATION = [
	"&&",
	"||",
	"==",
	"!=",
	"<=",
	">=",
	"(",
	")",
	"{",
	"}",
	"[",
	"]",
	",",
	".",
	":",
	";",
	"=",
	"<",
	">",
	"+",
	"-",
	"*",
	"/",
	"%",
	"!",
];

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_$]/.test(ch);
}
function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_$]/.test(ch);
}
function isDigit(ch: string): boolean {
	return ch >= "0" && ch <= "9";
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	let line = 1;
	let lineStart = 0;
	let pendingNewline = false;

	const column = () => i - lineStart + 1;
	const fail = (message: string): never => {
		throw new ProgramParseError(message, line, column());
	};

	while (i < source.length) {
		const ch = source[i];

		// Whitespace / newlines.
		if (ch === "\n") {
			i += 1;
			line += 1;
			lineStart = i;
			pendingNewline = true;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			i += 1;
			continue;
		}

		// Comments. Both forms are supported because model-authored programs
		// routinely carry them, and a comment the grammar rejected would be a
		// gratuitous parse failure on otherwise-valid intent.
		if (ch === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const openLine = line;
			const openColumn = column();
			i += 2;
			let closed = false;
			while (i < source.length) {
				if (source[i] === "*" && source[i + 1] === "/") {
					i += 2;
					closed = true;
					break;
				}
				if (source[i] === "\n") {
					line += 1;
					lineStart = i + 1;
					pendingNewline = true;
				}
				i += 1;
			}
			if (!closed) {
				throw new ProgramParseError(
					"unterminated block comment",
					openLine,
					openColumn,
				);
			}
			continue;
		}

		const startColumn = column();
		const newlineBefore = pendingNewline;
		pendingNewline = false;

		// Numbers — decimal only (no hex/octal/binary/exponent-less-dot forms,
		// no numeric separators). A narrow literal syntax means no surprising
		// coercion and nothing for a reader to misjudge at a glance.
		if (isDigit(ch) || (ch === "." && isDigit(source[i + 1] ?? ""))) {
			const start = i;
			while (i < source.length && isDigit(source[i])) i += 1;
			if (source[i] === ".") {
				i += 1;
				while (i < source.length && isDigit(source[i])) i += 1;
			}
			if (source[i] === "e" || source[i] === "E") {
				const save = i;
				i += 1;
				if (source[i] === "+" || source[i] === "-") i += 1;
				if (!isDigit(source[i] ?? "")) {
					i = save;
				} else {
					while (i < source.length && isDigit(source[i])) i += 1;
				}
			}
			const text = source.slice(start, i);
			const value = Number(text);
			if (!Number.isFinite(value)) fail(`invalid number literal "${text}"`);
			tokens.push({
				type: "number",
				value: text,
				numberValue: value,
				line,
				column: startColumn,
				newlineBefore,
			});
			continue;
		}

		// Strings — single or double quoted, no interpolation (there are no
		// template strings in this grammar), with the small escape set below.
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i += 1;
			let out = "";
			let terminated = false;
			while (i < source.length) {
				const c = source[i];
				if (c === "\n") break; // unterminated: strings never span lines
				if (c === "\\") {
					const next = source[i + 1];
					if (next === undefined) break;
					if (next === "n") out += "\n";
					else if (next === "t") out += "\t";
					else if (next === "r") out += "\r";
					else if (next === "\\") out += "\\";
					else if (next === '"') out += '"';
					else if (next === "'") out += "'";
					else fail(`unsupported escape "\\${next}" in string literal`);
					i += 2;
					continue;
				}
				if (c === quote) {
					i += 1;
					terminated = true;
					break;
				}
				out += c;
				i += 1;
			}
			if (!terminated) {
				throw new ProgramParseError(
					"unterminated string literal",
					line,
					startColumn,
				);
			}
			tokens.push({
				type: "string",
				value: out,
				line,
				column: startColumn,
				newlineBefore,
			});
			continue;
		}

		// Identifiers / keywords.
		if (isIdentStart(ch)) {
			const start = i;
			while (i < source.length && isIdentPart(source[i])) i += 1;
			const text = source.slice(start, i);
			if (RESERVED_WORDS.has(text)) {
				throw new ProgramParseError(
					`"${text}" is not part of this language — a program has variables, if/else, "for (x of xs)", and calls to named functions, and nothing else (see the grammar in ast.ts).`,
					line,
					startColumn,
				);
			}
			tokens.push({
				type: KEYWORDS.has(text) ? "keyword" : "ident",
				value: text,
				line,
				column: startColumn,
				newlineBefore,
			});
			continue;
		}

		// Punctuation.
		const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
		if (punct) {
			i += punct.length;
			tokens.push({
				type: "punct",
				value: punct,
				line,
				column: startColumn,
				newlineBefore,
			});
			continue;
		}

		fail(`unexpected character "${ch}"`);
	}

	tokens.push({
		type: "eof",
		value: "",
		line,
		column: column(),
		newlineBefore: pendingNewline,
	});
	return tokens;
}

// ---- Parser -----------------------------------------------------------------

class Parser {
	private pos = 0;
	private nodes = 0;
	private blockDepth = 0;
	private exprDepth = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly limits: ProgramLimits,
	) {}

	// -- token helpers --

	private peek(offset = 0): Token {
		return (
			this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]
		);
	}

	private at(value: string, type: TokenType = "punct"): boolean {
		const t = this.peek();
		return t.type === type && t.value === value;
	}

	private eat(value: string, type: TokenType = "punct"): boolean {
		if (this.at(value, type)) {
			this.pos += 1;
			return true;
		}
		return false;
	}

	private expect(value: string, type: TokenType = "punct"): Token {
		if (!this.at(value, type)) {
			this.fail(`expected "${value}" but found ${this.describe(this.peek())}`);
		}
		const token = this.peek();
		this.pos += 1;
		return token;
	}

	private describe(token: Token): string {
		if (token.type === "eof") return "end of program";
		if (token.type === "string") return "a string literal";
		return `"${token.value}"`;
	}

	private fail(message: string): never {
		const t = this.peek();
		throw new ProgramParseError(message, t.line, t.column);
	}

	/** Count one AST node against `maxAstNodes`. Called at every node construction site. */
	private node<T>(value: T): T {
		this.nodes += 1;
		if (this.nodes > this.limits.maxAstNodes) {
			throw new ProgramBudgetExceededError("astNodes", this.limits.maxAstNodes);
		}
		return value;
	}

	private enterBlock(): void {
		this.blockDepth += 1;
		if (this.blockDepth > this.limits.maxNestingDepth) {
			throw new ProgramBudgetExceededError(
				"nestingDepth",
				this.limits.maxNestingDepth,
			);
		}
	}

	private enterExpr(): void {
		this.exprDepth += 1;
		if (this.exprDepth > this.limits.maxNestingDepth) {
			throw new ProgramBudgetExceededError(
				"nestingDepth",
				this.limits.maxNestingDepth,
			);
		}
	}

	// -- entry point --

	parseProgram(): Program {
		const body: Statement[] = [];
		while (this.peek().type !== "eof") {
			body.push(this.parseStatement());
		}
		return this.node<Program>({ type: "Program", body });
	}

	// -- statements --

	private parseStatement(): Statement {
		if (this.at("let", "keyword")) return this.parseLet();
		if (this.at("if", "keyword")) return this.parseIf();
		if (this.at("for", "keyword")) return this.parseFor();
		if (this.at(";")) {
			// A stray semicolon is an empty statement in JS; here it's just noise
			// to skip rather than a parse error the model has to puzzle over.
			this.pos += 1;
			return this.node<Statement>({
				type: "ExprStatement",
				expr: this.node<Expr>({ type: "NullLiteral" }),
			});
		}
		return this.parseSimpleStatement();
	}

	private parseLet(): Statement {
		this.expect("let", "keyword");
		const name = this.parseBindingName();
		this.expect("=");
		const init = this.parseExpr();
		this.eat(";");
		return this.node<Statement>({ type: "LetStatement", name, init });
	}

	/** A binding (`let x`, `for (x of …)`) must be a plain identifier — never a keyword, never a forbidden name. */
	private parseBindingName(): string {
		const token = this.peek();
		if (token.type !== "ident") {
			this.fail(`expected a variable name but found ${this.describe(token)}`);
		}
		this.pos += 1;
		return token.value;
	}

	private parseIf(): Statement {
		this.expect("if", "keyword");
		this.expect("(");
		const test = this.parseExpr();
		this.expect(")");
		const consequent = this.parseBlock();
		let alternate: Statement[] | undefined;
		if (this.eat("else", "keyword")) {
			// `else if` chains without requiring braces around the inner `if`.
			alternate = this.at("if", "keyword")
				? [this.parseIf()]
				: this.parseBlock();
		}
		return this.node<Statement>({
			type: "IfStatement",
			test,
			consequent,
			...(alternate ? { alternate } : {}),
		});
	}

	private parseFor(): Statement {
		this.expect("for", "keyword");
		this.expect("(");
		// `for (let x of …)` is accepted too — models reach for the JS spelling
		// reflexively, and rejecting it would be pure friction with no safety
		// benefit (the binding is loop-scoped either way).
		this.eat("let", "keyword");
		const first = this.parseBindingName();
		let indexName: string | undefined;
		let itemName = first;
		if (this.eat(",")) {
			indexName = first;
			itemName = this.parseBindingName();
		}
		this.expect("of", "keyword");
		const iterable = this.parseExpr();
		this.expect(")");
		const body = this.parseBlock();
		return this.node<Statement>({
			type: "ForOfStatement",
			...(indexName !== undefined ? { indexName } : {}),
			itemName,
			iterable,
			body,
		});
	}

	private parseBlock(): Statement[] {
		this.expect("{");
		this.enterBlock();
		const body: Statement[] = [];
		while (!this.at("}")) {
			if (this.peek().type === "eof") {
				this.fail('unterminated block — expected "}"');
			}
			body.push(this.parseStatement());
		}
		this.expect("}");
		this.blockDepth -= 1;
		return body;
	}

	/**
	 * An assignment or a bare expression. Parsed as an expression FIRST, then
	 * re-read as an assignment target when an `=` follows — no backtracking,
	 * and a non-assignable left side (`f() = 1`) fails with a message that
	 * says exactly that rather than a generic syntax error.
	 */
	private parseSimpleStatement(): Statement {
		const expr = this.parseExpr();
		if (this.at("=")) {
			const eq = this.peek();
			this.pos += 1;
			const target = toAssignTarget(expr);
			if (!target) {
				throw new ProgramParseError(
					'left side of "=" is not a variable, property or index',
					eq.line,
					eq.column,
				);
			}
			const value = this.parseExpr();
			this.eat(";");
			return this.node<Statement>({
				type: "AssignStatement",
				base: target.base,
				path: target.path,
				value,
			});
		}
		this.eat(";");
		return this.node<Statement>({ type: "ExprStatement", expr });
	}

	// -- expressions (precedence climbing, lowest binding first) --

	private parseExpr(): Expr {
		this.enterExpr();
		const result = this.parseLogicalOr();
		this.exprDepth -= 1;
		return result;
	}

	private parseLogicalOr(): Expr {
		let left = this.parseLogicalAnd();
		while (this.at("||")) {
			this.pos += 1;
			const right = this.parseLogicalAnd();
			left = this.node<Expr>({ type: "LogicalExpr", op: "||", left, right });
		}
		return left;
	}

	private parseLogicalAnd(): Expr {
		let left = this.parseEquality();
		while (this.at("&&")) {
			this.pos += 1;
			const right = this.parseEquality();
			left = this.node<Expr>({ type: "LogicalExpr", op: "&&", left, right });
		}
		return left;
	}

	private parseEquality(): Expr {
		let left = this.parseRelational();
		while (this.at("==") || this.at("!=")) {
			const op = this.peek().value as "==" | "!=";
			this.pos += 1;
			const right = this.parseRelational();
			left = this.node<Expr>({ type: "BinaryExpr", op, left, right });
		}
		return left;
	}

	private parseRelational(): Expr {
		let left = this.parseAdditive();
		while (this.at("<") || this.at("<=") || this.at(">") || this.at(">=")) {
			const op = this.peek().value as "<" | "<=" | ">" | ">=";
			this.pos += 1;
			const right = this.parseAdditive();
			left = this.node<Expr>({ type: "BinaryExpr", op, left, right });
		}
		return left;
	}

	private parseAdditive(): Expr {
		let left = this.parseMultiplicative();
		while (this.at("+") || this.at("-")) {
			const op = this.peek().value as "+" | "-";
			this.pos += 1;
			const right = this.parseMultiplicative();
			left = this.node<Expr>({ type: "BinaryExpr", op, left, right });
		}
		return left;
	}

	private parseMultiplicative(): Expr {
		let left = this.parseUnary();
		while (this.at("*") || this.at("/") || this.at("%")) {
			const op = this.peek().value as "*" | "/" | "%";
			this.pos += 1;
			const right = this.parseUnary();
			left = this.node<Expr>({ type: "BinaryExpr", op, left, right });
		}
		return left;
	}

	private parseUnary(): Expr {
		if (this.at("-") || this.at("!")) {
			const op = this.peek().value as UnaryOp;
			this.pos += 1;
			this.enterExpr();
			const argument = this.parseUnary();
			this.exprDepth -= 1;
			return this.node<Expr>({ type: "UnaryExpr", op, argument });
		}
		return this.parsePostfix();
	}

	private parsePostfix(): Expr {
		let object = this.parsePrimary();
		for (;;) {
			if (this.at(".")) {
				this.pos += 1;
				const token = this.peek();
				// A keyword is a legal property name in JS (`x.of`); allow it here
				// too so a data field never becomes unreachable by accident.
				if (token.type !== "ident" && token.type !== "keyword") {
					this.fail(
						`expected a property name after "." but found ${this.describe(token)}`,
					);
				}
				this.pos += 1;
				object = this.node<Expr>({
					type: "MemberExpr",
					object,
					property: token.value,
				});
				continue;
			}
			// `x(...)` where `x` is anything but a bare name — a method call
			// (`xs.map(f)`) or a call on a call. Without this the postfix loop
			// would simply stop and the `(…)` would parse as its own statement,
			// silently turning one wrong line into two harmless-looking ones.
			if (this.at("(") && !this.peek().newlineBefore) {
				this.fail(
					"only calls to a named function are supported — there is no method-call or computed-call syntax in this language",
				);
			}
			// `[` that starts a fresh line is an ARRAY LITERAL beginning a new
			// statement, not an index into the line above — the one place this
			// grammar's optional semicolons could otherwise misparse silently.
			if (this.at("[") && !this.peek().newlineBefore) {
				this.pos += 1;
				this.enterExpr();
				const index = this.parseExpr();
				this.exprDepth -= 1;
				this.expect("]");
				object = this.node<Expr>({ type: "IndexExpr", object, index });
				continue;
			}
			return object;
		}
	}

	private parsePrimary(): Expr {
		const token = this.peek();

		if (token.type === "number") {
			this.pos += 1;
			return this.node<Expr>({
				type: "NumberLiteral",
				value: token.numberValue ?? Number(token.value),
			});
		}
		if (token.type === "string") {
			this.pos += 1;
			return this.node<Expr>({ type: "StringLiteral", value: token.value });
		}
		if (token.type === "keyword") {
			if (token.value === "true" || token.value === "false") {
				this.pos += 1;
				return this.node<Expr>({
					type: "BooleanLiteral",
					value: token.value === "true",
				});
			}
			if (token.value === "null") {
				this.pos += 1;
				return this.node<Expr>({ type: "NullLiteral" });
			}
			this.fail(`"${token.value}" cannot start an expression`);
		}
		if (token.type === "ident") {
			this.pos += 1;
			// A call is ONLY ever `IDENT(args)` — there is no production for
			// calling an arbitrary expression, which is what makes
			// `something.constructor(...)`-shaped escapes unspellable.
			if (this.at("(") && !this.peek().newlineBefore) {
				this.pos += 1;
				const args: Expr[] = [];
				while (!this.at(")")) {
					this.enterExpr();
					args.push(this.parseExpr());
					this.exprDepth -= 1;
					if (!this.eat(",")) break;
				}
				this.expect(")");
				return this.node<Expr>({
					type: "CallExpr",
					callee: token.value,
					args,
				});
			}
			return this.node<Expr>({ type: "Identifier", name: token.value });
		}
		if (this.at("(")) {
			this.pos += 1;
			this.enterExpr();
			const inner = this.parseExpr();
			this.exprDepth -= 1;
			this.expect(")");
			return inner;
		}
		if (this.at("[")) {
			this.pos += 1;
			const elements: Expr[] = [];
			while (!this.at("]")) {
				this.enterExpr();
				elements.push(this.parseExpr());
				this.exprDepth -= 1;
				if (!this.eat(",")) break;
			}
			this.expect("]");
			return this.node<Expr>({ type: "ArrayLiteral", elements });
		}
		if (this.at("{")) {
			this.pos += 1;
			const properties: { key: string; value: Expr }[] = [];
			while (!this.at("}")) {
				const keyToken = this.peek();
				let key: string;
				if (keyToken.type === "string") {
					key = keyToken.value;
					this.pos += 1;
				} else if (keyToken.type === "ident" || keyToken.type === "keyword") {
					key = keyToken.value;
					this.pos += 1;
				} else {
					this.fail(
						`expected an object key but found ${this.describe(keyToken)}`,
					);
				}
				this.expect(":");
				this.enterExpr();
				properties.push({ key, value: this.parseExpr() });
				this.exprDepth -= 1;
				if (!this.eat(",")) break;
			}
			this.expect("}");
			return this.node<Expr>({ type: "ObjectLiteral", properties });
		}

		this.fail(`unexpected ${this.describe(token)}`);
	}
}

/** `a`, `a.b`, `a[0].c` → `{ base, path }`; anything else (a call, a literal, …) → null. */
function toAssignTarget(expr: Expr): { base: string; path: PathStep[] } | null {
	const path: PathStep[] = [];
	let cursor = expr;
	for (;;) {
		if (cursor.type === "Identifier") {
			return { base: cursor.name, path: path.reverse() };
		}
		if (cursor.type === "MemberExpr") {
			path.push({ kind: "member", property: cursor.property });
			cursor = cursor.object;
			continue;
		}
		if (cursor.type === "IndexExpr") {
			path.push({ kind: "index", index: cursor.index });
			cursor = cursor.object;
			continue;
		}
		return null;
	}
}

/**
 * Parse `source` under the whitelisted grammar. Throws
 * {@link ProgramParseError} for malformed input and
 * {@link ProgramBudgetExceededError} for a source/AST that blows a parse-time
 * cap. Pure: no I/O, no globals, no state kept between calls.
 */
export function parseProgram(
	source: string,
	limits: ProgramLimits = DEFAULT_PROGRAM_LIMITS,
): Program {
	if (source.length > limits.maxSourceLength) {
		throw new ProgramBudgetExceededError(
			"sourceLength",
			limits.maxSourceLength,
		);
	}
	const tokens = tokenize(source);
	return new Parser(tokens, limits).parseProgram();
}

/**
 * The object-literal `{ … }` at statement position ambiguity, spelled out
 * because it WILL bite someone: a statement starting with `{` parses as a
 * BLOCK in JS, but this grammar has no bare-block statement, so `{ a: 1 }` on
 * its own line is parsed as an object-literal expression statement. Harmless
 * either way (both are no-ops), and it means a program can never accidentally
 * open a scope it didn't mean to.
 */
export const OBJECT_LITERAL_AT_STATEMENT_POSITION_IS_AN_EXPRESSION = true;
