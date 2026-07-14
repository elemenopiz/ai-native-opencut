"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { PanelView } from "./base-view";
import { TakeCard } from "@/components/studio/take-card";
import {
	useStudioGeneration,
	type StudioTake,
} from "@/hooks/use-studio-generation";
import { useEditor } from "@/hooks/use-editor";
import {
	addClipsToEditor,
	addItemsToProjectMedia,
} from "@/lib/studio/add-to-editor";

/**
 * "Takes" — every generation, surfaced inside the Assets panel. This is the one
 * home for takes now (the right-panel Generate surface no longer carries its own
 * Takes tab). Generate from anywhere; the winners get starred into Assets or
 * dropped onto the timeline, one click away.
 */
export function StarredTakesView() {
	const {
		activeTakes,
		loadHistory,
		starTake,
		promoteTo1080p,
		pinToBoard,
	} = useStudioGeneration();
	const editor = useEditor();

	// Remembers which project-media asset each starred take created, so un-starring
	// can remove exactly that asset instead of leaving an orphan (or duplicating).
	const savedMediaByTake = useRef<Map<string, string>>(new Map());

	// Hydrate from persisted history. This view remounts whenever its tab is
	// opened, so a fresh fetch here is what surfaces takes generated while the
	// user was on another tab.
	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	// Newest first — the just-generated takes sit at the top.
	const takes = activeTakes;

	// Drop a take onto the current project's timeline.
	const handleAddToTimeline = useCallback(
		async (videoUrl: string, name = "Generated clip") => {
			let projectId: string | null = null;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				projectId = null;
			}
			if (!projectId) {
				toast.error("No active project to add to.");
				return;
			}
			const { added } = await addClipsToEditor({
				editor,
				projectId,
				clips: [{ id: crypto.randomUUID(), videoUrl, name }],
			});
			if (added === 0) toast.error("Could not add to the timeline.");
		},
		[editor],
	);

	// Toggle a take in/out of the project's Assets library (the star gesture).
	// Starring saves it once and remembers the asset id; clicking again un-stars,
	// removing that exact asset. Guards against duplicate saves on repeat clicks.
	const handleSaveToAssets = useCallback(
		async (take: StudioTake) => {
			if (!take.videoUrl) return;
			let projectId: string | null = null;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				projectId = null;
			}
			if (!projectId) {
				toast.error("No active project.");
				return;
			}

			// Already starred → un-star: remove the asset we created for it.
			if (take.starred) {
				const mediaId = savedMediaByTake.current.get(take.takeId);
				if (mediaId) {
					await editor.media.removeMediaAsset({ projectId, id: mediaId });
					savedMediaByTake.current.delete(take.takeId);
				}
				void starTake(take.takeId, false);
				toast.success("Removed from assets.");
				return;
			}

			const { added, mediaIds } = await addItemsToProjectMedia({
				editor,
				projectId,
				items: [
					{
						url: take.videoUrl,
						name: take.prompt || "Generated take",
						kind: "video",
					},
				],
				source: "ai",
			});
			if (added > 0) {
				if (mediaIds[0]) savedMediaByTake.current.set(take.takeId, mediaIds[0]);
				toast.success("Saved to assets.");
				void starTake(take.takeId, true);
			} else {
				toast.error("Could not save to assets.");
			}
		},
		[editor, starTake],
	);

	return (
		<PanelView title="Takes">
			{takes.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
					<p className="text-sm font-medium">No takes yet</p>
					<p className="text-xs text-muted-foreground">
						Generate a shot to see takes here, then star the winner to save it
						to Assets or drop it onto the timeline.
					</p>
				</div>
			) : (
				<div className="grid grid-cols-2 gap-2 pb-4">
					{takes.map((take) => (
						<TakeCard
							key={take.takeId}
							take={take}
							onStar={starTake}
							onSaveToAssets={handleSaveToAssets}
							onPromote={promoteTo1080p}
							onPin={pinToBoard}
							onAddToTimeline={(url) =>
								handleAddToTimeline(url, take.prompt || "Generated clip")
							}
						/>
					))}
				</div>
			)}
		</PanelView>
	);
}
