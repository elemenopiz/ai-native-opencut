import type { EditorCore } from "@/core";
import type { EffectParamValues } from "@/types/effects";
import type {
	TrackType,
	TimelineTrack,
	TimelineElement,
	ClipboardItem,
	CreateUploadAudioElement,
	CreateVideoElement,
	GenerationSpec,
	Take,
} from "@/types/timeline";
import {
	buildUploadAudioElement,
	buildVideoElement,
} from "@/lib/timeline/element-utils";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import type {
	AnimationInterpolation,
	AnimationPropertyPath,
	AnimationValue,
	KeyframeClipboardItem,
	KeyframeEasing,
	SelectedKeyframeRef,
} from "@/types/animation";
import { collectKeyframeClipboardItems } from "@/lib/animation";
import { calculateTotalDuration } from "@/lib/timeline";
import {
	AddTrackCommand,
	RemoveTrackCommand,
	ToggleTrackMuteCommand,
	ToggleTrackVisibilityCommand,
	InsertElementCommand,
	UpdateElementTrimCommand,
	UpdateElementDurationCommand,
	DeleteElementsCommand,
	DuplicateElementsCommand,
	ToggleElementsVisibilityCommand,
	ToggleElementsMutedCommand,
	ToggleSourceAudioSeparationCommand,
	UpdateElementCommand,
	SplitElementsCommand,
	PasteCommand,
	UpdateElementStartTimeCommand,
	MoveElementCommand,
	MoveElementsCommand,
	ResizeElementsCommand,
	TracksSnapshotCommand,
	UpsertKeyframeCommand,
	RemoveKeyframeCommand,
	RetimeKeyframeCommand,
	SetKeyframeEasingCommand,
	AddClipEffectCommand,
	RemoveClipEffectCommand,
	UpdateClipEffectParamsCommand,
	ToggleClipEffectCommand,
	ReorderClipEffectsCommand,
	UpsertEffectParamKeyframeCommand,
	RemoveEffectParamKeyframeCommand,
	PasteKeyframesCommand,
} from "@/lib/commands/timeline";
import { BatchCommand, PreviewTracker } from "@/lib/commands";
import type { InsertElementParams } from "@/lib/commands/timeline/element/insert-element";
import {
	buildMoveGroup,
	resolveGroupMove,
	type ElementRef,
	type GroupMoveTarget,
} from "@/lib/timeline/group-move";
import type { GroupResizeUpdate } from "@/lib/timeline/group-resize";

export class TimelineManager {
	private listeners = new Set<() => void>();
	private previewTracker = new PreviewTracker<TimelineTrack[]>();

	constructor(private editor: EditorCore) {}

	addTrack({ type, index }: { type: TrackType; index?: number }): string {
		const command = new AddTrackCommand(type, index);
		this.editor.command.execute({ command });
		return command.getTrackId();
	}

	removeTrack({ trackId }: { trackId: string }): void {
		const command = new RemoveTrackCommand(trackId);
		this.editor.command.execute({ command });
	}

	/** Insert an element onto the timeline. Returns the new element's id (see
	 *  `InsertElementCommand.getElementId()`) so callers that need it (e.g. the
	 *  Director API's `addText`) don't have to re-scan tracks afterward. */
	insertElement({ element, placement }: InsertElementParams): string {
		const command = new InsertElementCommand({ element, placement });
		this.editor.command.execute({ command });
		return command.getElementId();
	}

	updateElementTrim({
		elementId,
		trimStart,
		trimEnd,
		startTime,
		duration,
		pushHistory = true,
		rippleEnabled = false,
	}: {
		elementId: string;
		trimStart: number;
		trimEnd: number;
		startTime?: number;
		duration?: number;
		pushHistory?: boolean;
		rippleEnabled?: boolean;
	}): void {
		const command = new UpdateElementTrimCommand({
			elementId,
			trimStart,
			trimEnd,
			startTime,
			duration,
			rippleEnabled,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	updateElementDuration({
		trackId,
		elementId,
		duration,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		duration: number;
		pushHistory?: boolean;
	}): void {
		const command = new UpdateElementDurationCommand({
			trackId,
			elementId,
			duration,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	updateElementStartTime({
		elements,
		startTime,
	}: {
		elements: { trackId: string; elementId: string }[];
		startTime: number;
	}): void {
		const command = new UpdateElementStartTimeCommand({
			elements,
			startTime,
		});
		this.editor.command.execute({ command });
	}

	moveElement({
		sourceTrackId,
		targetTrackId,
		elementId,
		newStartTime,
		createTrack,
		rippleEnabled = false,
	}: {
		sourceTrackId: string;
		targetTrackId: string;
		elementId: string;
		newStartTime: number;
		createTrack?: { type: TrackType; index: number };
		rippleEnabled?: boolean;
	}): void {
		const command = new MoveElementCommand({
			sourceTrackId,
			targetTrackId,
			elementId,
			newStartTime,
			createTrack,
			rippleEnabled,
		});
		this.editor.command.execute({ command });
	}

	/** Multi-select counterpart to `moveElement` — moves every member of
	 *  `group` (anchor + rest of the selection) together, preserving each
	 *  member's time offset from the anchor and, for cross-track drags, its
	 *  relative track position. Returns the moved elements' new refs (to
	 *  become the new selection), or null when the drop is invalid (out of
	 *  bounds, type-incompatible target track, or would overlap another
	 *  element) — callers should treat null as "reject the drop" and leave
	 *  the timeline untouched, same as the single-element `!dropTarget`
	 *  guard. */
	moveElements({
		anchorRef,
		selectedElements,
		anchorStartTime,
		target,
	}: {
		anchorRef: ElementRef;
		selectedElements: ElementRef[];
		anchorStartTime: number;
		target: GroupMoveTarget;
	}): ElementRef[] | null {
		const tracks = this.getTracks();
		const group = buildMoveGroup({ anchorRef, selectedElements, tracks });
		if (!group) return null;

		const result = resolveGroupMove({ group, tracks, anchorStartTime, target });
		if (!result) return null;

		const command = new MoveElementsCommand(result);
		this.editor.command.execute({ command });
		return result.targetSelection;
	}

	/** Multi-select counterpart to `updateElementTrim` — applies a resolved
	 *  group-resize plan (see `lib/timeline/group-resize.ts`) to every member
	 *  atomically. `updates` is expected to already be the fully clamped
	 *  result of `computeGroupResize`. */
	resizeElements({ updates }: { updates: GroupResizeUpdate[] }): void {
		if (updates.length === 0) return;
		const command = new ResizeElementsCommand(updates);
		this.editor.command.execute({ command });
	}

	toggleTrackMute({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackMuteCommand(trackId);
		this.editor.command.execute({ command });
	}

	toggleTrackVisibility({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackVisibilityCommand(trackId);
		this.editor.command.execute({ command });
	}

	splitElements({
		elements,
		splitTime,
		retainSide = "both",
		rippleEnabled = false,
	}: {
		elements: { trackId: string; elementId: string }[];
		splitTime: number;
		retainSide?: "both" | "left" | "right";
		rippleEnabled?: boolean;
	}): { trackId: string; elementId: string }[] {
		const command = new SplitElementsCommand({
			elements,
			splitTime,
			retainSide,
			rippleEnabled,
		});
		this.editor.command.execute({ command });
		return command.getRightSideElements();
	}

	getTotalDuration(): number {
		return calculateTotalDuration({ tracks: this.getTracks() });
	}

	getTrackById({ trackId }: { trackId: string }): TimelineTrack | null {
		return this.getTracks().find((track) => track.id === trackId) ?? null;
	}

	getElementsWithTracks({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): Array<{ track: TimelineTrack; element: TimelineElement }> {
		const result: Array<{ track: TimelineTrack; element: TimelineElement }> =
			[];

		for (const { trackId, elementId } of elements) {
			const track = this.getTrackById({ trackId });
			const element = track?.elements.find(
				(trackElement) => trackElement.id === elementId,
			);

			if (track && element) {
				result.push({ track, element });
			}
		}

		return result;
	}

	pasteAtTime({
		time,
		clipboardItems,
	}: {
		time: number;
		clipboardItems: ClipboardItem[];
	}): { trackId: string; elementId: string }[] {
		const command = new PasteCommand(time, clipboardItems);
		this.editor.command.execute({ command });
		return command.getPastedElements();
	}

	deleteElements({
		elements,
		rippleEnabled = false,
	}: {
		elements: { trackId: string; elementId: string }[];
		rippleEnabled?: boolean;
	}): void {
		const command = new DeleteElementsCommand({ elements, rippleEnabled });
		this.editor.command.execute({ command });
	}

	updateElements({
		updates,
		pushHistory = true,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			updates: Partial<TimelineElement>;
		}>;
		pushHistory?: boolean;
	}): void {
		const commands = updates.map(
			({ trackId, elementId, updates: elementUpdates }) =>
				new UpdateElementCommand({
					trackId,
					elementId,
					updates: elementUpdates,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	// ── AI-native generative slots & takes ────────────────────────────────────
	// A generative slot is a video/image clip that carries a `generation` recipe
	// and a list of `takes` (generated alternates). Selecting a take is
	// non-destructive — it swaps `activeTakeId` and mirrors that take's media
	// onto the clip's `mediaId`, so a filled slot behaves like any other clip.
	// Everything here routes through the command stack, so it's all undoable.

	/** Insert an empty generative slot — a clip with a prompt/spec but no media
	 *  yet. It occupies real time so the reel can be storyboarded first. Returns
	 *  the new element id. */
	addGenerativeSlot({
		spec,
		duration,
		startTime,
		trackId,
	}: {
		spec?: GenerationSpec;
		duration?: number;
		startTime?: number;
		trackId?: string;
	}): string {
		const slotDuration =
			duration ?? spec?.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
		const element: CreateVideoElement = {
			...buildVideoElement({
				mediaId: "",
				name: spec?.prompt?.trim().slice(0, 40) || "Generative slot",
				duration: slotDuration,
				startTime: startTime ?? 0,
			}),
			generation: spec,
			takes: [],
		};
		const command = new InsertElementCommand({
			element,
			placement: trackId
				? { mode: "explicit", trackId }
				: { mode: "auto", trackType: "video" },
		});
		this.editor.command.execute({ command });
		return command.getElementId();
	}

	/** Insert an empty voiceover slot — the audio twin of `addGenerativeSlot`:
	 *  an upload-audio clip carrying a TTS `generation` recipe
	 *  (`spec.kind === "voiceover"`, `prompt` = spoken text) but no media yet.
	 *  TTS takes land on it via the same take bookkeeping below. Returns the
	 *  new element id. */
	addVoiceoverSlot({
		spec,
		duration,
		startTime,
		trackId,
	}: {
		spec?: GenerationSpec;
		duration?: number;
		startTime?: number;
		trackId?: string;
	}): string {
		const slotDuration =
			duration ?? spec?.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
		const element: CreateUploadAudioElement = {
			...buildUploadAudioElement({
				mediaId: "",
				name: spec?.prompt?.trim().slice(0, 40) || "Voiceover slot",
				duration: slotDuration,
				startTime: startTime ?? 0,
			}),
			generation: spec,
			takes: [],
		};
		const command = new InsertElementCommand({
			element,
			placement: trackId
				? { mode: "explicit", trackId }
				: { mode: "auto", trackType: "audio" },
		});
		this.editor.command.execute({ command });
		return command.getElementId();
	}

	/** Replace a slot's generation recipe. */
	setSlotSpec({
		elementId,
		spec,
	}: {
		elementId: string;
		spec: GenerationSpec;
	}): void {
		const found = this.findElementById({ elementId });
		if (!found) return;
		this.updateElements({
			updates: [
				{ trackId: found.trackId, elementId, updates: { generation: spec } },
			],
		});
	}

	/** Append a take to a clip (when a job is enqueued, then again as it lands). */
	addTakeToElement({
		elementId,
		take,
	}: {
		elementId: string;
		take: Take;
	}): void {
		const found = this.findElementById({ elementId });
		if (!found) return;
		const takes = [...this.getElementTakes(found.element), take];
		this.updateElements({
			updates: [{ trackId: found.trackId, elementId, updates: { takes } }],
		});
	}

	/** Patch a single take in place (status, mediaId, thumbnail, error, …). */
	updateTake({
		elementId,
		takeId,
		patch,
	}: {
		elementId: string;
		takeId: string;
		patch: Partial<Take>;
	}): void {
		const found = this.findElementById({ elementId });
		if (!found) return;
		const takes = this.getElementTakes(found.element).map((take) =>
			take.id === takeId ? { ...take, ...patch } : take,
		);
		// Keep the clip's mirrored media in sync. If the take that was just patched
		// is the active one and it gained a mediaId (e.g. it finished generating),
		// mirror that onto the element too — otherwise the clip keeps rendering the
		// previously-active take's media until the user reselects.
		const activeTakeId = this.getActiveTakeId(found.element);
		this.updateElements({
			updates: [
				{
					trackId: found.trackId,
					elementId,
					updates: {
						takes,
						...(takeId === activeTakeId && patch.mediaId
							? { mediaId: patch.mediaId }
							: {}),
					},
				},
			],
		});
	}

	/** Choose the active take — non-destructive; mirrors its media onto the clip. */
	selectTake({
		elementId,
		takeId,
	}: {
		elementId: string;
		takeId: string;
	}): void {
		const found = this.findElementById({ elementId });
		if (!found) return;
		const take = this.getElementTakes(found.element).find(
			(t) => t.id === takeId,
		);
		if (!take) return;
		this.updateElements({
			updates: [
				{
					trackId: found.trackId,
					elementId,
					updates: {
						activeTakeId: takeId,
						// Always mirror the take's media — including the empty-slot
						// sentinel ("") when the selected take is still generating — so
						// the clip never shows a *different* take's frames than the one
						// marked active. updateTake() re-mirrors once the take lands.
						mediaId: take.mediaId ?? "",
					},
				},
			],
		});
	}

	/** Remove a take. If it was the active one, clears the active selection. */
	removeTake({
		elementId,
		takeId,
	}: {
		elementId: string;
		takeId: string;
	}): void {
		const found = this.findElementById({ elementId });
		if (!found) return;
		const takes = this.getElementTakes(found.element).filter(
			(t) => t.id !== takeId,
		);
		const wasActive = this.getActiveTakeId(found.element) === takeId;
		this.updateElements({
			updates: [
				{
					trackId: found.trackId,
					elementId,
					updates: {
						takes,
						...(wasActive ? { activeTakeId: undefined } : {}),
					},
				},
			],
		});
	}

	private findElementById({
		elementId,
	}: {
		elementId: string;
	}): { trackId: string; element: TimelineElement } | null {
		for (const track of this.getTracks()) {
			const element = track.elements.find((e) => e.id === elementId);
			if (element) return { trackId: track.id, element };
		}
		return null;
	}

	private getElementTakes(element: TimelineElement): Take[] {
		// Narrow on the element type so the generative fields are read through the
		// static union (a rename becomes a compile error, not silent data loss).
		// Audio is included because voiceover slots hold TTS takes (see
		// `GenerativeFields` on `BaseAudioElement`).
		return element.type === "video" ||
			element.type === "image" ||
			element.type === "audio"
			? (element.takes ?? [])
			: [];
	}

	private getActiveTakeId(element: TimelineElement): string | undefined {
		return element.type === "video" ||
			element.type === "image" ||
			element.type === "audio"
			? element.activeTakeId
			: undefined;
	}

	addClipEffect({
		trackId,
		elementId,
		effectType,
	}: {
		trackId: string;
		elementId: string;
		effectType: string;
	}): string {
		const command = new AddClipEffectCommand({
			trackId,
			elementId,
			effectType,
		});
		this.editor.command.execute({ command });
		return command.getEffectId() ?? "";
	}

	removeClipEffect({
		trackId,
		elementId,
		effectId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
	}): void {
		const command = new RemoveClipEffectCommand({
			trackId,
			elementId,
			effectId,
		});
		this.editor.command.execute({ command });
	}

	updateClipEffectParams({
		trackId,
		elementId,
		effectId,
		params,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		params: Partial<EffectParamValues>;
		pushHistory?: boolean;
	}): void {
		const command = new UpdateClipEffectParamsCommand({
			trackId,
			elementId,
			effectId,
			params,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	toggleClipEffect({
		trackId,
		elementId,
		effectId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
	}): void {
		const command = new ToggleClipEffectCommand({
			trackId,
			elementId,
			effectId,
		});
		this.editor.command.execute({ command });
	}

	reorderClipEffects({
		trackId,
		elementId,
		fromIndex,
		toIndex,
	}: {
		trackId: string;
		elementId: string;
		fromIndex: number;
		toIndex: number;
	}): void {
		const command = new ReorderClipEffectsCommand({
			trackId,
			elementId,
			fromIndex,
			toIndex,
		});
		this.editor.command.execute({ command });
	}

	upsertKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPropertyPath;
			time: number;
			value: AnimationValue;
			interpolation?: AnimationInterpolation;
			easing?: KeyframeEasing;
			keyframeId?: string;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		const commands = keyframes.map(
			({
				trackId,
				elementId,
				propertyPath,
				time,
				value,
				interpolation,
				easing,
				keyframeId,
			}) =>
				new UpsertKeyframeCommand({
					trackId,
					elementId,
					propertyPath,
					time,
					value,
					interpolation,
					easing,
					keyframeId,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	setKeyframesEasing({
		keyframes,
		easing,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPropertyPath;
			keyframeId: string;
		}>;
		easing: KeyframeEasing | undefined;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		const commands = keyframes.map(
			({ trackId, elementId, propertyPath, keyframeId }) =>
				new SetKeyframeEasingCommand({
					trackId,
					elementId,
					propertyPath,
					keyframeId,
					easing,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	removeKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPropertyPath;
			keyframeId: string;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		const commands = keyframes.map(
			({ trackId, elementId, propertyPath, keyframeId }) =>
				new RemoveKeyframeCommand({
					trackId,
					elementId,
					propertyPath,
					keyframeId,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	/**
	 * Build a portable clipboard payload from the given selected keyframes. Only
	 * keyframes belonging to a single source element are copyable (mixed-element
	 * selections return null); this keeps the relative-time model unambiguous.
	 * The payload preserves each keyframe's value, interpolation and easing
	 * (bezier curve) so a later paste reproduces the animation exactly.
	 */
	copyKeyframes({
		keyframes,
	}: {
		keyframes: SelectedKeyframeRef[];
	}): KeyframeClipboardItem[] | null {
		if (keyframes.length === 0) {
			return null;
		}

		const source = keyframes[0];
		const isSingleSource = keyframes.every(
			(keyframe) =>
				keyframe.trackId === source.trackId &&
				keyframe.elementId === source.elementId,
		);
		if (!isSingleSource) {
			return null;
		}

		const [result] = this.getElementsWithTracks({
			elements: [{ trackId: source.trackId, elementId: source.elementId }],
		});
		if (!result) {
			return null;
		}

		const items = collectKeyframeClipboardItems({
			animations: result.element.animations,
			selectedKeyframes: keyframes,
		});
		return items.length > 0 ? items : null;
	}

	/**
	 * Paste a copied keyframe payload onto the target element, rebasing the set
	 * onto `time`. Curve-aware: interpolation and easing survive the round-trip,
	 * and items whose property the target element doesn't support are skipped.
	 */
	pasteKeyframes({
		trackId,
		elementId,
		time,
		clipboardItems,
	}: {
		trackId: string;
		elementId: string;
		time: number;
		clipboardItems: KeyframeClipboardItem[];
	}): void {
		if (clipboardItems.length === 0) {
			return;
		}

		const command = new PasteKeyframesCommand({
			trackId,
			elementId,
			time,
			clipboardItems,
		});
		this.editor.command.execute({ command });
	}

	retimeKeyframe({
		trackId,
		elementId,
		propertyPath,
		keyframeId,
		time,
	}: {
		trackId: string;
		elementId: string;
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
		time: number;
	}): void {
		const command = new RetimeKeyframeCommand({
			trackId,
			elementId,
			propertyPath,
			keyframeId,
			nextTime: time,
		});
		this.editor.command.execute({ command });
	}

	upsertEffectParamKeyframe({
		trackId,
		elementId,
		effectId,
		paramKey,
		time,
		value,
		interpolation,
		keyframeId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		paramKey: string;
		time: number;
		value: number;
		interpolation?: "linear" | "hold";
		keyframeId?: string;
	}): void {
		const command = new UpsertEffectParamKeyframeCommand({
			trackId,
			elementId,
			effectId,
			paramKey,
			time,
			value,
			interpolation,
			keyframeId,
		});
		this.editor.command.execute({ command });
	}

	removeEffectParamKeyframe({
		trackId,
		elementId,
		effectId,
		paramKey,
		keyframeId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		paramKey: string;
		keyframeId: string;
	}): void {
		const command = new RemoveEffectParamKeyframeCommand({
			trackId,
			elementId,
			effectId,
			paramKey,
			keyframeId,
		});
		this.editor.command.execute({ command });
	}

	isPreviewActive(): boolean {
		return this.previewTracker.isActive();
	}

	previewElements({
		updates,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			updates: Partial<TimelineElement>;
		}>;
	}): void {
		const tracks = this.getTracks();
		this.previewTracker.begin({ state: tracks });

		let updatedTracks = tracks;
		for (const { trackId, elementId, updates: elementUpdates } of updates) {
			updatedTracks = updatedTracks.map((track) => {
				if (track.id !== trackId) return track;
				const newElements = track.elements.map((element) =>
					element.id === elementId
						? { ...element, ...elementUpdates }
						: element,
				);
				return { ...track, elements: newElements } as TimelineTrack;
			});
		}
		this.updateTracks(updatedTracks);
	}

	commitPreview(): void {
		const snapshot = this.previewTracker.end();
		if (snapshot === null) return;
		const currentTracks = this.getTracks();
		const command = new TracksSnapshotCommand(snapshot, currentTracks);
		this.editor.command.push({ command });
	}

	discardPreview(): void {
		const snapshot = this.previewTracker.end();
		if (snapshot !== null) {
			this.updateTracks(snapshot);
		}
	}

	duplicateElements({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): { trackId: string; elementId: string }[] {
		const command = new DuplicateElementsCommand({ elements });
		this.editor.command.execute({ command });
		return command.getDuplicatedElements();
	}

	toggleElementsVisibility({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): void {
		const command = new ToggleElementsVisibilityCommand(elements);
		this.editor.command.execute({ command });
	}

	toggleElementsMuted({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): void {
		const command = new ToggleElementsMutedCommand(elements);
		this.editor.command.execute({ command });
	}

	/** Toggle a video clip's audio between linked and detached (extracted onto
	 *  its own audio-track element). See `ToggleSourceAudioSeparationCommand`. */
	toggleSourceAudioSeparation({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}): void {
		const command = new ToggleSourceAudioSeparationCommand({
			trackId,
			elementId,
		});
		this.editor.command.execute({ command });
	}

	getTracks(): TimelineTrack[] {
		return this.editor.scenes.getActiveSceneOrNull()?.tracks ?? [];
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => fn());
	}

	renameTrack({ trackId, name }: { trackId: string; name: string }): void {
		const tracks = this.getTracks();
		const updatedTracks = tracks.map((track) =>
			track.id === trackId ? { ...track, name } : track,
		) as TimelineTrack[];
		this.updateTracks(updatedTracks);
	}

	updateTrack({
		trackId,
		updates,
	}: {
		trackId: string;
		updates: Partial<{
			muted: boolean;
			hidden: boolean;
			volume: number;
			pan: number;
			solo: boolean;
			color: string;
			locked: boolean;
		}>;
	}): void {
		const tracks = this.getTracks();
		const updatedTracks = tracks.map((track) =>
			track.id === trackId ? { ...track, ...updates } : track,
		) as TimelineTrack[];
		this.updateTracks(updatedTracks);
	}

	setTrackColor({ trackId, color }: { trackId: string; color: string }): void {
		this.updateTrack({ trackId, updates: { color } as any });
	}

	toggleTrackLock({ trackId }: { trackId: string }): void {
		const track = this.getTracks().find((t) => t.id === trackId);
		if (!track) return;
		this.updateTrack({
			trackId,
			updates: { locked: !(track as any).locked } as any,
		});
	}

	isTrackLocked(trackId: string): boolean {
		const track = this.getTracks().find((t) => t.id === trackId);
		return !!(track as any)?.locked;
	}

	reorderTracks({
		fromIndex,
		toIndex,
	}: {
		fromIndex: number;
		toIndex: number;
	}): void {
		const currentTracks = this.getTracks();
		if (fromIndex === toIndex) return;
		if (fromIndex < 0 || fromIndex >= currentTracks.length) return;
		if (toIndex < 0 || toIndex >= currentTracks.length) return;

		const before = [...currentTracks];
		const after = [...currentTracks];
		const [moved] = after.splice(fromIndex, 1);
		after.splice(toIndex, 0, moved);

		const command = new TracksSnapshotCommand(before, after);
		this.editor.command.execute({ command });
	}

	updateTracks(newTracks: TimelineTrack[]): void {
		this.editor.scenes.updateSceneTracks({ tracks: newTracks });
		this.notify();
	}
}
