import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import { isVisualElement, updateElementInTracks } from "@/lib/timeline";
import type { TimelineTrack, VisualElement } from "@/types/timeline";
import type { ElementAnimations } from "@/types/animation";

/**
 * Effect-param keyframes live in `element.animations.channels` under a
 * synthetic path `effects.<effectId>.params.<paramKey>` (see
 * `upsertEffectParamKeyframe` in `lib/animation/effect-param-channel.ts`).
 * Removing the effect without pruning those channels leaves dangling
 * animation data keyed to an effect that no longer exists — the same
 * dangling-reference class BUG34 fixed for asset delete, just scoped to a
 * single element's animation map instead of cross-store. Harmless to
 * playback (nothing resolves a dead effect's params), but it's inert bloat
 * that survives forever (including through save/load) unless pruned here.
 */
function pruneEffectParamChannels({
	animations,
	effectId,
}: {
	animations: ElementAnimations | undefined;
	effectId: string;
}): ElementAnimations | undefined {
	if (!animations) return animations;

	const prefix = `effects.${effectId}.params.`;
	const entries = Object.entries(animations.channels);
	const kept = entries.filter(([path]) => !path.startsWith(prefix));
	if (kept.length === entries.length) return animations;

	return { channels: Object.fromEntries(kept) };
}

function removeEffectFromElement({
	element,
	effectId,
}: {
	element: VisualElement;
	effectId: string;
}): VisualElement {
	const currentEffects = element.effects ?? [];
	const filtered = currentEffects.filter((effect) => effect.id !== effectId);
	return {
		...element,
		effects: filtered,
		animations: pruneEffectParamChannels({
			animations: element.animations,
			effectId,
		}),
	};
}

export class RemoveClipEffectCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly effectId: string;

	constructor({
		trackId,
		elementId,
		effectId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.effectId = effectId;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const updatedTracks = updateElementInTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: isVisualElement,
			update: (element) => {
				return removeEffectFromElement({
					element: element as VisualElement,
					effectId: this.effectId,
				});
			},
		});

		editor.timeline.updateTracks(updatedTracks);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
