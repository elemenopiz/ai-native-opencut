/**
 * Layer 1 of `docs/plans/2026-09-18-director-autonomy-architecture.md` §2 —
 * the CLOSED primitive surface a program may call. Ten verbs:
 * `trim`, `move`, `split`, `reorder`, `remove`, `addClip`, `addText`,
 * `applyTransition`, `applyEffect`, `animateItem`.
 *
 * WRAPPERS, NOT REIMPLEMENTATIONS. Every one of these calls the identically
 * named verb on the live `DirectorApi` (`lib/director/director-api.ts`) and
 * does nothing that verb doesn't already do. This module adds exactly three
 * things on top:
 *   1. **Argument typing.** A program's args arrive as an untyped
 *      {@link ProgramValue} object literal. Each verb has a schema here, so a
 *      model passing `duration: "4s"` gets a {@link ProgramRuntimeError}
 *      naming the field — instead of a string reaching
 *      `updateElementTrim` and landing a clip at `NaN` seconds.
 *   2. **The op log.** Every call appends to an ordered {@link ProgramOp}
 *      list BEFORE it is applied. That list is the dry-run's entire output
 *      and the applied run's receipt.
 *   3. **The operation cap.** `maxOperations` is metered here because this is
 *      the only place an operation exists (see `interpreter.ts`'s header on
 *      the shared meter).
 *
 * `DirectorApi` is NOT imported. {@link ProgramPrimitiveApi} is a structural
 * subset a real `DirectorApi` satisfies, declared with METHOD syntax so
 * parameter bivariance lets the real (more specific) verb signatures be
 * assignable to these (looser) ones. The payoff is a primitive layer that a
 * five-line fake can exercise in a unit test, and an import graph that never
 * drags the whole 6.7k-line api module — or the stores it pulls in — into a
 * parser test.
 *
 * TARGETING CAVEAT, inherited not introduced: `trim`/`move`/`split`/`remove`/
 * `applyTransition`/`applyEffect` resolve their target through the api's
 * `findSlot`, i.e. GENERATIVE REEL SLOTS ONLY. Plain placed footage is not
 * addressable by those verbs today — which is exactly why
 * `director-api.ts`'s own `executeCraftPlan` re-implements trim/move against
 * `findElement` instead of reusing them. A program therefore inherits the
 * same restriction. Lifting it means widening those verbs (a `director-api.
 * ts` change, not a change here); until then, see this package's README note
 * in `executor.ts` §"KNOWN GAPS".
 */

import { ProgramBudgetExceededError, ProgramRuntimeError } from "./errors";
import type { HostFunction } from "./interpreter";
import type { ProgramMeter } from "./interpreter";
import type { ProgramLimits } from "./limits";
import { ProgramPrimitiveError } from "./errors";
import {
	cloneProgramValue,
	describeProgramValue,
	isProgramObject,
	type ProgramValue,
} from "./values";

/** The result shape every `DirectorApi` verb returns (`DirectorResult<T>` structurally narrowed to what this layer reads). */
export interface PrimitiveResult {
	ok: boolean;
	message: string;
	data?: unknown;
}

/**
 * The slice of `DirectorApi` a program can reach. Method syntax is
 * deliberate — see this module's header. A real `DirectorApi` satisfies this
 * without a cast.
 */
export interface ProgramPrimitiveApi {
	trim(input: {
		slotId: string;
		trimStart?: number;
		trimEnd?: number;
		startTime?: number;
		duration?: number;
	}): PrimitiveResult;
	move(input: {
		slotId: string;
		newStartTime: number;
		targetTrackId?: string;
	}): PrimitiveResult;
	split(input: { slotId: string; atTime: number }): PrimitiveResult;
	reorder(input: { slotIds: string[] }): PrimitiveResult;
	remove(input: { slotId: string }): PrimitiveResult;
	addClip(input: {
		mediaId: string;
		startTime?: number;
		duration?: number;
		trackId?: string;
	}): PrimitiveResult;
	addText(input: {
		content: string;
		startTime: number;
		duration?: number;
		trackId?: string;
		fontSize?: number;
		fontFamily?: string;
		color?: string;
		textAlign?: never;
	}): PrimitiveResult;
	applyTransition(input: {
		slotId: string;
		transitionType: string;
		duration?: number;
	}): PrimitiveResult;
	applyEffect(input: {
		slotId: string;
		effectType: string;
		params?: never;
	}): PrimitiveResult;
	animateItem(input: {
		itemId: string;
		property: never;
		value?: unknown;
		keyframes?: Array<{
			time: number;
			value: unknown;
			interpolation?: never;
		}>;
	}): PrimitiveResult;
}

/** The ten verb names, in the order the architecture doc lists them. Exported so a catalog/prompt can enumerate the surface without duplicating it. */
export const PRIMITIVE_VERBS = [
	"trim",
	"move",
	"split",
	"reorder",
	"remove",
	"addClip",
	"addText",
	"applyTransition",
	"applyEffect",
	"animateItem",
] as const;

export type PrimitiveVerb = (typeof PRIMITIVE_VERBS)[number];

/**
 * One recorded primitive call. This is the dry-run's whole product and the
 * applied run's receipt — the "its effects are enumerable" half of the
 * architecture doc's safety claim (§2).
 */
export interface ProgramOp {
	/** 0-based position in the run's op sequence. */
	index: number;
	verb: PrimitiveVerb;
	/** The validated, normalized argument bag handed to the `DirectorApi` verb. */
	args: Record<string, ProgramValue>;
	/** Present on an APPLIED run: what the verb said. Absent in dry-run — nothing was called. */
	result?: { ok: boolean; message: string };
}

// ---- Argument schemas -------------------------------------------------------

type FieldType = "string" | "number" | "boolean" | "array" | "object" | "any";

interface VerbSchema {
	/** Field name → type. Fields not listed are REJECTED (a typo'd arg must not be silently dropped on the floor). */
	fields: Record<string, FieldType>;
	required: string[];
	/** Synthetic payload a dry-run returns in place of the verb's real `data`. `index` is the op's position, used to mint stable placeholder ids. */
	dryRunData?: (index: number) => ProgramValue;
}

const dryId = (verb: string, index: number) => `dry-run:${verb}:${index}`;

/**
 * One schema per verb, mirroring the `DirectorApi` `input` shape 1:1. Kept
 * literal rather than derived from the tool catalog on purpose: the catalog
 * is Agent 1B's file and it describes verbs for a MODEL to read, while this
 * describes them for an interpreter to enforce. Two readers, two artifacts —
 * and this one has to be exactly the api's runtime contract, not a prose
 * approximation of it.
 */
const VERB_SCHEMAS: Record<PrimitiveVerb, VerbSchema> = {
	trim: {
		fields: {
			slotId: "string",
			trimStart: "number",
			trimEnd: "number",
			startTime: "number",
			duration: "number",
		},
		required: ["slotId"],
	},
	move: {
		fields: {
			slotId: "string",
			newStartTime: "number",
			targetTrackId: "string",
		},
		required: ["slotId", "newStartTime"],
	},
	split: {
		fields: { slotId: "string", atTime: "number" },
		required: ["slotId", "atTime"],
		dryRunData: (index) => ({ newSlotIds: [dryId("split", index)] }),
	},
	reorder: {
		fields: { slotIds: "array" },
		required: ["slotIds"],
	},
	remove: {
		fields: { slotId: "string" },
		required: ["slotId"],
	},
	addClip: {
		fields: {
			mediaId: "string",
			startTime: "number",
			duration: "number",
			trackId: "string",
		},
		required: ["mediaId"],
		dryRunData: (index) => ({ elementId: dryId("addClip", index) }),
	},
	addText: {
		fields: {
			content: "string",
			startTime: "number",
			duration: "number",
			trackId: "string",
			fontSize: "number",
			fontFamily: "string",
			color: "string",
			textAlign: "string",
		},
		required: ["content", "startTime"],
		dryRunData: (index) => ({ elementId: dryId("addText", index) }),
	},
	applyTransition: {
		fields: {
			slotId: "string",
			transitionType: "string",
			duration: "number",
		},
		required: ["slotId", "transitionType"],
	},
	applyEffect: {
		fields: { slotId: "string", effectType: "string", params: "object" },
		required: ["slotId", "effectType"],
		dryRunData: (index) => ({ effectId: dryId("applyEffect", index) }),
	},
	animateItem: {
		fields: {
			itemId: "string",
			property: "string",
			value: "any",
			keyframes: "array",
		},
		required: ["itemId", "property"],
	},
};

function typeOfValue(value: ProgramValue): FieldType | "null" | "undefined" {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	return "boolean";
}

/**
 * Validate one call's argument bag against its schema. Rejects unknown
 * fields, missing required fields, wrong types, and non-finite numbers —
 * `NaN`/`Infinity` specifically, because those are the values arithmetic on a
 * bad derived-data read produces and they corrupt a timeline silently rather
 * than loudly.
 */
function validateArgs(
	verb: PrimitiveVerb,
	raw: ProgramValue,
): Record<string, ProgramValue> {
	if (raw === undefined) {
		throw new ProgramRuntimeError(
			`${verb}() needs one object argument, e.g. ${verb}({ … }).`,
		);
	}
	if (!isProgramObject(raw)) {
		throw new ProgramRuntimeError(
			`${verb}() takes a single object argument, got ${describeProgramValue(raw)}.`,
		);
	}
	const schema = VERB_SCHEMAS[verb];
	const out: Record<string, ProgramValue> = {};

	for (const [key, value] of Object.entries(raw)) {
		// `undefined` is treated as "field omitted" rather than an error, so a
		// program can build an arg bag conditionally (`{ duration: maybe }`)
		// without branching around the whole call. `null` is NOT the same thing
		// and is rejected below — passing it through would clobber a default.
		if (value === undefined) continue;
		const expected = schema.fields[key];
		if (!expected) {
			throw new ProgramRuntimeError(
				`${verb}() has no argument "${key}". Accepted: ${Object.keys(schema.fields).join(", ")}.`,
			);
		}
		const actual = typeOfValue(value);
		if (expected !== "any" && actual !== expected) {
			throw new ProgramRuntimeError(
				`${verb}() argument "${key}" must be a ${expected}, got ${actual}.`,
			);
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new ProgramRuntimeError(
				`${verb}() argument "${key}" is ${Number.isNaN(value) ? "NaN" : "infinite"} — a timeline value must be a real number.`,
			);
		}
		out[key] = value;
	}

	for (const key of schema.required) {
		if (!(key in out)) {
			throw new ProgramRuntimeError(`${verb}() requires "${key}".`);
		}
	}
	return out;
}

// ---- Binding ----------------------------------------------------------------

export interface PrimitiveSurfaceOptions {
	/** The live api. Omitted ⇒ dry-run only; a call in apply mode with no api is a host misconfiguration and throws. */
	api?: ProgramPrimitiveApi;
	/** When true nothing is applied: ops are recorded and a synthetic result is returned. */
	dryRun: boolean;
	/** The run's op log — appended in place so the executor can report a partial list after a failure. */
	ops: ProgramOp[];
	meter: ProgramMeter;
	limits: ProgramLimits;
}

/**
 * Bind the ten primitives as {@link HostFunction}s over one run's op log and
 * meter. Returns a fresh table per run: nothing here is module-global, so two
 * concurrent runs can never see each other's ops.
 */
export function createPrimitiveFunctions(
	options: PrimitiveSurfaceOptions,
): Record<PrimitiveVerb, HostFunction> {
	const { api, dryRun, ops, meter, limits } = options;

	const bind = (verb: PrimitiveVerb): HostFunction => {
		return (args: ProgramValue[]): ProgramValue => {
			if (args.length > 1) {
				throw new ProgramRuntimeError(
					`${verb}() takes exactly one object argument, got ${args.length}.`,
				);
			}
			const validated = validateArgs(verb, args[0]);

			const index = ops.length;
			const op: ProgramOp = { index, verb, args: validated };
			// Recorded BEFORE the cap check and before the call, so a run that
			// trips the operation cap — or a verb that throws — still leaves the
			// op it was attempting in the log. "What was it doing when it broke"
			// is the first question anyone asks of a failed run, and an op list
			// that stops one short of the answer is the wrong place to save a
			// slot.
			ops.push(op);

			meter.operations += 1;
			if (meter.operations > limits.maxOperations) {
				throw new ProgramBudgetExceededError(
					"operations",
					limits.maxOperations,
				);
			}

			if (dryRun) {
				return VERB_SCHEMAS[verb].dryRunData?.(index) ?? null;
			}

			if (!api) {
				throw new ProgramRuntimeError(
					`Cannot apply ${verb}() — no DirectorApi is wired into this program run.`,
				);
			}

			const result = (
				api as unknown as Record<
					string,
					(input: Record<string, ProgramValue>) => PrimitiveResult
				>
			)[verb](validated);

			op.result = { ok: result.ok, message: result.message };
			if (!result.ok) {
				throw new ProgramPrimitiveError(index, verb, result.message);
			}
			// The verb's own `data` payload flows back into the program (a split's
			// `newSlotIds`, an addClip's `elementId`) so later statements can
			// address what earlier ones created. Cloned because it crossed the
			// host boundary; `null` when the verb reports no payload.
			return result.data === undefined
				? null
				: cloneProgramValue(result.data as ProgramValue);
		};
	};

	const table = {} as Record<PrimitiveVerb, HostFunction>;
	for (const verb of PRIMITIVE_VERBS) table[verb] = bind(verb);
	return table;
}
