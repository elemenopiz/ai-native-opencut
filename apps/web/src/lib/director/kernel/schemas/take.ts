/**
 * `take` — one generated alternate for a slot. Source of truth:
 * `types/timeline.ts`'s `Take` interface, plus `TimelineManager.updateTake`
 * (which patches `status`/`mediaId`/`thumbnailUrl`/`error`/`jobId` as a
 * generation job progresses).
 *
 * WHY EVERY FIELD IS READ-ONLY. The design doc (§3, Generation) is explicit:
 * `generate()` returns assets, and picking one is
 * `update({ at: element, patch: { activeTake } })` — a write on the ELEMENT,
 * not the take. A take itself is a provenance record the generation pipeline
 * produces and updates; nothing in the kernel's mutation surface is supposed
 * to hand-edit a take's status or swap its media out from under the job that
 * owns it. If a future verb needs to write here, that is a deliberate
 * decision to make elsewhere — not a gap this registry should paper over by
 * guessing a patch shape no verb calls.
 */

import type { KindSchema } from "../schema";

export const takeSchema: KindSchema = {
	kind: "take",
	summary:
		"One generated alternate for a slot — a provenance record, not a hand-edited object.",
	fields: {
		id: {
			type: "id",
			of: "take",
			description: "This take's own kernel id.",
			readOnly: true,
			readOnlyReason: "identity, not a field.",
			aliases: ["takeId"],
		},
		elementId: {
			type: "id",
			of: "element",
			description: "The slot this take belongs to.",
			readOnly: true,
			readOnlyReason: "a take does not move between slots.",
			aliases: ["clipId", "slotId"],
		},
		status: {
			type: "enum",
			values: ["queued", "generating", "ready", "failed"],
			description: "Where this take is in the generation pipeline.",
			readOnly: true,
			readOnlyReason: "written by the generation job as it progresses.",
		},
		mediaId: {
			type: "id",
			of: "asset",
			description:
				"The generated result, once imported as a project asset. Absent while status is queued/generating.",
			readOnly: true,
			readOnlyReason:
				"set when the job lands; select this take onto the element via activeTakeId instead of editing it here.",
		},
		thumbnailUrl: {
			type: "string",
			description: "Preview thumbnail for the filmstrip.",
			readOnly: true,
			readOnlyReason: "produced alongside the generated media.",
		},
		seed: {
			type: "number",
			unit: "dimensionless",
			description:
				"The random seed used for this generation, if seed-locking was active.",
			readOnly: true,
			readOnlyReason: "recorded at generation time for reproducibility.",
		},
		spec: {
			type: "object",
			description:
				"The exact GenerationSpec recipe that produced this take (prompt, model, mode, resolution, seed…).",
			readOnly: true,
			readOnlyReason:
				"a take is a snapshot of the recipe that made it; edit the SLOT's `generation` field to change what the next take will use.",
		},
		jobId: {
			type: "string",
			description:
				"The provider job id, for polling while this take is generating.",
			readOnly: true,
			readOnlyReason: "assigned by the backend at submission.",
		},
		provenance: {
			type: "object",
			description:
				"Which backend produced this take and its commercial-safety tier — { backendId, vendor, model, safetyTier, routedBy, seedLocked, generatedAt }.",
			readOnly: true,
			readOnlyReason: "recorded by the router at generation time.",
		},
		cost: {
			type: "object",
			description:
				"Normalized cost of this take — { credits, usd?, basis?, estimated? }.",
			readOnly: true,
			readOnlyReason:
				"computed by the billing layer, before and after generation.",
		},
		createdAt: {
			type: "number",
			unit: "epoch-ms",
			description: "When this take was requested.",
			readOnly: true,
			readOnlyReason: "stamped at creation.",
		},
		error: {
			type: "string",
			description: 'Failure message, present only when status is "failed".',
			readOnly: true,
			readOnlyReason: "written by the generation job on failure.",
		},
	},
};
