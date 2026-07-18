"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { resetProjectScopedStores } from "@/stores/reset-project-scoped-stores";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

type FlushableSave = { flush: () => Promise<void> };
type MinimalEventTarget = Pick<
	EventTarget,
	"addEventListener" | "removeEventListener"
>;

/**
 * BUG127: `beforeunload` only warns — it never persists anything, and on
 * mobile Safari / backgrounded tabs it may not fire at all before the page
 * is discarded. `visibilitychange`→hidden and `pagehide` fire reliably in
 * those cases, so flush any pending (debounced) save right then instead of
 * leaving up to `debounceMs` of edits exposed to a reload/tab-close.
 * Best-effort, fire-and-forget: SaveManager.saveNow already swallows its own
 * errors (BUG125) into `lastError`, so this never throws into an unhandled
 * rejection.
 *
 * Pulled out of the component's useEffect as a plain function — taking
 * `doc`/`win` as params — so it's unit-testable without a DOM/RTL harness
 * (none is set up in this repo's `bun test`).
 */
export function registerFlushOnHide(
	save: FlushableSave,
	doc: MinimalEventTarget & { hidden?: boolean } = document,
	win: MinimalEventTarget = window,
): () => void {
	const flushPendingSave = () => {
		void save.flush();
	};
	const handleVisibilityChange = () => {
		if (doc.hidden) flushPendingSave();
	};

	doc.addEventListener("visibilitychange", handleVisibilityChange);
	win.addEventListener("pagehide", flushPendingSave);
	return () => {
		doc.removeEventListener("visibilitychange", handleVisibilityChange);
		win.removeEventListener("pagehide", flushPendingSave);
	};
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

				// Reset every module-global store that holds per-project state
				// (transcript, beat grid, generation polls, frame/omni chains,
				// background tasks, …) on every project switch — EditorCore is
				// reused across switches, so nothing else clears them. The editor
				// page's restore effects then repopulate from this project's own
				// data. See `stores/reset-project-scoped-stores.ts`.
				resetProjectScopedStores();

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

	// BUG127: flush a pending debounced save on tab-hide/pagehide — see
	// registerFlushOnHide above for rationale and the (unit-tested) wiring.
	useEffect(() => registerFlushOnHide(editor.save), [editor]);

	// BUG128 (prototype, warn-only): tell the user when this project is open
	// in another tab, so they don't unknowingly fork edits — no locking or
	// coordination, just a heads-up. Each tab announces itself on mount; any
	// tab already open for this project answers back, so both sides toast.
	// This is a cheap, fully self-contained seam (channel + toast) — a real
	// multi-tab lock/merge story is out of scope here.
	useEffect(() => {
		if (typeof BroadcastChannel === "undefined") return;
		const channel = new BroadcastChannel(`byorn-project-open:${projectId}`);
		const warn = () => {
			toast.warning("This project is also open in another tab.", {
				description: "Edits in both tabs can conflict — the last save wins.",
			});
		};
		channel.onmessage = (event) => {
			const type = (event.data as { type?: string } | undefined)?.type;
			if (type === "hello") {
				warn();
				channel.postMessage({ type: "hello-ack" });
			} else if (type === "hello-ack") {
				warn();
			}
		};
		channel.postMessage({ type: "hello" });
		return () => channel.close();
	}, [projectId]);

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
