/**
 * Pre-relay MCP argument-shape guards.
 *
 * The MCP server (`build-mcp-server.ts`) relays every `tools/call` to the
 * editor bridge without inspecting the arg shape. Two cross-cutting
 * conformance gaps (see `apps/web/docs/mcp/palmier-conformance-2026-07-17.md`
 * §2) are closed HERE, at the server boundary, BEFORE the bridge is touched:
 *
 *  1. **Unknown-key rejection.** When a (sub)schema object node declares
 *     `additionalProperties: false`, any arg key not present in that node's
 *     `properties` is rejected with a message naming the offending key path
 *     and listing the allowed fields for that object.
 *  2. **Non-finite number rejection.** When a schema node is `type: "number"`
 *     or `type: "integer"`, a value of `NaN` / `Infinity` / `-Infinity` (or a
 *     string that coerces to one of those) is rejected with a path to the
 *     offending value.
 *
 * Deliberately narrow: it does NOT enforce `required`, and it does NOT reject
 * wrong-type-but-finite values (handlers already coerce those). Enforcing more
 * here would break existing valid calls. It only checks the two gaps above,
 * and only where the schema explicitly opts in (`additionalProperties: false`
 * for unknown keys; a numeric `type` for the finite check).
 */

import type { JSONSchema } from "@/lib/director/tool-catalog";

/** First arg-shape violation found, or `null` when the args are acceptable. */
export interface ArgViolation {
	/** Dotted/indexed path to the offending key or value (e.g. `shots[0].budgetUsd`). */
	path: string;
	/** Human-facing refusal message, ready to surface to the MCP client. */
	message: string;
}

/** Render a value compactly for an error message. */
function describeValue(value: unknown): string {
	if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
	if (typeof value === "number") return String(value);
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "object") return "an object";
	return String(value);
}

/**
 * Is `value` a non-finite number for a numeric schema field? Rejects actual
 * non-finite numbers, and strings that coerce to a non-finite number (e.g.
 * `"Infinity"`, `"NaN"`, `"abc"`). A finite numeric string like `"5"` passes.
 * Non-primitive / boolean / null values are treated as wrong-type (not this
 * guard's concern) and left for the handler's coercion.
 */
function isNonFiniteNumberValue(value: unknown): boolean {
	if (typeof value === "number") return !Number.isFinite(value);
	if (typeof value === "string") {
		if (value.trim() === "") return false; // "" coerces to 0 (finite)
		return !Number.isFinite(Number(value));
	}
	return false;
}

function joinPath(base: string, key: string): string {
	return base === "" ? key : `${base}.${key}`;
}

/**
 * Walk one schema node against its corresponding value, returning the first
 * violation or `null`. Recurses into object `properties` and array `items` so
 * nested unknown keys and nested non-finite numbers are caught.
 */
function validateNode(
	node: JSONSchema,
	value: unknown,
	path: string,
): ArgViolation | null {
	// `oneOf` is an ambiguous branch point — we can't know which member the
	// value is meant to satisfy, so we don't descend (avoids false positives).
	if (Array.isArray(node.oneOf)) return null;

	// Non-finite number guard.
	if (node.type === "number" || node.type === "integer") {
		if (isNonFiniteNumberValue(value)) {
			return {
				path,
				message: `Argument "${path}" must be a finite number, but got ${describeValue(value)}.`,
			};
		}
		return null;
	}

	// Object node: unknown-key rejection + recurse into known properties.
	if (
		node.type === "object" ||
		(node.properties !== undefined && node.type === undefined)
	) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return null; // wrong-type — not this guard's concern
		}
		const record = value as Record<string, unknown>;
		const properties = node.properties ?? {};

		if (node.additionalProperties === false) {
			for (const key of Object.keys(record)) {
				if (!Object.hasOwn(properties, key)) {
					const allowed = Object.keys(properties);
					const where = path === "" ? "this tool" : `"${path}"`;
					const allowedList =
						allowed.length > 0 ? `[${allowed.join(", ")}]` : "(none)";
					return {
						path: joinPath(path, key),
						message: `Unknown argument "${joinPath(path, key)}". Allowed fields for ${where}: ${allowedList}.`,
					};
				}
			}
		}

		for (const key of Object.keys(record)) {
			const childSchema = properties[key];
			if (!childSchema) continue; // unknown-but-tolerated (additionalProperties !== false)
			const violation = validateNode(
				childSchema,
				record[key],
				joinPath(path, key),
			);
			if (violation) return violation;
		}
		return null;
	}

	// Array node: recurse into each element against `items`.
	if (node.type === "array" || node.items !== undefined) {
		if (!Array.isArray(value) || node.items === undefined) return null;
		for (let i = 0; i < value.length; i++) {
			const violation = validateNode(node.items, value[i], `${path}[${i}]`);
			if (violation) return violation;
		}
		return null;
	}

	return null;
}

/**
 * Validate a tool call's args against its catalog `inputSchema`, returning the
 * first {@link ArgViolation} or `null` when the args pass both guards.
 */
export function validateToolArgs(
	schema: JSONSchema,
	args: Record<string, unknown>,
): ArgViolation | null {
	return validateNode(schema, args, "");
}
