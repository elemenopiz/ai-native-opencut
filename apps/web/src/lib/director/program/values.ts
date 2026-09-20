/**
 * The CLOSED value domain every program expression evaluates to, and every
 * host function (primitive or data accessor) receives/returns. Deliberately
 * a strict subset of what JS values can be: numbers, strings, booleans,
 * `null`/`undefined`, plain arrays, and plain string-keyed objects. NEVER a
 * function, a class instance, a `Map`/`Set`/`Date`, or anything else with a
 * prototype chain worth walking — there is no value in this language a
 * script could hold that leads anywhere but more of this same closed set.
 */
export type ProgramValue =
	| number
	| string
	| boolean
	| null
	| undefined
	| ProgramValue[]
	| { [key: string]: ProgramValue };

export function isProgramObject(
	value: ProgramValue,
): value is { [key: string]: ProgramValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProgramArray(value: ProgramValue): value is ProgramValue[] {
	return Array.isArray(value);
}

/** JS truthiness (0/""/NaN/null/undefined/false are falsy) — used by `if`, `&&`/`||`, and `!`. */
export function truthy(value: ProgramValue): boolean {
	if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
	return Boolean(value);
}

/**
 * Deep-clone a {@link ProgramValue}. Used at TWO boundaries: (1) every
 * derived-data accessor (`beats()`, `clips()`, …) hands the script a fresh
 * clone so a script mutating its own local copy can never corrupt the
 * shared source data or leak state into a later call/run; (2) a value
 * crossing from the script into a primitive's args (or back) is cloned so
 * neither side can hold a live reference into the other's memory. Cheap:
 * every value here is already JSON-shaped, so `structuredClone` (present in
 * both bun and every evergreen browser) is exact and fast.
 */
export function cloneProgramValue<T extends ProgramValue>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	return structuredClone(value);
}

/** Short, safe-to-print description of a value's shape for error messages — never dumps full (possibly large) content. */
export function describeProgramValue(value: ProgramValue): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `array(${value.length})`;
	if (typeof value === "object")
		return `object(${Object.keys(value).length} keys)`;
	return `${typeof value} ${JSON.stringify(value)}`.slice(0, 80);
}
