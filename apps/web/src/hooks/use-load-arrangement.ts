import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import { useArrangementHandoffStore } from "@/stores/arrangement-handoff-store";
import type { Arrangement } from "@/types/arrangement";

/**
 * Returns a callback that opens an arrangement as a NEW project: it stashes the
 * arrangement for hand-off, creates a blank project locally (no login needed),
 * and routes to the editor, where `use-arrangement-handoff` hydrates it onto the
 * timeline. Shared by the new-project picker and the public `/t/[id]` landing.
 */
export function useLoadArrangement(): (arrangement: Arrangement) => Promise<void> {
	const editor = useEditor();
	const router = useRouter();

	return useCallback(
		async (arrangement: Arrangement) => {
			try {
				useArrangementHandoffStore.getState().setPending(arrangement);
				const projectId = await editor.project.createNewProject({
					name: arrangement.name || "New project",
				});
				router.push(`/editor/${projectId}`);
			} catch (error) {
				useArrangementHandoffStore.getState().clear();
				toast.error("Could not start a project from this arrangement", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			}
		},
		[editor, router],
	);
}
