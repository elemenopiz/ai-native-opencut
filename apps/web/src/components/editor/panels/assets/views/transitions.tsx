"use client";

import { useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import {
	getAllTransitions,
	TRANSITION_ADJACENCY_EPSILON,
	type TransitionDefinition,
} from "@/lib/transitions";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import { AddTransitionCommand } from "@/lib/commands/timeline/element/transitions/add-transition";
import { isVisualElement } from "@/lib/timeline";
import { cn } from "@/utils/ui";

const CATEGORY_ICONS: Record<string, string> = {
	dissolve: "◐",
	slide: "▶",
	wipe: "▮",
	zoom: "⊕",
	dip: "◻",
	iris: "◉",
	morph: "≈",
	distortion: "∿",
	burn: "❋",
	peel: "◲",
	spin: "↻",
	cube: "▣",
	pattern: "▦",
};

const CATEGORY_LABELS: Record<string, string> = {
	dissolve: "Dissolve",
	slide: "Slide",
	wipe: "Wipe",
	zoom: "Zoom",
	dip: "Dip",
	iris: "Iris",
	morph: "Morph",
	distortion: "Distortion",
	burn: "Burn",
	peel: "Peel",
	spin: "Spin",
	cube: "3D",
	pattern: "Pattern",
};

export function TransitionsView() {
	const transitions = getAllTransitions();

	const categories = Array.from(new Set(transitions.map((t) => t.category)));

	return (
		<PanelView title="Transitions">
			<p className="text-[11px] text-muted-foreground px-1 pb-2">
				Select a clip on the timeline, then click a transition to apply it to
				the outgoing edge.
			</p>
			{categories.map((category) => (
				<div key={category} className="mb-3">
					<h3 className="text-[11px] font-medium text-muted-foreground mb-1.5 px-1">
						{CATEGORY_LABELS[category] ?? category}
					</h3>
					<div
						className="grid gap-2"
						style={{
							gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
						}}
					>
						{transitions
							.filter((t) => t.category === category)
							.map((transition) => (
								<TransitionItem key={transition.type} transition={transition} />
							))}
					</div>
				</div>
			))}
		</PanelView>
	);
}

function TransitionItem({ transition }: { transition: TransitionDefinition }) {
	const editor = useEditor();

	const handleApply = useCallback(() => {
		const selected = editor.selection.getSelectedElements();
		if (selected.length === 0) {
			toast.error("Select a clip on the timeline first");
			return;
		}

		const { elementId, trackId } = selected[0];
		const tracks = editor.timeline.getTracks();
		const track = tracks.find((t) => t.id === trackId);
		if (!track) return;
		const element = track.elements.find((e) => e.id === elementId);
		if (!element || !isVisualElement(element)) return;

		if (element.type !== "video" && element.type !== "image") {
			toast.error("Transitions apply to video or image clips");
			return;
		}

		// A cut transition blends this clip into the next one — it needs an
		// adjacent video/image clip on the same track to blend into.
		const sorted = track.elements
			.filter((el) => !("hidden" in el && el.hidden))
			.slice()
			.sort((a, b) => a.startTime - b.startTime);
		const index = sorted.findIndex((el) => el.id === element.id);
		const next = index >= 0 ? sorted[index + 1] : undefined;

		if (!next) {
			toast.error(
				"This is the last clip on its track — transitions play across the cut into the next clip",
			);
			return;
		}
		if (next.type !== "video" && next.type !== "image") {
			toast.error("The next clip must be a video or image to transition into");
			return;
		}
		if (
			next.startTime - (element.startTime + element.duration) >
			TRANSITION_ADJACENCY_EPSILON
		) {
			toast.error(
				"There's a gap after this clip — snap the next clip against it, then apply the transition",
			);
			return;
		}

		editor.command.execute({
			command: new AddTransitionCommand({
				trackId,
				elementId,
				transitionType: transition.type,
			}),
		});
	}, [editor, transition.type]);

	return (
		<button
			type="button"
			onClick={handleApply}
			className={cn(
				"flex flex-col items-center gap-1.5 rounded-md border p-2",
				"hover:bg-accent/50 transition-colors cursor-pointer",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			)}
		>
			<div className="size-12 rounded bg-muted/50 flex items-center justify-center text-lg">
				{CATEGORY_ICONS[transition.category] ?? "◇"}
			</div>
			<span className="text-[11px] text-center leading-tight truncate w-full">
				{transition.name}
			</span>
		</button>
	);
}
