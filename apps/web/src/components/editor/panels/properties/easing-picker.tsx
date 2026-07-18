"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useKeyframeSelection } from "@/hooks/timeline/element/use-keyframe-selection";
import {
	easingFromBezier,
	getChannel,
	matchEasingPreset,
	resolveEasingControlPoints,
	setElementKeyframeEasing,
} from "@/lib/animation";
import { isVisualElement } from "@/lib/timeline";
import { BezierCurveThumb } from "./bezier-graph";
import { EasingGraphPopover } from "./easing-graph-popover";
import type {
	CubicBezierControlPoints,
	SelectedKeyframeRef,
} from "@/types/animation";

const LINEAR_BEZIER: CubicBezierControlPoints = [0, 0, 1, 1];

interface EasableKeyframe {
	ref: SelectedKeyframeRef;
	bezier: CubicBezierControlPoints;
}

function resolveEasableKeyframe({
	editor,
	keyframe,
}: {
	editor: ReturnType<typeof useEditor>;
	keyframe: SelectedKeyframeRef;
}): EasableKeyframe | null {
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

	return {
		ref: keyframe,
		bezier: resolveEasingControlPoints({ easing: target.easing }),
	};
}

/**
 * Popover-based bezier value-graph easing editor for the currently selected
 * keyframe(s): draggable control-point handles, a preset grid, and a
 * localStorage-backed "Saved" tab. Renders nothing when no easable
 * (continuous) keyframe is selected — applies uniformly to number and color
 * keyframes since the gate below is `valueKind !== "discrete"`.
 *
 * Ported from OpenCut-app/OpenCut's pre-rewrite graph editor (see
 * bezier-graph.tsx / easing-graph-popover.tsx for provenance) and bound
 * directly to our `KeyframeEasing.bezier` — no handle<->bezier conversion
 * needed since we store the curve control points on the keyframe itself
 * (their `curve-bridge.ts` doesn't apply to our data model).
 */
export function EasingPicker() {
	const editor = useEditor();
	const { selectedKeyframes } = useKeyframeSelection();
	const [isOpen, setIsOpen] = useState(false);

	// Re-render when the underlying keyframe data changes (easing, add/remove).
	useSyncExternalStore(
		(listener) => editor.timeline.subscribe(listener),
		() => editor.timeline.getTracks(),
		() => editor.timeline.getTracks(),
	);

	const easableKeyframes = useMemo(
		() =>
			selectedKeyframes
				.map((keyframe) => resolveEasableKeyframe({ editor, keyframe }))
				.filter((entry): entry is EasableKeyframe => entry !== null),
		[editor, selectedKeyframes],
	);

	const distinctBeziers = useMemo(() => {
		const seen = new Map<string, CubicBezierControlPoints>();
		for (const { bezier } of easableKeyframes) {
			seen.set(bezier.join(","), bezier);
		}
		return [...seen.values()];
	}, [easableKeyframes]);

	const isMixed = distinctBeziers.length > 1;
	// Seed the graph with the shared current curve; when the selection is
	// mixed there's no single "current" value, so default to linear — the
	// same way picking a preset while mixed applies it uniformly.
	const currentBezier = distinctBeziers[0] ?? LINEAR_BEZIER;

	const applyBezier = useCallback(
		(bezier: CubicBezierControlPoints) => {
			const matchedPreset = matchEasingPreset({ bezier });
			editor.timeline.setKeyframesEasing({
				keyframes: easableKeyframes.map((keyframe) => keyframe.ref),
				// Linear is the default: clear easing so pre-easing data shape and
				// behavior are preserved.
				easing:
					matchedPreset === "linear" ? undefined : easingFromBezier({ bezier }),
			});
		},
		[editor, easableKeyframes],
	);

	// Live drag preview: paint the dragged curve immediately via the
	// preview/commit channel (mirrors hooks/use-transform-handles.ts and
	// hooks/use-mask-handles.ts) instead of executing a command on every
	// pointer move. The real commit (below) discards this preview and runs
	// the actual command from the clean pre-drag state.
	const previewBezier = useCallback(
		(bezier: CubicBezierControlPoints) => {
			const easing = easingFromBezier({ bezier });
			const groups = new Map<
				string,
				{ trackId: string; elementId: string; refs: SelectedKeyframeRef[] }
			>();
			for (const { ref } of easableKeyframes) {
				const key = `${ref.trackId}:${ref.elementId}`;
				const group = groups.get(key);
				if (group) {
					group.refs.push(ref);
				} else {
					groups.set(key, {
						trackId: ref.trackId,
						elementId: ref.elementId,
						refs: [ref],
					});
				}
			}

			const updates = [...groups.values()].map(
				({ trackId, elementId, refs }) => {
					const track = editor.timeline.getTrackById({ trackId });
					const element = track?.elements.find(
						(candidate) => candidate.id === elementId,
					);
					const animations = refs.reduce(
						(currentAnimations, ref) =>
							setElementKeyframeEasing({
								animations: currentAnimations,
								propertyPath: ref.propertyPath,
								keyframeId: ref.keyframeId,
								easing,
							}),
						element?.animations,
					);
					return { trackId, elementId, updates: { animations } };
				},
			);

			editor.timeline.previewElements({ updates });
		},
		[editor, easableKeyframes],
	);

	const commitBezier = useCallback(
		(bezier: CubicBezierControlPoints) => {
			editor.timeline.discardPreview();
			applyBezier(bezier);
		},
		[editor, applyBezier],
	);

	const cancelPreview = useCallback(() => {
		editor.timeline.discardPreview();
	}, [editor]);

	if (easableKeyframes.length === 0) {
		return null;
	}

	return (
		<div className="flex items-center justify-between gap-2 border-t px-3 py-2">
			<span className="text-2xs font-medium text-muted-foreground">
				Easing
			</span>
			<EasingGraphPopover
				open={isOpen}
				onOpenChange={setIsOpen}
				value={currentBezier}
				isMixed={isMixed}
				onPreviewValue={previewBezier}
				onCommitValue={commitBezier}
				onCancelPreview={cancelPreview}
				trigger={
					<button
						type="button"
						className="text-muted-foreground hover:bg-accent/50 hover:text-foreground flex h-7 w-24 items-center gap-1.5 rounded-md border px-2"
					>
						<span className="text-primary shrink-0">
							<BezierCurveThumb value={currentBezier} width={24} height={14} />
						</span>
						<span className="truncate text-xs">
							{isMixed ? "Mixed" : "Curve"}
						</span>
					</button>
				}
			/>
		</div>
	);
}
