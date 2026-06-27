"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GenerationForm } from "@/components/studio/generation-form";
import { TakeCard } from "@/components/studio/take-card";
import { Visionboard } from "@/components/studio/visionboard";
import { ImagePanel } from "@/components/studio/image-panel";
import { CompareDialog } from "@/components/studio/compare-dialog";
import { useStudioGeneration } from "@/hooks/use-studio-generation";
import { useEditor } from "@/hooks/use-editor";
import { useStudioHandoffStore } from "@/stores/studio-handoff-store";
import {
	addItemsToProjectMedia,
	type StudioMediaItem,
} from "@/lib/studio/add-to-editor";

export default function StudioPage() {
	const {
		status,
		activeTakes,
		error,
		generate,
		promoteTo1080p,
		starTake,
		pinToBoard,
		loadHistory,
		clearError,
	} = useStudioGeneration();

	const editor = useEditor();
	const router = useRouter();
	const enqueueClips = useStudioHandoffStore((s) => s.enqueueClips);

	const [referenceImageUrl, setReferenceImageUrl] = useState("");
	const [activeTab, setActiveTab] = useState("generate");
	const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
	const [compareOpen, setCompareOpen] = useState(false);

	const toggleCompare = useCallback((takeId: string) => {
		setCompareIds((prev) => {
			const next = new Set(prev);
			if (next.has(takeId)) next.delete(takeId);
			else next.add(takeId);
			return next;
		});
	}, []);

	const compareTakes = activeTakes.filter((t) => compareIds.has(t.takeId));

	const busy = status === "submitting" || status === "polling";

	// Hydrate the Takes grid from persisted history on first load.
	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	// Send a finished take to the editor timeline. Queues the clip, resolves a
	// target project (most-recent saved, or a fresh one), then navigates over.
	const handleAddToTimeline = useCallback(
		async (videoUrl: string, name = "Generated clip", durationHint?: number) => {
			enqueueClips([
				{ id: crypto.randomUUID(), videoUrl, name, durationHint },
			]);

			try {
				await editor.project.loadAllProjects();
				const saved = editor.project.getSavedProjects();
				const mostRecent = [...saved].sort(
					(a, b) =>
						new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
				)[0];

				const projectId =
					mostRecent?.id ??
					(await editor.project.createNewProject({ name: "Studio Reel" }));

				toast.success("Sending clip to the editor…");
				router.push(`/editor/${projectId}`);
			} catch {
				toast.error("Could not open the editor.");
			}
		},
		[editor, enqueueClips, router],
	);

	// Resolve a target project — most-recently-updated saved one, or a fresh reel.
	const resolveProjectId = useCallback(async (): Promise<string> => {
		await editor.project.loadAllProjects();
		const saved = editor.project.getSavedProjects();
		const mostRecent = [...saved].sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		)[0];
		return (
			mostRecent?.id ??
			(await editor.project.createNewProject({ name: "Studio Reel" }))
		);
	}, [editor]);

	// "Send to editor" — push curated clips into the project's media library so
	// they appear in the editor's Assets panel, ready to drag onto the timeline.
	const handleSendToEditor = useCallback(
		async (items: StudioMediaItem[]) => {
			try {
				const projectId = await resolveProjectId();
				const { added, failed } = await addItemsToProjectMedia({
					editor,
					projectId,
					items,
				});

				if (added > 0) {
					toast.success(
						`Added ${added} item${added > 1 ? "s" : ""} to your project's media.`,
						{
							description: failed > 0 ? `${failed} failed to import.` : undefined,
							action: {
								label: "Open editor",
								onClick: () => router.push(`/editor/${projectId}`),
							},
						},
					);
				} else {
					toast.error("Could not add to the editor's media.");
				}
			} catch {
				toast.error("Could not add to the editor's media.");
			}
		},
		[editor, resolveProjectId, router],
	);

	async function handleImageGenerate(prompt: string) {
		// Trigger image generation and auto-populate the reference URL on success
		const res = await fetch("/api/studio/image", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt, n: 1 }),
		});
		if (res.ok) {
			const data = await res.json() as { images: Array<{ imageUrl: string }> };
			if (data.images[0]) {
				setReferenceImageUrl(data.images[0].imageUrl);
			}
		}
	}

	return (
		<div className="flex h-screen overflow-hidden bg-background">
			{/* Sidebar — generation controls */}
			<aside className="w-80 shrink-0 border-r flex flex-col">
				<div className="px-4 py-3 border-b flex items-center gap-2">
					<span className="font-semibold text-sm">Studio</span>
					<Badge variant="secondary" className="text-xs">beta</Badge>
				</div>

				<div className="flex-1 overflow-y-auto p-4">
					<Tabs defaultValue="generate" className="space-y-4">
						<TabsList className="w-full grid grid-cols-2 h-8">
							<TabsTrigger value="generate" className="text-xs">Generate</TabsTrigger>
							<TabsTrigger value="image" className="text-xs">GPT Image</TabsTrigger>
						</TabsList>

						<TabsContent value="generate" className="mt-0">
							<GenerationForm
								onGenerate={generate}
								onImageGenerate={handleImageGenerate}
								busy={busy}
							/>
						</TabsContent>

						<TabsContent value="image" className="mt-0">
							<ImagePanel onSelectImage={setReferenceImageUrl} />
						</TabsContent>
					</Tabs>
				</div>

				{error && (
					<div className="px-4 py-3 border-t bg-destructive/10">
						<p className="text-xs text-destructive">{error}</p>
						<button onClick={clearError} className="text-xs text-muted-foreground underline mt-1">
							Dismiss
						</button>
					</div>
				)}
			</aside>

			{/* Main canvas */}
			<main className="relative flex-1 flex flex-col overflow-hidden">
				<Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 overflow-hidden">
					<div className="border-b px-4 flex items-center gap-4 h-11 shrink-0">
						<TabsList className="h-8">
							<TabsTrigger value="generate" className="text-xs">
								Takes
								{activeTakes.length > 0 && (
									<Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0 h-4">
										{activeTakes.length}
									</Badge>
								)}
							</TabsTrigger>
							<TabsTrigger value="board" className="text-xs">Visionboard</TabsTrigger>
						</TabsList>
					</div>

					{/* Takes grid */}
					<TabsContent
						value="generate"
						className="flex-1 overflow-y-auto p-4 mt-0"
					>
						{activeTakes.length === 0 ? (
							<div className="flex flex-col items-center justify-center h-full gap-3 text-center">
								<div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
									<svg className="w-8 h-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
									</svg>
								</div>
								<div>
									<p className="text-sm font-medium">No takes yet</p>
									<p className="text-xs text-muted-foreground mt-1">Generate a video to see it here.</p>
								</div>
							</div>
						) : (
							<div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
								{activeTakes.map((take) => (
									<TakeCard
										key={take.takeId}
										take={take}
										onStar={starTake}
										onPromote={promoteTo1080p}
										onPin={pinToBoard}
										onAddToTimeline={(url) =>
											handleAddToTimeline(url, take.prompt || "Generated clip")
										}
										selected={compareIds.has(take.takeId)}
										onToggleSelect={toggleCompare}
									/>
								))}
							</div>
						)}
					</TabsContent>

					{/* Visionboard */}
					<TabsContent value="board" className="flex-1 overflow-y-auto p-4 mt-0">
						<div className="space-y-3">
							<div>
								<h2 className="text-sm font-medium">Visionboard</h2>
								<p className="text-xs text-muted-foreground mt-0.5">
									Curated takes and stills. Drag a tile onto “Send to editor” to add it to your project’s media.
								</p>
							</div>
							<Visionboard onSendToEditor={handleSendToEditor} />
						</div>
					</TabsContent>
				</Tabs>

					{/* Floating compare bar — appears when 2+ takes are selected */}
					{activeTab === "generate" && compareIds.size >= 2 && (
						<div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 rounded-full border bg-background/95 backdrop-blur px-4 py-2 shadow-lg">
							<span className="text-xs text-muted-foreground">
								{compareIds.size} selected
							</span>
							<Button size="sm" className="text-xs h-7" onClick={() => setCompareOpen(true)}>
								Compare
							</Button>
							<button
								onClick={() => setCompareIds(new Set())}
								className="text-xs text-muted-foreground underline"
							>
								Clear
							</button>
						</div>
					)}
			</main>

			<CompareDialog
				takes={compareTakes}
				open={compareOpen}
				onOpenChange={setCompareOpen}
				onStar={starTake}
				onPromote={promoteTo1080p}
				onAddToTimeline={handleAddToTimeline}
			/>
		</div>
	);
}
