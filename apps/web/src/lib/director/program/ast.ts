/**
 * The whitelisted AST this engine interprets — see `parser.ts` (text → this
 * tree) and `interpreter.ts` (this tree → effects). CLOSED set of node
 * `type`s on purpose: the interpreter's `switch` is exhaustive over exactly
 * these kinds, so there is no node shape it doesn't already know how to
 * refuse. Adding a node kind here is the ONLY way to grow what a program can
 * express — that is deliberate friction, matching the primitive layer's own
 * "stop adding to this layer" discipline
 * (`docs/plans/2026-09-18-director-autonomy-architecture.md` §2).
 *
 * The grammar is a small, first-order subset of JS-like syntax: variables,
 * `if`/`else`, `for (item of iterable)` (optionally `for (index, item of
 * iterable)`), object/array literals, member (`.x`) and index (`[x]`) access
 * and assignment, and calls to a caller-supplied whitelist of named
 * functions (`trim(...)`, `beats()`, `abs(...)`, …). Deliberately absent:
 * user-defined functions/closures, `while`, `break`/`continue`, `try`/
 * `catch`, method-call syntax (`x.f()`), spread, template strings, regex.
 * None of these are needed to express a beat-cut/tighten/duck program (see
 * `cut-on-beat.program.test.ts`), and each one is a class of interpreter
 * bug this engine simply doesn't have to get right.
 */

export type BinaryOp =
	| "+"
	| "-"
	| "*"
	| "/"
	| "%"
	| "<"
	| "<="
	| ">"
	| ">="
	| "=="
	| "!=";

export type LogicalOp = "&&" | "||";

export type UnaryOp = "-" | "!";

/** One step in a member/index access or assignment CHAIN — `a.b[c].d` is a base identifier plus this list. */
export type PathStep =
	| { kind: "member"; property: string }
	| { kind: "index"; index: Expr };

// ---- Expressions ----------------------------------------------------------

export interface NumberLiteral {
	type: "NumberLiteral";
	value: number;
}
export interface StringLiteral {
	type: "StringLiteral";
	value: string;
}
export interface BooleanLiteral {
	type: "BooleanLiteral";
	value: boolean;
}
export interface NullLiteral {
	type: "NullLiteral";
}
export interface Identifier {
	type: "Identifier";
	name: string;
}
export interface ArrayLiteral {
	type: "ArrayLiteral";
	elements: Expr[];
}
export interface ObjectLiteral {
	type: "ObjectLiteral";
	/** Insertion-ordered; a repeated key keeps only the LAST value, matching JS object-literal semantics. */
	properties: { key: string; value: Expr }[];
}
/** `object.property` — GET only. Assignment targets use `PathStep`, not this node. */
export interface MemberExpr {
	type: "MemberExpr";
	object: Expr;
	property: string;
}
/** `object[index]` — GET only, same reasoning as {@link MemberExpr}. */
export interface IndexExpr {
	type: "IndexExpr";
	object: Expr;
	index: Expr;
}
/**
 * A call to a NAMED whitelisted function — `callee` is a bare identifier
 * name, never an arbitrary expression. This is what makes `[].constructor
 * (...)`-shaped escapes structurally unreachable: there is no AST shape for
 * "call whatever this expression evaluates to", only "call this literal
 * name from the host's table" (see `interpreter.ts`'s `Globals`).
 */
export interface CallExpr {
	type: "CallExpr";
	callee: string;
	args: Expr[];
}
export interface UnaryExpr {
	type: "UnaryExpr";
	op: UnaryOp;
	argument: Expr;
}
export interface BinaryExpr {
	type: "BinaryExpr";
	op: BinaryOp;
	left: Expr;
	right: Expr;
}
/** `&&`/`||` are split from {@link BinaryExpr} because they short-circuit (the interpreter must NOT evaluate `right` eagerly). */
export interface LogicalExpr {
	type: "LogicalExpr";
	op: LogicalOp;
	left: Expr;
	right: Expr;
}

export type Expr =
	| NumberLiteral
	| StringLiteral
	| BooleanLiteral
	| NullLiteral
	| Identifier
	| ArrayLiteral
	| ObjectLiteral
	| MemberExpr
	| IndexExpr
	| CallExpr
	| UnaryExpr
	| BinaryExpr
	| LogicalExpr;

// ---- Statements -------------------------------------------------------------

export interface LetStatement {
	type: "LetStatement";
	name: string;
	init: Expr;
}
/** `base` then a possibly-empty chain of {@link PathStep}s — `x = 1`, `x.y = 1`, `x[k].y = 1`, … */
export interface AssignStatement {
	type: "AssignStatement";
	base: string;
	path: PathStep[];
	value: Expr;
}
export interface IfStatement {
	type: "IfStatement";
	test: Expr;
	consequent: Statement[];
	alternate?: Statement[];
}
/**
 * `for (item of iterable)` or `for (index, item of iterable)` — the
 * two-binding form mirrors the design doc's own pseudocode
 * (`for i, beat in enumerate(beats)`) so a model reading that doc recognizes
 * the shape immediately. `indexName` is `undefined` for the single-binding
 * form.
 */
export interface ForOfStatement {
	type: "ForOfStatement";
	indexName?: string;
	itemName: string;
	iterable: Expr;
	body: Statement[];
}
export interface ExprStatement {
	type: "ExprStatement";
	expr: Expr;
}

export type Statement =
	| LetStatement
	| AssignStatement
	| IfStatement
	| ForOfStatement
	| ExprStatement;

export interface Program {
	type: "Program";
	body: Statement[];
}

/** Property/identifier names the interpreter refuses everywhere — object-literal keys, member/index reads, member/index assignment targets. This is the whole prototype-pollution/prototype-walk defense (see `executor.ts`'s threat model, point 4); it only works because it is enforced at EVERY one of those sites, not just one. */
export const FORBIDDEN_PROPERTY_NAMES: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);
