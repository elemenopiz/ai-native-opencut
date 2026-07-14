"use client";

import { useEffect, useState } from "react";
import type {
	GenerationSpec,
	ImageElement,
	Take,
	VideoElement,
} from "@/types/timeline";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "./section";
import { VideoProperties } from "./video-properties";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEditor } from "@/hooks/use-editor";
import { useSlotGeneration } from "@/hooks/use-slot-generation";
import { TakeProvenanceBadge } from "@/components/editor/take-provenance-badge";
import { RemixPopover } from "@/components/studio/remix-popover";
import { extractTakeLastFrame } from "@/lib/media/last-frame";
import { CAMERA_PRESETS } from "@/lib/studio/camera-presets";
import { addsPerShotStill, estimateCost } from "@/lib/studio/cost";
import { formatCredits } from "@/lib/studio/backends/cost";
import { RESOLUTIONS, ORIENTATIONS } from "@/lib/studio/options";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";

type GenerativeElement = VideoElement | ImageElement;

/**
 * Inspector for a generative slot — mirrors Palmier's Video | Audio | AI Edit
 * tab pattern: "Clip" carries the ordinary transform/crop/speed/blend
 * properties (same view non-generative clips get), "AI Edit" carries the
 * generation-specific controls (scope, actions, spec editor, takes).
 */
export function GenerativeClipProperties({
	element,
	trackId,
}: {
	element: GenerativeElement;
	trackId: string;
}) {
	const editor = useEditor();
	const generation = element.generation;
	if (!generation) return null;

	return (
		<div className="flex h-full flex-col">
			<Tabs defaultValue="ai-edit">
				<div className="flex items-center border-b px-2.5">
					<TabsList className="h-10">
						<TabsTrigger value="clip">Clip</TabsTrigger>
						<TabsTrigger value="ai-edit">AI Edit</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="clip" className="mt-0">
					<VideoProperties element={element} trackId={trackId} />
				</TabsContent>
				<TabsContent value="ai-edit" className="mt-0 flex flex-col">
					<AIEditTab
						element={element}
						spec={generation}
						trackId={trackId}
						editor={editor}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}

// ── AI Edit tab ──────────────────────────────────────────────────────────

function AIEditTab({
	element,
	spec,
	trackId,
	editor,
}: {
	element: GenerativeElement;
	spec: GenerationSpec;
	trackId: string;
	editor: ReturnType<typeof useEditor>;
}) {
	const { generateIntoSlot } = useSlotGeneration();
	const [rerolling, setRerolling] = useState(false);

	function commit(patch: Partial<GenerationSpec>) {
		editor.timeline.setSlotSpec({
			elementId: element.id,
			spec: { ...spec, ...patch },
		});
	}

	const rendersStill = addsPerShotStill(!!spec.personaId, spec.consistencyMode);
	const cost = estimateCost(spec.duration, rendersStill);

	// The take to remix from: the active take (the "prior generation" the user
	// is looking at) or, before any take exists, the current working spec.
	const activeTake = element.takes?.find((t) => t.id === element.activeTakeId);
	const remixAnchor = activeTake ?? { spec, seed: spec.seed };

	// Anchor a manual remix on the active take's REAL last frame — true img2img
	// re-conditioning, mirroring director-api's `remix` verb so the human and
	// agent paths behave identically. The decode is async, so resolve it into
	// state and hand the URL to RemixPopover; it falls back (inside
	// buildRemixSpec) to the prior spec's referenceImageUrl when the take isn't
	// imported yet or the frame can't be decoded.
	const activeTakeAsset = activeTake?.mediaId
		? editor.media.getAssetById(activeTake.mediaId)
		: undefined;
	const [remixAnchorUrl, setRemixAnchorUrl] = useState<string | undefined>();
	useEffect(() => {
		if (!activeTakeAsset) {
			setRemixAnchorUrl(undefined);
			return;
		}
		let cancelled = false;
		void extractTakeLastFrame(activeTakeAsset, activeTake?.id).then((url) => {
			if (!cancelled) setRemixAnchorUrl(url);
		});
		return () => {
			cancelled = true;
		};
	}, [activeTakeAsset, activeTake?.id]);

	const replaceSource = spec.replaceSource === true;

	async function runRerun() {
		setRerolling(true);
		try {
			await generateIntoSlot({
				elementId: element.id,
				spec,
				alternatives: 1,
				promote: replaceSource,
			});
		} finally {
			setRerolling(false);
		}
	}

	function runRemix({ spec: remixSpec }: { spec: GenerationSpec }) {
		void generateIntoSlot({
			elementId: element.id,
			spec: remixSpec,
			alternatives: 1,
			promote: replaceSource,
		});
	}

	return (
		<>
			<ScopeSection
				replaceSource={replaceSource}
				onToggle={(v) => commit({ replaceSource: v })}
			/>
			<ActionsSection
				spec={spec}
				cost={cost}
				rerolling={rerolling}
				onRerun={runRerun}
				remixAnchor={remixAnchor}
				remixAnchorUrl={remixAnchorUrl}
				onRemix={runRemix}
			/>
			<SpecSection
				spec={spec}
				cost={cost}
				rendersStill={rendersStill}
				commit={commit}
			/>
			<TakesSection element={element} trackId={trackId} editor={editor} />
		</>
	);
}

// ── Scope ────────────────────────────────────────────────────────────────

function ScopeSection({
	replaceSource,
	onToggle,
}: {
	replaceSource: boolean;
	onToggle: (value: boolean) => void;
}) {
	return (
		<Section showTopBorder={false} sectionKey="ai-edit:scope">
			<SectionHeader>
				<SectionTitle>Scope</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 flex-col gap-0.5">
						<Label className="text-xs">Replace clip source</Label>
						<span className="text-[10px] text-muted-foreground">
							{replaceSource
								? "Rerun/Edit results replace this clip automatically."
								: "Rerun/Edit results land as a new take for review."}
						</span>
					</div>
					<Switch
						checked={replaceSource}
						onCheckedChange={onToggle}
						aria-label="Replace clip source"
					/>
				</div>
			</SectionContent>
		</Section>
	);
}

// ── Actions ──────────────────────────────────────────────────────────────

function ActionsSection({
	spec,
	cost,
	rerolling,
	onRerun,
	remixAnchor,
	remixAnchorUrl,
	onRemix,
}: {
	spec: GenerationSpec;
	cost: { low: number; high: number };
	rerolling: boolean;
	onRerun: () => void;
	remixAnchor: Pick<Take, "spec" | "seed">;
	remixAnchorUrl?: string;
	onRemix: (result: { spec: GenerationSpec; remixPrompt: string }) => void;
}) {
	const costLabel =
		cost.low === cost.high
			? formatCredits(cost.high)
			: `${formatCredits(cost.low)}–${formatCredits(cost.high)}`;

	return (
		<Section sectionKey="ai-edit:actions">
			<SectionHeader>
				<SectionTitle>Actions</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-2">
				<ActionRow
					title="Upscale"
					description="Enhance resolution with AI"
					control={
						<div className="flex items-center gap-1.5 opacity-60">
							<select
								disabled
								className="h-7 rounded-md border border-input bg-transparent px-2 text-[11px] text-muted-foreground"
							>
								<option>2x</option>
							</select>
							<Badge variant="secondary" className="text-[9px]">
								Coming soon
							</Badge>
						</div>
					}
				/>
				<ActionRow
					title="Edit"
					description="Transform with a prompt or motion reference"
					control={
						<RemixPopover
							take={remixAnchor}
							anchorImageUrl={remixAnchorUrl}
							onRemix={onRemix}
							buttonSize="sm"
						/>
					}
				/>
				<ActionRow
					title="Rerun"
					description={`Regenerate · ${costLabel} credits`}
					control={
						<Button
							size="sm"
							disabled={rerolling || !spec.prompt?.trim()}
							onClick={onRerun}
						>
							{rerolling ? "Generating…" : "Rerun"}
						</Button>
					}
				/>
			</SectionContent>
		</Section>
	);
}

function ActionRow({
	title,
	description,
	control,
}: {
	title: string;
	description: string;
	control: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-xs font-medium">{title}</span>
				<span className="truncate text-[10px] text-muted-foreground">
					{description}
				</span>
			</div>
			{control}
		</div>
	);
}

// ── Generation spec editor ────────────────────────────────────────────────

function SpecSection({
	spec,
	cost,
	rendersStill,
	commit,
}: {
	spec: GenerationSpec;
	cost: { low: number; high: number };
	rendersStill: boolean;
	commit: (patch: Partial<GenerationSpec>) => void;
}) {
	// Local prompt buffer so typing stays responsive; commit on blur.
	const [prompt, setPrompt] = useState(spec.prompt);
	const [seedText, setSeedText] = useState(
		spec.seed != null ? String(spec.seed) : "",
	);

	// Keep local buffers in sync when the underlying spec's prompt/seed changes
	// out from under us (a different clip selected, or a remix/rerun commit).
	useEffect(() => {
		setPrompt(spec.prompt);
		setSeedText(spec.seed != null ? String(spec.seed) : "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [spec.prompt, spec.seed]);

	return (
		<Section sectionKey="ai-edit:spec">
			<SectionHeader>
				<SectionTitle>Generation</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-3.5">
				{/* Prompt */}
				<div className="space-y-1.5">
					<Label className="text-xs">Prompt</Label>
					<Textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onBlur={() => {
							if (prompt !== spec.prompt) commit({ prompt });
						}}
						rows={3}
						placeholder="Describe your shot…"
						className="resize-none text-sm"
					/>
				</div>

				{/* Camera motion */}
				<div className="space-y-1.5">
					<Label className="text-xs">Camera motion</Label>
					<select
						value={spec.cameraPreset ?? ""}
						onChange={(e) =>
							commit({ cameraPreset: e.target.value || undefined })
						}
						className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
					>
						<option value="">None</option>
						{CAMERA_PRESETS.map((p) => (
							<option key={p.id} value={p.id}>
								{p.category} · {p.label}
							</option>
						))}
					</select>
				</div>

				{/* Orientation */}
				<div className="space-y-1.5">
					<Label className="text-xs">Orientation</Label>
					<div className="flex gap-1.5">
						{ORIENTATIONS.map((o) => (
							<button
								key={o.value}
								type="button"
								onClick={() => commit({ orientation: o.value })}
								className={cn(
									"flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-md text-[11px] font-medium border transition-colors",
									spec.orientation === o.value
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:border-foreground",
								)}
							>
								<span>{o.label}</span>
								<span className="opacity-70">{o.ratio}</span>
							</button>
						))}
					</div>
				</div>

				{/* Resolution */}
				<div className="space-y-1.5">
					<Label className="text-xs">Resolution</Label>
					<div className="flex gap-1.5">
						{RESOLUTIONS.map((r) => (
							<button
								key={r.value}
								type="button"
								onClick={() => commit({ resolution: r.value })}
								className={cn(
									"flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors",
									spec.resolution === r.value
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:border-foreground",
								)}
							>
								{r.label}
							</button>
						))}
					</div>
				</div>

				{/* Seed */}
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<Label className="text-xs">Seed</Label>
						<button
							type="button"
							onClick={() => commit({ seedLocked: !spec.seedLocked })}
							className={cn(
								"text-xs px-2 py-0.5 rounded border transition-colors",
								spec.seedLocked
									? "border-primary text-primary bg-primary/10"
									: "border-border text-muted-foreground hover:border-foreground",
							)}
						>
							{spec.seedLocked ? "Locked" : "Random"}
						</button>
					</div>
					<Input
						type="number"
						value={seedText}
						disabled={!spec.seedLocked}
						placeholder="Leave blank for random"
						onChange={(e) => setSeedText(e.target.value)}
						onBlur={() => {
							const next = seedText.trim() ? parseInt(seedText, 10) : undefined;
							if (next !== spec.seed) commit({ seed: next });
						}}
						className="h-8 text-xs"
					/>
				</div>

				{/* Duration */}
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<Label className="text-xs">Duration</Label>
						<span className="text-xs text-muted-foreground">
							{spec.duration}s
						</span>
					</div>
					<Slider
						min={4}
						max={15}
						step={1}
						value={[spec.duration]}
						onValueChange={([v]) => commit({ duration: v })}
					/>
				</div>

				{/* Live cost estimate */}
				<div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
					<div className="flex flex-col">
						<span className="text-xs font-medium">Estimated cost</span>
						<span className="text-[10px] text-muted-foreground">
							{spec.duration}s · {spec.resolution}
							{rendersStill && " · +1 still"}
						</span>
					</div>
					<div className="flex flex-col items-end">
						{/* Pre-generate credits preview — mirrors the server-authoritative
						    billing table (`lib/credits/cost-table.ts`). Exact routed cost
						    is stamped server-side. */}
						<span className="flex items-center gap-1 text-sm font-semibold tabular-nums">
							<HugeiconsIcon icon={Coins01Icon} className="size-3.5" />
							{cost.low === cost.high ? cost.high : `${cost.low}–${cost.high}`}
						</span>
					</div>
				</div>
			</SectionContent>
		</Section>
	);
}

// ── Takes filmstrip ───────────────────────────────────────────────────────

function TakesSection({
	element,
	trackId,
	editor,
}: {
	element: GenerativeElement;
	trackId: string;
	editor: ReturnType<typeof useEditor>;
}) {
	const takes = element.takes ?? [];

	return (
		<Section>
			<SectionHeader>
				<SectionTitle>Takes</SectionTitle>
				{takes.length > 0 && (
					<Badge variant="secondary" className="ml-2 text-[10px]">
						{takes.length}
					</Badge>
				)}
			</SectionHeader>
			<SectionContent>
				{takes.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						No takes yet. Re-roll to generate alternates.
					</p>
				) : (
					<div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hidden">
						{takes.map((take) => (
							<TakeThumb
								key={take.id}
								take={take}
								active={element.activeTakeId === take.id}
								onSelect={() =>
									editor.timeline.selectTake({
										elementId: element.id,
										takeId: take.id,
									})
								}
								onRemove={() =>
									editor.timeline.removeTake({
										elementId: element.id,
										takeId: take.id,
									})
								}
								thumbnailUrl={resolveThumb(editor, take)}
							/>
						))}
					</div>
				)}
			</SectionContent>
		</Section>
	);
}

/** A take's thumbnail: its own url, else the bound media asset's thumbnail/url. */
function resolveThumb(
	editor: ReturnType<typeof useEditor>,
	take: Take,
): string | undefined {
	if (take.thumbnailUrl) return take.thumbnailUrl;
	if (!take.mediaId) return undefined;
	const asset = editor.media.getAssetById(take.mediaId);
	return asset?.thumbnailUrl ?? asset?.url;
}

function TakeThumb({
	take,
	active,
	onSelect,
	onRemove,
	thumbnailUrl,
}: {
	take: Take;
	active: boolean;
	onSelect: () => void;
	onRemove: () => void;
	thumbnailUrl?: string;
}) {
	const generating = take.status === "queued" || take.status === "generating";
	const failed = take.status === "failed";

	return (
		<div className="group relative w-28 shrink-0">
			<button
				type="button"
				onClick={onSelect}
				className={cn(
					"relative block aspect-video w-full overflow-hidden rounded-md border bg-muted transition-all",
					active
						? "border-primary ring-2 ring-primary"
						: "border-border hover:border-primary/50",
				)}
			>
				{thumbnailUrl && !generating && !failed ? (
					<img
						src={thumbnailUrl}
						alt="Take"
						className="size-full object-cover"
					/>
				) : generating ? (
					<span className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
						<span className="size-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
						<span className="text-[10px]">Generating…</span>
					</span>
				) : failed ? (
					<span className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-center text-destructive">
						<span className="text-[10px] font-medium">Failed</span>
						{take.error && (
							<span className="line-clamp-2 text-[9px] text-muted-foreground">
								{take.error}
							</span>
						)}
					</span>
				) : (
					<span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
						No preview
					</span>
				)}

				{active && (
					<span className="absolute left-1 top-1 rounded bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
						Active
					</span>
				)}
			</button>

			{/* Remove control */}
			<button
				type="button"
				onClick={onRemove}
				aria-label="Remove take"
				className="absolute right-1 top-1 z-10 hidden size-4 items-center justify-center rounded bg-black/60 text-white group-hover:flex hover:bg-destructive"
			>
				<svg viewBox="0 0 20 20" className="size-3" fill="currentColor">
					<path
						fillRule="evenodd"
						d="M6.3 6.3a1 1 0 011.4 0L10 8.6l2.3-2.3a1 1 0 111.4 1.4L11.4 10l2.3 2.3a1 1 0 01-1.4 1.4L10 11.4l-2.3 2.3a1 1 0 01-1.4-1.4L8.6 10 6.3 7.7a1 1 0 010-1.4z"
						clipRule="evenodd"
					/>
				</svg>
			</button>

			{/* Seed badge */}
			{take.seed != null && (
				<span className="mt-1 block truncate text-center font-mono text-[9px] text-muted-foreground">
					#{take.seed}
				</span>
			)}

			{/* Provenance + cost — shown for the active take (metadata chrome). */}
			{active && (
				<div className="mt-1 flex justify-center">
					<TakeProvenanceBadge take={take} />
				</div>
			)}
		</div>
	);
}
