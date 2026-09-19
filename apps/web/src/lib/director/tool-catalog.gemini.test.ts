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
	const catalogReorder = toolCatalog().find((t) => t.name === "reorder");
	expect(byName.get("reorder")?.description).toBe(catalogReorder?.description);
});

// ── description CONTRAST for the confusable clusters (Gemini declarations
// only — the shared catalog text is asserted untouched below) ────────────────

/** name → sibling verbs its Gemini description must explicitly redirect to. */
const CONTRAST_EXPECTATIONS: Record<string, string[]> = {
	// generation cluster: first render / quality retry / directed change / continuity
	generate: ["reroll", "remix", "chainFrom"],
	reroll: ["remix", "generate"],
	remix: ["reroll", "chainFrom"],
	chainFrom: ["reroll", "remix"],
	// timeline cluster: in-out points / position in time / one clip into two
	trim: ["move", "split"],
	move: ["trim", "split"],
	split: ["trim", "move"],
	// take judgment: rank (no commit) / commit / paid vision critique
	compareTake: ["chooseTake"],
	chooseTake: ["reviewTake", "compareTake"],
	reviewTake: ["chooseTake"],
};

test("confusable-cluster members carry explicit contrast lines naming their siblings", () => {
	const byName = new Map(toGeminiDeclarations().map((d) => [d.name, d]));
	for (const [name, siblings] of Object.entries(CONTRAST_EXPECTATIONS)) {
		const description = byName.get(name)?.description ?? "";
		expect(
			description.length,
			`${name}: missing Gemini declaration`,
		).toBeGreaterThan(0);
		// Every member states what NOT to use it for (compareTake/reviewTake use
		// "does NOT commit"/"commits nothing" phrasing; the rest "Do NOT use").
		expect(
			/\bNOT\b/.test(description),
			`${name}: no contrast ("NOT") line in: ${description}`,
		).toBe(true);
		for (const sibling of siblings) {
			expect(
				description.includes(sibling),
				`${name}: contrast line must redirect to "${sibling}" in: ${description}`,
			).toBe(true);
		}
	}
});

test("contrast tuning lives in the Gemini overrides ONLY — catalog descriptions stay untouched", () => {
	// The shared (Anthropic/MCP-facing) catalog text must not grow the Gemini
	// contrast phrasing ("Do NOT use this ... — use <sibling>"), which is what
	// this guard is actually for. It used to pin the timeline cluster's exact
	// strings as a proxy; those strings now also carry timebase wording (see
	// the timebase test below), so assert the property instead of the literal.
	const catalog = new Map(toolCatalog().map((t) => [t.name, t.description]));
	for (const name of ["trim", "move", "split"]) {
		const description = catalog.get(name) ?? "";
		expect(description.length, `${name}: missing catalog entry`).toBeGreaterThan(
			0,
		);
		expect(description).not.toContain("Do NOT");
		// The Gemini contrast lines redirect between siblings by name; the shared
		// catalog text must not.
		for (const sibling of ["trim", "move", "split"].filter((n) => n !== name)) {
			expect(
				description.includes(`use ${sibling}`),
				`${name}: catalog text must not carry Gemini's redirect to "${sibling}"`,
			).toBe(false);
		}
	}
});

test("every verb taking a time POSITION states its timebase explicitly", () => {
	// The silent-wrongness class this pins: a time argument whose description
	// doesn't say whether it is TIMELINE-ABSOLUTE (from the start of the
	// project) or ASSET-RELATIVE (into the source media, what getTranscript
	// reports). An agent that guesses wrong cuts in the wrong place and nothing
	// warns it. Durations/tolerances are lengths, not positions, so they're out
	// of scope here.
	const TIMELINE_POSITION_ARGS: Record<string, string[]> = {
		trim: ["startTime"],
		move: ["newStartTime"],
		split: ["atTime"],
		addText: ["startTime"],
		updateText: ["startTime"],
		addVoiceover: ["startTime"],
		addMusicBed: ["startTime"],
		addClip: ["startTime"],
	};
	const ASSET_RELATIVE_ARGS: Record<string, string[]> = {
		trim: ["trimStart", "trimEnd"],
		split: ["atSourceTime"],
		getTranscript: ["startSec", "endSec"],
	};

	const byName = new Map(toolCatalog().map((t) => [t.name, t]));
	const describe = (verb: string, arg: string): string => {
		const tool = byName.get(verb);
		expect(tool, `${verb}: missing from the catalog`).toBeDefined();
		const prop = (
			tool?.inputSchema?.properties as
				| Record<string, { description?: string }>
				| undefined
		)?.[arg];
		expect(prop, `${verb}.${arg}: missing from the schema`).toBeDefined();
		return prop?.description ?? "";
	};

	for (const [verb, args] of Object.entries(TIMELINE_POSITION_ARGS)) {
		for (const arg of args) {
			const description = describe(verb, arg);
			expect(
				/timeline[- ]absolute|timeline start/i.test(description),
				`${verb}.${arg}: must say it is TIMELINE-absolute — got: ${description}`,
			).toBe(true);
		}
	}
	for (const [verb, args] of Object.entries(ASSET_RELATIVE_ARGS)) {
		for (const arg of args) {
			const description = describe(verb, arg);
			expect(
				/asset[- ]relative/i.test(description),
				`${verb}.${arg}: must say it is ASSET-relative — got: ${description}`,
			).toBe(true);
		}
	}
});

test("split warns, in both dialects, that atTime is not the transcript timebase", () => {
	const catalog = new Map(toolCatalog().map((t) => [t.name, t.description]));
	const gemini = new Map(
		toGeminiDeclarations().map((d) => [d.name, d.description]),
	);
	for (const description of [catalog.get("split"), gemini.get("split")]) {
		expect(description ?? "").toMatch(/timeline[- ]absolute/i);
		expect(description ?? "").toContain("atSourceTime");
	}
	// getTranscript must stop steering its asset-relative numbers at atTime.
	expect(catalog.get("getTranscript") ?? "").toContain("atSourceTime");
});
