import { describe, expect, it } from "bun:test";
import { KERNEL_KINDS, type KernelKind } from "@/lib/director/kernel/ids";
import {
	resolveField,
	unknownFieldError,
	writableFor,
	type KindSchema,
} from "@/lib/director/kernel/schema";
import { KIND_SCHEMAS, schemaFor } from "@/lib/director/kernel/schemas";

const REGISTERED_KINDS = Object.keys(KIND_SCHEMAS) as KernelKind[];

/**
 * Every kind this file registers round-trips through `writableFor`, and no
 * read-only field leaks into the writable half. This is the load-bearing
 * guarantee the whole registry exists for: `_writable` is what a model is
 * told it may write, so a read-only field showing up there is not a cosmetic
 * bug — it is the kernel lying about its own contract.
 */
describe("every registered kind round-trips through writableFor", () => {
	for (const kind of REGISTERED_KINDS) {
		it(`${kind}: writable fields exclude every read-only field`, () => {
			const schema = schemaFor(kind);
			const { fields, readOnly } = writableFor(schema);

			for (const [name, spec] of Object.entries(schema.fields)) {
				if (spec.readOnly) {
					expect(fields).not.toHaveProperty(name);
					expect(readOnly).toHaveProperty(name);
					expect(readOnly[name].reason.length).toBeGreaterThan(0);
				} else {
					expect(readOnly).not.toHaveProperty(name);
					expect(fields).toHaveProperty(name);
					// writableFor's projection must preserve type/unit/values/of/description
					// verbatim — a model reads THIS payload, not the internal FieldSpec.
					expect(fields[name].type).toBe(spec.type);
					expect(fields[name].description).toBe(spec.description);
					if (spec.unit) expect(fields[name].unit).toBe(spec.unit);
					if (spec.values) expect(fields[name].values).toEqual(spec.values);
					if (spec.of) expect(fields[name].of).toBe(spec.of);
				}
			}
		});
	}
});

/**
 * Every declared alias must resolve back to the field that declared it. This
 * is the mechanism the whole exercise is FOR — see each kind's file for which
 * alias traces to which observed failure.
 */
describe("every declared alias resolves to its canonical field", () => {
	for (const kind of REGISTERED_KINDS) {
		const schema = schemaFor(kind);
		for (const [canonical, spec] of Object.entries(schema.fields)) {
			for (const alias of spec.aliases ?? []) {
				it(`${kind}: "${alias}" resolves to "${canonical}"`, () => {
					expect(resolveField(schema, alias)).toBe(canonical);
				});
			}
		}
	}
});

/**
 * The exact failure from the 2026-09-20 prod session: reading `clip.start`
 * (an alias, not the real field) on an element should not just fail — the
 * refusal must name `startSec` as the fix. This is the regression test for
 * the bug the whole kernel plan is a response to.
 */
describe("the prod-session regression", () => {
	it('element: "start" is accepted as an alias for startSec', () => {
		const schema = schemaFor("element");
		expect(resolveField(schema, "start")).toBe("startSec");
	});

	it('element: an actually-unknown field ("start" spelled wrong) suggests startSec', () => {
		const schema = schemaFor("element");
		// unknownFieldError is only ever called for a name that did NOT resolve
		// as a field or alias — exercise it against a near-miss of the alias
		// itself, the same distance a model's mis-typed guess would produce.
		const message = unknownFieldError(schema, "strat");
		expect(message).toContain("startSec");
	});

	it('element: "startTime" and "start" both resolve to startSec (trim/addClip/addText vs move)', () => {
		const schema = schemaFor("element");
		expect(resolveField(schema, "startTime")).toBe("startSec");
		expect(resolveField(schema, "start")).toBe("startSec");
	});

	it('element: "activeTake" (the design doc\'s own spelling) resolves to activeTakeId', () => {
		const schema = schemaFor("element");
		expect(resolveField(schema, "activeTake")).toBe("activeTakeId");
	});

	it('effect: "effectType" (the create-verb spelling) resolves to the stored field "type"', () => {
		const schema = schemaFor("effect");
		expect(resolveField(schema, "effectType")).toBe("type");
	});
});

/**
 * No alias may collide with a real field name on the same kind — a collision
 * would mean writing the alias silently retargets a DIFFERENT field than the
 * one a caller reading the field list would expect.
 */
describe("no alias collides with a real field name on the same kind", () => {
	for (const kind of REGISTERED_KINDS) {
		it(`${kind}: aliases never shadow a declared field`, () => {
			const schema = schemaFor(kind);
			const realNames = new Set(Object.keys(schema.fields));
			for (const [name, spec] of Object.entries(schema.fields)) {
				for (const alias of spec.aliases ?? []) {
					expect(
						realNames.has(alias),
						`"${alias}" (alias of "${name}") collides with a real field on kind "${kind}"`,
					).toBe(false);
				}
			}
		});
	}
});

/**
 * Every alias is unique within its kind — two fields both claiming the same
 * alias is a genuinely ambiguous resolution (resolveField returns whichever
 * it happens to iterate to first), which is worse than not registering the
 * alias at all.
 */
describe("no two fields on the same kind share an alias", () => {
	for (const kind of REGISTERED_KINDS) {
		it(`${kind}: aliases are unique`, () => {
			const schema = schemaFor(kind);
			const seen = new Map<string, string>();
			for (const [name, spec] of Object.entries(schema.fields)) {
				for (const alias of spec.aliases ?? []) {
					const owner = seen.get(alias);
					expect(
						owner,
						`alias "${alias}" claimed by both "${owner}" and "${name}" on kind "${kind}"`,
					).toBeUndefined();
					seen.set(alias, name);
				}
			}
		});
	}
});

/** `schemaFor` on an unregistered kind throws the teaching error, not undefined. */
describe("schemaFor on an unregistered kind", () => {
	const unregistered = KERNEL_KINDS.filter(
		(kind) => !REGISTERED_KINDS.includes(kind),
	);

	it("has at least one unregistered kind to test against (sanity check on the fixture itself)", () => {
		expect(unregistered.length).toBeGreaterThan(0);
	});

	for (const kind of unregistered) {
		it(`${kind}: throws a named, teaching error rather than returning undefined`, () => {
			expect(() => schemaFor(kind)).toThrow(/No schema registered for kind/);
			try {
				schemaFor(kind);
			} catch (error) {
				expect(String(error)).toContain(kind);
				// Names what IS registered, so the refusal teaches instead of stonewalling.
				expect(String(error)).toContain("element");
			}
		});
	}
});

/**
 * Structural sanity: every field spec obeys schema.ts's own contract
 * (`FieldSpec`) — an `of` is only meaningful on `type: "id"`, `values` only
 * on `type: "enum"`, and every kind schema carries a non-empty summary.
 */
describe("structural sanity of every registered schema", () => {
	for (const kind of REGISTERED_KINDS) {
		const schema: KindSchema = schemaFor(kind);

		it(`${kind}: has a kind tag matching its registry key and a summary`, () => {
			expect(schema.kind).toBe(kind);
			expect(schema.summary.length).toBeGreaterThan(0);
		});

		it(`${kind}: has at least one field`, () => {
			expect(Object.keys(schema.fields).length).toBeGreaterThan(0);
		});

		it(`${kind}: "of" is only set on id-typed fields, "values" only on enum-typed fields`, () => {
			for (const [name, spec] of Object.entries(schema.fields)) {
				if (spec.of) {
					expect(spec.type, `${name}.of set on a non-id field`).toBe("id");
					expect(KERNEL_KINDS as readonly string[]).toContain(spec.of);
				}
				if (spec.values) {
					expect(spec.type, `${name}.values set on a non-enum field`).toBe(
						"enum",
					);
					expect(spec.values.length).toBeGreaterThan(0);
				}
				if (spec.readOnly) {
					expect(
						spec.readOnlyReason,
						`${name} is readOnly without a readOnlyReason`,
					).toBeTruthy();
				}
			}
		});
	}
});
