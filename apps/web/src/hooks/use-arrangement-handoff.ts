import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import { useArrangementHandoffStore } from "@/stores/arrangement-handoff-store";
import { hydrateArrangement } from "@/lib/arrangements";

/**
 * Drains any arrangement queued for hand-off onto the timeline once the editor
 * has an active project. The picker / `/t/[id]` remix landing stashes an
 * arrangement and creates a blank project; this hook hydrates it into empty
 * generative slots. Mount only where the project is guaranteed loaded.
 */
export function useArrangementHandoff(): void {
	const editor = useEditor();
	const drained = useRef(false);

	useEffect(() => {
		if (drained.current) return;

		const project = editor.project.getActiveOrNull();
		if (!project) return;

		const arrangement = useArrangementHandoffStore.getState().take();
		if (!arrangement) return;

		drained.current = true;

		try {
			const tracks = hydrateArrangement({ arrangement });
			editor.timeline.updateTracks(tracks);

			if (arrangement.canvas) {
				editor.project.updateSettings({
					settings: { canvasSize: arrangement.canvas },
					pushHistory: false,
				});
			}
			if (arrangement.fps) {
				editor.project.updateSettings({
					settings: { fps: arrangement.fps },
					pushHistory: false,
				});
			}

			// Fire-and-forget by design, but saveCurrentProject rethrows on write
			// failure since BUG125 — catch here so a storage hiccup surfaces as a
			// log line, not an unhandled rejection (SaveManager will retry anyway).
			editor.project.saveCurrentProject().catch((error) => {
				console.error("Failed to persist arrangement handoff:", error);
			});

			const slotCount = arrangement.slots.length;
			toast.success(
				`Loaded "${arrangement.name}" — ${slotCount} slot${slotCount === 1 ? "" : "s"} ready to fill.`,
			);
		} catch (error) {
			console.error("Failed to load arrangement:", error);
			toast.error("Could not load the arrangement onto the timeline.");
		}
	}, [editor]);
}
