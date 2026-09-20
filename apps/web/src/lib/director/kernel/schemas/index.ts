/**
 * The per-kind field registry. Assembles the eleven kinds Agent A owns
 * (`element`, `track`, `take`, `effect`, `keyframe`, `marker`, `scene`,
 * `asset`, `project`, `selection`, `playhead`) into the `SchemaRegistry`
 * `read.ts` and `update`'s validator are written against. Kinds outside this
 * set (`commit`/`branch`/`history`/`brief`/`bible`/`budget`/`consent`) are a
 * different agent's build order step (§7's `version` verb and the policy
 * surfaces in §4) and are deliberately absent — `schemaFor` throws a named,
 * teaching error for them rather than silently returning nothing.
 *
 * Each kind's derivation notes — which manager method is the writer for
 * every field, and why a field is read-only or aliased — live as a doc
 * comment at the top of that kind's own file, not repeated here.
 */

import type { KernelKind } from "../ids";
import type { KindSchema, SchemaRegistry } from "../schema";
import { assetSchema } from "./asset";
import { effectSchema } from "./effect";
import { elementSchema } from "./element";
import { keyframeSchema } from "./keyframe";
import { markerSchema } from "./marker";
import { playheadSchema } from "./playhead";
import { projectSchema } from "./project";
import { sceneSchema } from "./scene";
import { selectionSchema } from "./selection";
import { takeSchema } from "./take";
import { trackSchema } from "./track";

export const KIND_SCHEMAS: SchemaRegistry = {
	element: elementSchema,
	track: trackSchema,
	take: takeSchema,
	effect: effectSchema,
	keyframe: keyframeSchema,
	marker: markerSchema,
	scene: sceneSchema,
	asset: assetSchema,
	project: projectSchema,
	selection: selectionSchema,
	playhead: playheadSchema,
};

/** Throws a teaching error rather than returning undefined — an unaddressable kind is a bug we want named at the call site. */
export function schemaFor(kind: KernelKind): KindSchema {
	const schema = KIND_SCHEMAS[kind];
	if (!schema) {
		throw new Error(
			`No schema registered for kind "${kind}". Registered: ${Object.keys(KIND_SCHEMAS).sort().join(", ") || "(none)"}.`,
		);
	}
	return schema;
}
