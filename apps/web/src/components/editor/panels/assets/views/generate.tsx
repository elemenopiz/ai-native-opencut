"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PanelView } from "./base-view";
import { GenerationForm } from "@/components/studio/generation-form";
import { ImagePanel } from "@/components/studio/image-panel";
import { PersonaManager } from "@/components/studio/persona-manager";
import { Button } from "@/components/ui/button";
import { useStudioGeneration } from "@/hooks/use-studio-generation";
import { useSlotGeneration } from "@/hooks/use-slot-generation";
import { useEditor } from "@/hooks/use-editor";
import {
	generateMultiframe,
	type MultiframeBase,
} from "@/lib/studio/multiframe";
import { addsPerShotStill, estimateCost, formatUsd } from "@/lib/studio/cost";
import { useTakesNotificationStore } from "@/stores/takes-notification-store";
import { cn } from "@/utils/ui";
import { TakeReview } from "@/components/editor/take-review";
import type { GenerationSpec } from "@/types/timeline";

/**
 * The single, consolidated AI generation surface — lives inside the editor so
 * generation and the timeline share one screen (no `/studio` route, no alt-tab).
 * Reuses the feature-rich studio pipeline (personas, seed-lock, GPT Image,
 * camera presets, live cost estimate) and drops finished takes straight onto the
 * current project's timeline.
 */
export function GenerateView() {
	const { status, error, generate, clearError } = useStudioGeneration();

	const editor = useEditor();
	const [section, setSection] = useState("generate");

	const busy = status === "submitting" || status === "polling";

	// Slots are created via the Director's storyboard (humans) or the
	// director-api `reserveSlot`/`storyboard` verbs (AI). This panel just
	// renders + batch-generates whatever slots already exist on the timeline.

	// ── Batch generation (Phase 4) ────────────────────────────────────────────
	const { generateAllSlots } = useSlotGeneration();
	const [alternatives, setAlternatives] = useState(1);
	const [batchBusy, setBatchBusy] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const [slots, setSlots] = useState<
		{ elementId: string; spec: GenerationSpec; hasPrompt: boolean }[]
	>([]);

	// Track generative slots on the timeline so the batch bar stays in sync.
	useEffect(() => {
		const refresh = () => {
			const out: {
				elementId: string;
				spec: GenerationSpec;
				hasPrompt: boolean;
			}[] = [];
			for (const track of editor.timeline.getTracks()) {
				for (const el of track.elements) {
					if ((el.type === "video" || el.type === "image") && el.generation) {
						out.push({
							elementId: el.id,
							spec: el.generation,
							hasPrompt: !!el.generation.prompt?.trim(),
						});
					}
				}
			}
			setSlots(out);
		};
		refresh();
		return editor.timeline.subscribe(refresh);
	}, [editor]);

	const promptedSlots = slots.filter((s) => s.hasPrompt);
	const batchCost = promptedSlots.reduce(
		(acc, s) => {
			// `alternatives` takes per slot share a single per-shot still, so the
			// still is counted once (inside estimateCost) and the video cost scales
			// with the alternatives count.
			const rendersStill = addsPerShotStill(
				!!s.spec.personaId,
				s.spec.consistencyMode,
			);
			const c = estimateCost(
				s.spec.resolution,
				s.spec.duration,
				rendersStill,
				alternatives,
			);
			return {
				low: acc.low + c.low,
				high: acc.high + c.high,
			};
		},
		{ low: 0, high: 0 },
	);

	const runBatch = useCallback(async () => {
		setBatchBusy(true);
		try {
			const r = await generateAllSlots({ alternatives });
			if (r.slots === 0) {
				toast.error("No slots with prompts to generate.");
			} else {
				toast.success(
					`Generated ${r.ok} take${r.ok === 1 ? "" : "s"} across ${r.slots} slot${r.slots === 1 ? "" : "s"}${r.failed ? ` (${r.failed} failed)` : ""}.`,
				);
			}
		} finally {
			setBatchBusy(false);
		}
	}, [alternatives, generateAllSlots]);

	// Drive the Takes tab icon (left rail): fill it blue while a generation is in
	// flight, keep it blue once done so the user knows takes are waiting there.
	// Covers both single-shot (`busy`) and batch (`batchBusy`) generation.
	const setGenerating = useTakesNotificationStore((s) => s.setGenerating);
	const setReady = useTakesNotificationStore((s) => s.setReady);
	const anyBusy = busy || batchBusy;
	const wasBusy = useRef(false);
	useEffect(() => {
		if (anyBusy && !wasBusy.current) setGenerating();
		else if (!anyBusy && wasBusy.current) setReady();
		wasBusy.current = anyBusy;
	}, [anyBusy, setGenerating, setReady]);

	// Multiframe: generate N-1 flf2v segments across the keyframes and lay them
	// end-to-end on the active project's timeline.
	const handleGenerateMultiframe = useCallback(
		async (keyframes: string[], base: MultiframeBase) => {
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
			const segs = keyframes.length - 1;
			toast.info(`Generating ${segs} segment${segs === 1 ? "" : "s"}…`);
			const { placed, segments } = await generateMultiframe({
				editor,
				projectId,
				keyframes,
				base,
			});
			if (placed > 0) {
				toast.success(
					`Placed ${placed}/${segments} segment${segments === 1 ? "" : "s"} on the timeline.`,
				);
			} else {
				toast.error("Multiframe generation failed.");
			}
		},
		[editor],
	);

	return (
		<PanelView title="Generate" hideHeader>
			<Tabs value={section} onValueChange={setSection} className="space-y-3">
				<TabsList className="w-full grid grid-cols-3 h-8">
					<TabsTrigger value="generate" className="text-xs">
						Shot
					</TabsTrigger>
					<TabsTrigger value="image" className="text-xs">
						Image
					</TabsTrigger>
					<TabsTrigger value="personas" className="text-xs">
						Personas
					</TabsTrigger>
				</TabsList>

				<TabsContent value="generate" className="mt-0 space-y-3">
					{/* Batch bar — storyboard then generate the whole reel in one go */}
					{slots.length > 0 && (
						<div className="rounded-md border border-border bg-muted/40 p-2.5 space-y-2">
							<div className="flex items-center justify-between">
								<span className="text-xs font-medium">
									{slots.length} slot{slots.length === 1 ? "" : "s"} reserved
									{promptedSlots.length < slots.length && (
										<span className="font-normal text-muted-foreground">
											{" "}
											· {promptedSlots.length} ready
										</span>
									)}
								</span>
								{promptedSlots.length > 0 && (
									<span className="text-xs font-semibold tabular-nums">
										{formatUsd(batchCost.low)}–{formatUsd(batchCost.high)}
									</span>
								)}
							</div>
							<div className="flex items-center gap-2">
								<span className="text-[10px] text-muted-foreground">
									Alternatives
								</span>
								<div className="flex gap-1">
									{[1, 2, 3, 4].map((n) => (
										<button
											key={n}
											type="button"
											onClick={() => setAlternatives(n)}
											className={cn(
												"size-6 rounded border text-[11px] transition-colors",
												alternatives === n
													? "border-primary bg-primary text-primary-foreground"
													: "border-border text-muted-foreground hover:border-foreground",
											)}
										>
											{n}
										</button>
									))}
								</div>
								<Button
									size="sm"
									variant="outline"
									className="ml-auto h-7 text-xs"
									onClick={() => setReviewOpen(true)}
								>
									Review
								</Button>
								<Button
									size="sm"
									className="h-7 text-xs"
									disabled={batchBusy || promptedSlots.length === 0}
									onClick={runBatch}
								>
									{batchBusy ? "Generating…" : "Generate all"}
								</Button>
							</div>
							{promptedSlots.length === 0 && (
								<p className="text-[10px] text-muted-foreground">
									Select a slot on the timeline and add a prompt to enable batch
									generation.
								</p>
							)}
						</div>
					)}

					<GenerationForm
						onGenerate={generate}
						onGenerateMultiframe={handleGenerateMultiframe}
						busy={busy}
					/>
				</TabsContent>

				<TabsContent value="image" className="mt-0">
					<ImagePanel />
				</TabsContent>

				<TabsContent value="personas" className="mt-0">
					<PersonaManager />
				</TabsContent>
			</Tabs>

			{error && (
				<div className="mt-3 rounded-md bg-destructive/10 px-3 py-2">
					<p className="text-xs text-destructive">{error}</p>
					<button
						onClick={clearError}
						className="text-xs text-muted-foreground underline mt-1"
					>
						Dismiss
					</button>
				</div>
			)}

			<TakeReview open={reviewOpen} onOpenChange={setReviewOpen} />
		</PanelView>
	);
}
