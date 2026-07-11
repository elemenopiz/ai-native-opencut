"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEditor } from "@/hooks/use-editor";
import {
	useKeybindingsListener,
	useKeybindingDisabler,
} from "@/hooks/use-keybindings";
import { useEditorActions } from "@/hooks/actions/use-editor-actions";
import { useEmbeddingIndexer } from "@/hooks/use-embedding-indexer";
import { useStudioHandoff } from "@/hooks/use-studio-handoff";
import { useMcpBridge } from "@/hooks/use-mcp-bridge";
import { prefetchFontAtlas } from "@/lib/fonts/google-fonts";
import { attachLocalAISchedulerToEditor } from "@/lib/local-ai/scheduler";
import { hydrateDirectorStateFromBible } from "@/lib/director/project-bible";
import { useTranscriptStore } from "@/stores/transcript-store";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const editor = useEditor();
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { disableKeybindings, enableKeybindings } = useKeybindingDisabler();
	const activeProject = editor.project.getActiveOrNull();

	useEffect(() => {
		if (isLoading) {
			disableKeybindings();
		} else {
			enableKeybindings();
		}
	}, [isLoading, disableKeybindings, enableKeybindings]);

	useEffect(() => {
		let cancelled = false;

		const loadProject = async () => {
			try {
				setIsLoading(true);
				await editor.project.loadProject({ id: projectId });

				if (cancelled) return;

				// Hydrate the Director's session WeakMaps (consistency context +
				// storyboard plan) from the now-loaded project's durable Project Bible,
				// so the reel's look/cast/plan survive editor unmount + reload. Clears
				// any prior reel's state first (EditorCore is a reused singleton across
				// project switches). See `lib/director/project-bible.ts`.
				hydrateDirectorStateFromBible(editor);

				// Clear the transcript store on every project switch. It's a global
				// in-memory singleton (transcript segments + speaker names/positions,
				// translations, emotions), and EditorCore is reused across project
				// switches — without this reset, the previous project's transcript and
				// speaker captions bleed into the newly-opened project. The editor
				// page's restore effect then repopulates from this project's own
				// timeline caption elements once the store is empty.
				useTranscriptStore.getState().reset();

				setIsLoading(false);
				prefetchFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					try {
						const newProjectId = await editor.project.createNewProject({
							name: "Untitled Project",
						});
						router.replace(`/editor/${newProjectId}`);
					} catch (_createErr) {
						setError("Failed to create project");
						setIsLoading(false);
					}
				} else {
					setError(
						err instanceof Error ? err.message : "Failed to load project",
					);
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, editor, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings projectId={projectId} />
			{children}
		</>
	);
}

function EditorRuntimeBindings({ projectId }: { projectId: string }) {
	const editor = useEditor();

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor]);

	// Local AI defers to the editor: gate in-browser inference (background
	// CLIP indexing) on playback/scrub/export being idle. attach() returns
	// the detach function, which doubles as the effect cleanup.
	useEffect(() => attachLocalAISchedulerToEditor(editor), [editor]);

	useEditorActions();
	useKeybindingsListener();
	useEmbeddingIndexer();
	useStudioHandoff();
	// Register this tab as the live MCP executor for the open project (the
	// server-side /api/mcp relay drives the editor through this channel).
	useMcpBridge(projectId);
	return null;
}
