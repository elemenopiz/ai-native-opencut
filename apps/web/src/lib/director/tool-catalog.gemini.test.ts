/**
 * Validity coverage for `toGeminiDeclarations()` — the natively-authored
 * Gemini function declarations.
 *
 * Gemini's `functionDeclarations` accept an OpenAPI-3.0 SUBSET, so a
 * declaration that leaks a draft-07 construct (`oneOf`, `additionalProperties`,
 * `default`, vendor keywords) 400s the WHOLE request. These tests walk every
 * declaration recursively and assert the dialect is clean, plus pin the
 * hand-authored restructurings (generate.slotIds, extractFrame.position) to
 * the shapes the verbs' handlers actually coerce.
 */
import { expect, test } from "bun:test";
import {
	toGeminiDeclarations,
	toolCatalog,
	type GeminiSchema,
} from "./tool-catalog";

/** Every key Gemini's v1beta `Schema` accepts (the dialect allowlist). */
const ALLOWED_KEYS = new Set([
	"type",
	"description",
	"enum",
	"items",
	"properties",
	"required",
	"nullable",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
]);

const ALLOWED_TYPES = new Set([
	"STRING",
	"NUMBER",
	"INTEGER",
	"BOOLEAN",
	"ARRAY",
	"OBJECT",
]);

/** Recursively assert one schema node stays inside the Gemini dialect. */
function assertGeminiClean(node: GeminiSchema, path: string): void {
	for (const key of Object.keys(node)) {
		expect(ALLOWED_KEYS.has(key), `${path}: unsupported key "${key}"`).toBe(
			true,
		);
	}
	if (node.type !== undefined) {
		expect(
			ALLOWED_TYPES.has(node.type),
			`${path}: non-uppercase type "${node.type}"`,
		).toBe(true);
	}
	if (node.enum) {
		expect(node.type).toBe("STRING"); // Gemini enums are string-typed
		for (const e of node.enum) expect(typeof e).toBe("string");
	}
	if (node.required) {
		// `required` must reference declared properties.
		for (const r of node.required) {
			expect(
				node.properties && r in node.properties,
				`${path}: required "${r}" has no matching property`,
			).toBe(true);
		}
	}
	if (node.items) assertGeminiClean(node.items, `${path}.items`);
	for (const [k, v] of Object.entries(node.properties ?? {})) {
		assertGeminiClean(v, `${path}.${k}`);
	}
}

test("every declaration is dialect-clean, named after a catalog verb, and described", () => {
	const decls = toGeminiDeclarations();
	const catalogNames = toolCatalog().map((t) => t.name);

	// Full coverage, same order, no inventions.
	expect(decls.map((d) => d.name)).toEqual(catalogNames);

	for (const d of decls) {
		expect(d.description.length).toBeGreaterThan(0);
		if (d.parameters) {
			expect(d.parameters.type).toBe("OBJECT");
			// A present parameters node must carry properties (Gemini rejects an
			// empty OBJECT — zero-arg verbs omit `parameters` instead).
			expect(Object.keys(d.parameters.properties ?? {}).length).toBeGreaterThan(
				0,
			);
			assertGeminiClean(d.parameters, d.name);
		}
	}
});

test("zero-arg verbs omit `parameters` entirely", () => {
	const decls = toGeminiDeclarations();
	const getReel = decls.find((d) => d.name === "getReel");
	expect(getReel).toBeDefined();
	expect(getReel?.parameters).toBeUndefined();
});

test("generate.slotIds is restructured to a plain array (omit = all slots), not a oneOf", () => {
	const generate = toGeminiDeclarations().find((d) => d.name === "generate");
	const slotIds = generate?.parameters?.properties?.slotIds;
	expect(slotIds?.type).toBe("ARRAY");
	expect(slotIds?.items?.type).toBe("STRING");
	// The omit-for-all contract must be stated where the model reads it.
	expect(slotIds?.description ?? "").toContain("OMIT");
	// slotIds must NOT become required by the restructure.
	expect(generate?.parameters?.required ?? []).not.toContain("slotIds");
});

test('extractFrame.position is restructured to a STRING ("first" | "last" | seconds), not a oneOf', () => {
	const extract = toGeminiDeclarations().find((d) => d.name === "extractFrame");
	const position = extract?.parameters?.properties?.position;
	expect(position?.type).toBe("STRING");
	expect(position?.description ?? "").toContain("first");
	expect(position?.description ?? "").toContain("last");
	// Still required — the restructure changes the shape, not the contract.
	expect(extract?.parameters?.required ?? []).toContain("position");
});

test("units and defaults fold into descriptions instead of leaking as keywords", () => {
	// `trim` carries x-seconds fields and `generate.alternatives` a default —
	// both must surface as prose, never as schema keys (checked globally by the
	// dialect walk; spot-check the prose here).
	const generate = toGeminiDeclarations().find((d) => d.name === "generate");
	const alternatives = generate?.parameters?.properties?.alternatives;
	expect(alternatives?.description ?? "").toContain("Default: 1");
});

test("tuned verbs lead with explicit trigger guidance; untouched verbs keep the catalog text", () => {
	const decls = toGeminiDeclarations();
	const byName = new Map(decls.map((d) => [d.name, d]));
	// High-traffic verbs carry the Gemini-tuned "Call this ..." phrasing.
	for (const name of ["storyboard", "generate", "reviewTake"]) {
		expect(byName.get(name)?.description ?? "").toMatch(/^Call this/);
	}
	// A verb without an override keeps its catalog description verbatim.
	const catalogChainFrom = toolCatalog().find((t) => t.name === "chainFrom");
	expect(byName.get("chainFrom")?.description).toBe(
		catalogChainFrom?.description,
	);
});
