/**
 * What may be written to a thing, declared once, served at runtime.
 *
 * WHY THIS IS THE LOAD-BEARING FILE OF THE KERNEL. A primitive surface is
 * WORSE than a curated one if the primitives are unspellable. The 2026-09-20
 * prod session is the proof: the model read `clip.start`, got `undefined`
 * (`program/interpreter.ts`'s object read returns undefined for an unknown
 * key), and failed two frames later at `"-" needs two numbers`. It never had
 * any way to learn the field was `startSec`.
 *
 * So every kernel read returns `_writable` alongside the data: the exact patch
 * shape `update` will accept on THAT object, with types and units. The API
 * documents itself at runtime, in the same payload the model is already
 * reading. Nothing has to be remembered from a tool description, and a field
 * rename can never silently desync the docs from the code — there is only one
 * declaration.
 *
 * The second half is {@link unknownFieldError}: when a write does name a field
 * that does not exist, the refusal lists the legal fields and the nearest
 * match. A bare "no" sends the model guessing again; this ends the guess.
 *
 * NOT A VALIDATOR YET. Step 3 of the kernel plan turns this registry into the
 * real write-time validator (the one that has to answer "you cannot chroma-key
 * audio" with a reason and an alternative). Keeping the DECLARATION separate
 * from the enforcement is deliberate: the same table then serves both, and
 * they cannot disagree.
 */

import { editDistance, type KernelKind } from "./ids";

export type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "array"
	| "id"
	| "enum";

export interface FieldSpec {
	type: FieldType;
	/** Unit for a number, spelled the way the field actually stores it: "seconds", "px", "dB", "0-1", "degrees". Ambiguous units are how a model puts a 3-second trim 3 frames in. */
	unit?: string;
	/** Legal values for `type: "enum"`. Surfaced verbatim in `_writable`. */
	values?: readonly string[];
	/** For `type: "id"`, the kind the id must name — so `_writable` says "id:track", not just "id". */
	of?: KernelKind;
	/** One short line. This is the model's only prose about the field; keep it about MEANING, not syntax. */
	description: string;
	/** Present and true when the field is readable but not writable — reported in reads, refused by `update` with this reason. */
	readOnly?: boolean;
	/** Why a read-only field is read-only, e.g. "derived from trim + duration". */
	readOnlyReason?: string;
	/** Other spellings accepted on the way IN and rewritten to this field. The model's natural guesses go here — see ALIASES below. */
	aliases?: readonly string[];
}

export interface KindSchema {
	kind: KernelKind;
	/** One line describing the noun itself, returned at the head of a read. */
	summary: string;
	fields: Record<string, FieldSpec>;
}

export type SchemaRegistry = Partial<Record<KernelKind, KindSchema>>;

/**
 * ALIASES ARE NOT SLOPPINESS. Every alias in this registry should be a
 * spelling a competent model actually reached for, and each one is cheaper
 * than the round trip it prevents. The observed set from the 2026-09-20
 * session: `startTime` for `move`'s `newStartTime` (because `trim`, `addClip`
 * and `addText` all spell it `startTime`), and `start`/`end`/`duration` for
 * `startSec`/`endSec`/`durationSec`. Accepting them is not a failure to hold a
 * line; the line was arbitrary.
 */

/** The `_writable` payload: what `update` accepts on this object, right now. */
export interface WritableDescriptor {
	fields: Record<
		string,
		{
			type: FieldType;
			unit?: string;
			values?: readonly string[];
			of?: KernelKind;
			description: string;
		}
	>;
	readOnly: Record<string, { type: FieldType; reason: string }>;
}

export function writableFor(schema: KindSchema): WritableDescriptor {
	const fields: WritableDescriptor["fields"] = {};
	const readOnly: WritableDescriptor["readOnly"] = {};
	for (const [name, spec] of Object.entries(schema.fields)) {
		if (spec.readOnly) {
			readOnly[name] = {
				type: spec.type,
				reason: spec.readOnlyReason ?? "derived; not directly writable",
			};
			continue;
		}
		fields[name] = {
			type: spec.type,
			...(spec.unit ? { unit: spec.unit } : {}),
			...(spec.values ? { values: spec.values } : {}),
			...(spec.of ? { of: spec.of } : {}),
			description: spec.description,
		};
	}
	return { fields, readOnly };
}

/** Resolve a field name a caller used, following {@link FieldSpec.aliases}. Returns the canonical name, or null when nothing matches. */
export function resolveField(
	schema: KindSchema,
	attempted: string,
): string | null {
	if (Object.hasOwn(schema.fields, attempted)) return attempted;
	for (const [name, spec] of Object.entries(schema.fields)) {
		if (spec.aliases?.includes(attempted)) return name;
	}
	return null;
}

/** The closest legal field name within a small edit budget, aliases included. */
export function nearestField(
	schema: KindSchema,
	attempted: string,
): string | null {
	let best: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	const lower = attempted.toLowerCase();
	for (const [name, spec] of Object.entries(schema.fields)) {
		for (const candidate of [name, ...(spec.aliases ?? [])]) {
			const score = editDistance(lower, candidate.toLowerCase());
			if (score < bestScore) {
				bestScore = score;
				best = name;
			}
		}
	}
	const budget = attempted.length <= 4 ? 1 : 3;
	return bestScore <= budget ? best : null;
}

/**
 * The refusal that ends a guess. Names the near-miss first (it is right most
 * of the time), then the full legal set, because a model that guessed once
 * will otherwise guess again from the same empty context.
 */
export function unknownFieldError(
	schema: KindSchema,
	attempted: string,
): string {
	const near = nearestField(schema, attempted);
	const legal = Object.keys(schema.fields).sort().join(", ");
	return near
		? `${schema.kind} has no field "${attempted}" — did you mean "${near}"? Fields: ${legal}.`
		: `${schema.kind} has no field "${attempted}". Fields: ${legal}.`;
}
