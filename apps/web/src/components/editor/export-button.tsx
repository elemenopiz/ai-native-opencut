"use client";

import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	commitExport,
	createExportJobId,
} from "@/lib/export";
import { exportCapcutDraft } from "@/lib/export/capcut-export";
import {
	Check,
	Clapperboard,
	Copy,
	Download,
	Layers,
	RotateCcw,
} from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { BatchExportPanel } from "@/components/editor/panels/assets/views/batch-export";
import { toast } from "sonner";
import {
	EXPORT_CONTAINER_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportContainerFormat,
	type ExportQuality,
} from "@/types/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/editor/panels/properties/section";
import { useEditor } from "@/hooks/use-editor";
import {
	DEFAULT_EXPORT_OPTIONS,
	EXPORT_PRESETS,
} from "@/constants/export-constants";

function isExportFormat(value: string): value is ExportContainerFormat {
	return EXPORT_CONTAINER_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();

	const hasProject = !!editor.project.getActiveOrNull();

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<Button
					variant="primary"
					data-testid="export-open"
					disabled={!hasProject}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
				>
					<Download className="size-4" />
					Export
				</Button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const {
		isExporting,
		progress,
		result: exportResult,
	} = editor.project.getExportState();
	const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
	const [format, setFormat] = useState<ExportContainerFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	// Forces the video track off (BUG-podcast-preset): set from the "Podcast
	// (audio only)" preset's `options.audioOnly`. Not exposed as its own
	// standalone toggle — the podcast preset is currently the only way to
	// reach it from the UI, matching how the other preset-only fields
	// (dimensions) work.
	const [audioOnly, setAudioOnly] = useState<boolean>(false);
	const [isExportingCapcutDraft, setIsExportingCapcutDraft] = useState(false);
	const [isBatchOpen, setIsBatchOpen] = useState(false);
	// Staged output dimensions from the selected preset. `null` means "use the
	// project's own canvasSize" — the Custom preset and deselecting both fall
	// back to this by clearing it.
	const [dimensions, setDimensions] = useState<{
		width: number;
		height: number;
	} | null>(null);

	const handlePresetSelect = (presetId: string) => {
		const preset = EXPORT_PRESETS.find((p) => p.id === presetId);
		if (!preset) return;
		setSelectedPresetId(presetId);
		if (isExportFormat(preset.options.format)) setFormat(preset.options.format);
		if (isExportQuality(preset.options.quality))
			setQuality(preset.options.quality);
		setShouldIncludeAudio(preset.options.includeAudio ?? true);
		setAudioOnly(preset.options.audioOnly ?? false);
		setDimensions(preset.canvasSize ?? null);
	};

	const selectedPreset = EXPORT_PRESETS.find((p) => p.id === selectedPresetId);

	const effectiveOutputSize =
		dimensions ?? activeProject?.settings.canvasSize ?? null;

	const handleExport = async () => {
		if (!activeProject) return;

		const jobId = createExportJobId();
		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
				// The UI no longer offers a watermark toggle — exports never
				// watermark. The renderer's watermark capability itself
				// (services/renderer/nodes/watermark-node.ts) is untouched.
				includeWatermark: false,
				dimensions: dimensions ?? undefined,
				audioOnly,
			},
		});

		// Same staged-handoff gate the Director/MCP `export` verb uses — see
		// commitExport's doc in lib/export.ts. Only a fully-succeeded,
		// non-cancelled buffer ever reaches the browser download.
		const outcome = commitExport({
			result,
			jobId,
			filename: `${activeProject.metadata.name}${getExportFileExtension({ format })}`,
			mimeType: getExportMimeType({ format }),
		});

		if (outcome.status === "failed") {
			if (outcome.reason === "cancelled") {
				editor.project.clearExportState();
				return;
			}
			// Non-cancelled failure: `editor.project.export` already stashed this
			// same raw result in export state (see the store subscription below),
			// so the popover's failure branch renders it — sanitised through
			// `commitExport`, never the raw provider/codec text. The toast is a
			// second, louder signal for the one beat of the demo the audience is
			// guaranteed to be looking at, in case the popover isn't in view.
			toast.error(outcome.message);
			return;
		}

		if (outcome.status === "completed") {
			// Non-blocking quality-degradation notice: a clip's original video
			// codec couldn't be decoded by this browser, so its H.264 proxy was
			// used for export instead. Matches the CapCut-draft-export precedent
			// below — a dismissible toast, not a blocking confirmation. Each
			// warning already names its own clip, so joining them keeps every
			// affected clip named without any re-parsing.
			if (result.warnings && result.warnings.length > 0) {
				toast.warning(result.warnings.join(" "));
			}

			editor.project.clearExportState();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	// `exportState.result` is the RAW result from the renderer (see
	// core/managers/project-manager.ts's `export`) — it can carry a raw
	// `DOMException`/codec string on `.error`. Route it through the same
	// `commitExport` gate the Director/MCP export verb uses before this popover
	// is allowed to render anything from it, so no raw provider/codec text can
	// reach the screen regardless of which caller populated this state (this
	// button's own `handleExport`, or an export triggered elsewhere, e.g. via
	// Director). `jobId`/`filename`/`mimeType` are unused on the failure path
	// `commitExport` takes here — placeholders only — and `download: false`
	// guarantees this purely-for-display call can never re-trigger a download.
	const sanitizedResultOutcome =
		exportResult && !exportResult.success
			? commitExport({
					result: exportResult,
					jobId: "export-popover-display",
					filename: "",
					mimeType: "",
					download: false,
				})
			: null;
	// `commitExport` always returns the "failed" branch for a `!success` input
	// (see its implementation), but the type checker can't see that from this
	// call site — narrow explicitly rather than casting.
	const failureOutcome =
		sanitizedResultOutcome?.status === "failed" ? sanitizedResultOutcome : null;

	const handleCapcutDraftExport = async () => {
		if (!activeProject || isExportingCapcutDraft) return;

		setIsExportingCapcutDraft(true);
		try {
			const { warnings } = await exportCapcutDraft({
				projectName: activeProject.metadata.name,
				fps: activeProject.settings.fps,
				canvasSize: activeProject.settings.canvasSize,
				tracks: editor.timeline.getTracks(),
				mediaAssets: editor.media.getAssets(),
			});

			if (warnings.length > 0) {
				toast.warning(
					`CapCut draft exported with ${warnings.length} note${warnings.length === 1 ? "" : "s"}. See media_manifest.json in the zip for details.`,
				);
			} else {
				toast.success(
					"CapCut draft exported. Unzip it into your CapCut drafts folder (see README.txt inside).",
				);
			}
			onOpenChange(false);
		} catch (error) {
			toast.error(
				`CapCut draft export failed: ${error instanceof Error ? error.message : "unknown error"}`,
			);
		} finally {
			setIsExportingCapcutDraft(false);
		}
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{failureOutcome ? (
				<ExportError
					message={failureOutcome.message}
					detail={failureOutcome.detail}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								{/* Platform presets */}
								<div className="px-3 pt-3 pb-0">
									<p className="text-xs font-medium text-muted-foreground mb-2">
										Export for
									</p>
									<div className="flex flex-wrap gap-1.5">
										{EXPORT_PRESETS.filter((p) => p.id !== "custom").map(
											(preset) => (
												<button
													key={preset.id}
													type="button"
													className={cn(
														"rounded-md px-2.5 py-1 text-[11px] border transition-colors",
														selectedPresetId === preset.id
															? "border-primary bg-primary/10 text-primary"
															: "border-border hover:bg-accent text-muted-foreground",
													)}
													onClick={() => handlePresetSelect(preset.id)}
												>
													{preset.name}
												</button>
											),
										)}
									</div>
									{selectedPreset?.tip && (
										<p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
											{selectedPreset.tip}
										</p>
									)}
									{effectiveOutputSize && (
										<p className="text-[10px] text-muted-foreground/70 mt-1">
											Output: {effectiveOutputSize.width}x
											{effectiveOutputSize.height}
										</p>
									)}
								</div>

								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="gif" id="gif" />
													<Label htmlFor="gif">
														GIF - Animated image, no audio
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low - Smallest file size</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium - Balanced</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High - Recommended</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very high - Largest file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={
														format === "gif" ? false : shouldIncludeAudio
													}
													disabled={format === "gif"}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													{format === "gif"
														? "Audio not available for GIF"
														: "Include audio in export"}
												</Label>
											</div>
										</SectionContent>
									</Section>
								</div>

								<div className="flex flex-col gap-2 p-3 pt-0">
									<Button
										onClick={handleExport}
										data-testid="export-run"
										className="w-full gap-2"
									>
										<Download className="size-4" />
										Export
									</Button>
									<Button
										variant="outline"
										className="w-full gap-2"
										onClick={handleCapcutDraftExport}
										disabled={isExportingCapcutDraft}
									>
										<Clapperboard className="size-4" />
										{isExportingCapcutDraft
											? "Preparing CapCut draft..."
											: "Export as CapCut draft"}
									</Button>
									<Button
										variant="outline"
										className="w-full gap-2"
										onClick={() => setIsBatchOpen(true)}
									>
										<Layers className="size-4" />
										Batch export (multi-platform)
									</Button>
									<Dialog open={isBatchOpen} onOpenChange={setIsBatchOpen}>
										<DialogContent className="max-w-md p-0">
											<DialogHeader className="sr-only">
												<DialogTitle>Batch export</DialogTitle>
											</DialogHeader>
											<div className="h-[70vh]">
												<BatchExportPanel />
											</div>
										</DialogContent>
									</Dialog>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	message,
	detail,
	onRetry,
}: {
	/** Always a human-safe sentence — see `commitExport`'s doc in lib/export.ts. */
	message: string;
	/**
	 * Raw provider/codec text, when there was one. Never rendered as primary
	 * copy — collapsed behind "Technical details", matching the pattern in
	 * `components/editor/youtube/engagement-panel.tsx`.
	 */
	detail?: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(detail ?? message);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{message}</p>
				{detail && (
					<details className="mt-1">
						<summary className="cursor-pointer select-none text-[10px] text-muted-foreground/60">
							Technical details
						</summary>
						<p className="mt-1 break-words text-[10px] text-muted-foreground/60">
							{detail}
						</p>
					</details>
				)}
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
