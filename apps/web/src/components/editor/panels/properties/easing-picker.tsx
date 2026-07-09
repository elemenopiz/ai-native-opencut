"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useKeyframeSelection } from "@/hooks/timeline/element/use-keyframe-selection";
import {
	EASING_PRESET_OPTIONS,
	easingFromPreset,
	getChannel,
	matchEasingPreset,
} from "@/lib/animation";
import { isVisualElement } from "@/lib/timeline";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type {
	EasingPresetId,
	SelectedKeyframeRef,
} from "@/types/animation";

const MIXED_VALUE = "__mixed__";

function getKeyframeEasingPreset({
	editor,
	keyframe,
}: {
	editor: ReturnType<typeof useEditor>;
	keyframe: SelectedKeyframeRef;
}): EasingPresetId | null {
	const track = editor.timeline.getTrackById({ trackId: keyframe.trackId });
	const element = track?.elements.find(
		(candidate) => candidate.id === keyframe.elementId,
	);
	if (!element || !isVisualElement(element)) {
		return null;
	}

	const channel = getChannel({
		animations: element.animations,
		propertyPath: keyframe.propertyPath,
	});
	if (!channel || channel.valueKind === "discrete") {
		return null;
	}

	const target = channel.keyframes.find(
		(candidate) => candidate.id === keyframe.keyframeId,
	);
	if (!target) {
		return null;
	}

	if (!target.easing) {
		return "linear";
	}
	return matchEasingPreset({ bezier: target.easing.bezier }) ?? null;
}

/**
 * Dropdown that sets the cubic-bezier easing on the currently selected
 * keyframe(s). Renders nothing when no easable (continuous) keyframe is
 * selected. The full bezier-handle graph editor remains a follow-up.
 */
export function EasingPicker() {
	const editor = useEditor();
	const { selectedKeyframes } = useKeyframeSelection();

	// Re-render when the underlying keyframe data changes (easing, add/remove).
	useSyncExternalStore(
		(listener) => editor.timeline.subscribe(listener),
		() => editor.timeline.getTracks(),
		() => editor.timeline.getTracks(),
	);

	const easablePresets = selectedKeyframes.map((keyframe) =>
		getKeyframeEasingPreset({ editor, keyframe }),
	);
	const easableKeyframes = selectedKeyframes.filter(
		(_, index) => easablePresets[index] !== null,
	);

	const handleChange = useCallback(
		(nextValue: string) => {
			if (nextValue === MIXED_VALUE) {
				return;
			}
			const preset = nextValue as EasingPresetId;
			editor.timeline.setKeyframesEasing({
				keyframes: easableKeyframes,
				// Linear is the default: clear easing so pre-easing data shape and
				// behavior are preserved.
				easing: preset === "linear" ? undefined : easingFromPreset({ preset }),
			});
		},
		[editor, easableKeyframes],
	);

	if (easableKeyframes.length === 0) {
		return null;
	}

	const distinctPresets = new Set(
		easablePresets.filter((preset): preset is EasingPresetId => preset !== null),
	);
	const selectedValue =
		distinctPresets.size === 1 ? [...distinctPresets][0] : MIXED_VALUE;

	return (
		<div className="flex items-center justify-between gap-2 border-t px-3 py-2">
			<span className="text-[11px] font-medium text-muted-foreground">
				Easing
			</span>
			<Select value={selectedValue} onValueChange={handleChange}>
				<SelectTrigger className="h-7 w-36 text-xs">
					<SelectValue placeholder="Mixed" />
				</SelectTrigger>
				<SelectContent>
					{selectedValue === MIXED_VALUE && (
						<SelectItem value={MIXED_VALUE} disabled>
							Mixed
						</SelectItem>
					)}
					{EASING_PRESET_OPTIONS.map((option) => (
						<SelectItem key={option.id} value={option.id}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
