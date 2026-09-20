/**
 * `effect` — one effect attached to a video/image clip (color grade, blur,
 * LUT, …). Source of truth: `types/effects.ts`'s `Effect` interface
 * ({ id, type, params, enabled }) plus the commands that mutate it
 * (`AddClipEffectCommand`, `UpdateClipEffectParamsCommand`,
 * `ToggleClipEffectCommand`, `ReorderClipEffectsCommand`,
 * `RemoveClipEffectCommand` in `timeline-manager.ts`).
 *
 * THE `type` / `effectType` SPLIT IS REAL, NOT A TYPO. The stored object's
 * field is `type` (`Effect.type: string`). Every command that CREATES or
 * ROUTES to an effect spells the same concept `effectType`
 * (`addClipEffect({ trackId, elementId, effectType })`). That is exactly the
 * `trim`-vs-`move` inconsistency the design doc calls out in §5, just one
 * layer down — so `effectType` is registered as an alias for the canonical
 * `type`, not documented as a separate field.
 */

import type { KindSchema } from "../schema";

export const effectSchema: KindSchema = {
	kind: "effect",
	summary:
		"One effect attached to a clip — a color grade, blur, LUT, or similar.",
	fields: {
		id: {
			type: "id",
			of: "effect",
			description: "This effect's own kernel id.",
			readOnly: true,
			readOnlyReason: "identity, not a field — create mints a new one.",
			aliases: ["effectId"],
		},
		elementId: {
			type: "id",
			of: "element",
			description: "The clip this effect is attached to.",
			readOnly: true,
			readOnlyReason: "an effect does not move between clips.",
			aliases: ["clipId", "slotId"],
		},
		type: {
			type: "string",
			description:
				"Which effect this is (a registry key — e.g. a color-grade or blur definition id).",
			readOnly: true,
			readOnlyReason: "fixed at creation; remove and re-add to change it.",
			aliases: ["effectType"],
		},
		enabled: {
			type: "boolean",
			description:
				"Whether this effect is currently applied (toggling skips it without removing it).",
		},
		params: {
			type: "object",
			description:
				"This effect's parameter values, keyed by param name — shape depends on `type`.",
		},
	},
};
