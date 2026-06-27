import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import { useStudioHandoffStore } from "@/stores/studio-handoff-store";
import { addClipsToEditor } from "@/lib/studio/add-to-editor";

/**
 * Drains any clips queued by the Studio onto the timeline once the editor has an
 * active project. Mount this only where the project is guaranteed loaded.
 */
export function useStudioHandoff(): void {
	const editor = useEditor();
	const drained = useRef(false);

	useEffect(() => {
		if (drained.current) return;

		const project = editor.project.getActiveOrNull();
		if (!project) return;

		const clips = useStudioHandoffStore.getState().takeAll();
		if (clips.length === 0) return;

		drained.current = true;

		const toastId = toast.loading(
			`Adding ${clips.length} generated clip${clips.length > 1 ? "s" : ""} to the timeline…`,
		);

		addClipsToEditor({
			editor,
			projectId: project.metadata.id,
			clips,
		})
			.then(({ added, failed }) => {
				if (added > 0 && failed === 0) {
					toast.success(
						`Added ${added} clip${added > 1 ? "s" : ""} to the timeline.`,
						{ id: toastId },
					);
				} else if (added > 0 && failed > 0) {
					toast.warning(`Added ${added}, but ${failed} failed to import.`, {
						id: toastId,
					});
				} else {
					toast.error("Could not import the generated clips.", { id: toastId });
				}
			})
			.catch(() => {
				toast.error("Could not import the generated clips.", { id: toastId });
			});
	}, [editor]);
}
