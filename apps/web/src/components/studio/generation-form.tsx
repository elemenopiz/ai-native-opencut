"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/utils/ui";
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";
import { FrameSlot } from "@/components/studio/frame-slot";
import type { GenMode } from "@/stores/studio-settings-store";
import type { MultiframeBase } from "@/lib/studio/multiframe";
import { CameraPresetPicker } from "@/components/studio/camera-preset-picker";
import {
	ReferenceMediaUploader,
	type ReferenceMediaItem,
} from "@/components/studio/reference-media-uploader";
import { composePromptWithCamera } from "@/lib/studio/camera-presets";
import { addsPerShotStill, estimateCost, formatUsd } from "@/lib/studio/cost";
import {
	RESOLUTIONS,
	ORIENTATIONS,
	STILL_SIZE_BY_ORIENTATION,
} from "@/lib/studio/options";
import { useBackends } from "@/hooks/use-backends";
// Client-safe: registry.ts is pure data (a Map + type imports), no secret env.
import { DEFAULT_BACKEND_ID } from "@/lib/studio/backends/registry";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import { useFrameChainStore } from "@/stores/frame-chain-store";
import { usePersonaStore } from "@/stores/persona-store";
import { EnhancePromptButton } from "@/components/editor/ai/enhance-prompt-button";
import { toast } from "sonner";

interface GenerationFormProps {
	onGenerate: (params: {
		prompt: string;
		referenceImageUrl?: string;
		referenceImages?: string[];
		referenceVideos?: string[];
		lastFrameUrl?: string;
		seed?: number;
		resolution: VideoResolution;
		orientation: VideoOrientation;
		duration: number;
		mode: VideoMode;
		personaId?: string;
		consistencyMode?: "high" | "fast";
	}) => void;
	onGenerateMultiframe?: (
		keyframes: string[],
		base: MultiframeBase,
	) => void | Promise<void>;
	busy?: boolean;
	className?: string;
}

const GEN_MODES: { value: GenMode; label: string; hint: string }[] = [
	{
		value: "omni",
		label: "Omni",
		hint: "Omni reference — references guide the shot; @mention them in the prompt. None is a fixed frame.",
	},
	{
		value: "first-last",
		label: "First/Last",
		hint: "First & last frame — a start frame (and optional end frame) for Seedance to transition between.",
	},
	{
		value: "multiframe",
		label: "Multiframe",
		hint: "Multiframe — 2–10 keyframes; each consecutive pair becomes a clip, laid end-to-end on the timeline.",
	},
];

const CONSISTENCY_OPTIONS: {
	value: "high" | "fast";
	label: string;
	hint: string;
}[] = [
	{
		value: "fast",
		label: "Fast",
		hint: "Reuses the persona's anchor image directly — quickest and cheapest, loosest likeness.",
	},
	{
		value: "high",
		label: "Balanced",
		hint: "Renders a fresh per-shot reference still from the persona's photos — best all-round likeness (+1 image per shot).",
	},
];

/** Small frame glyph so orientation reads at a glance. */
function OrientationGlyph({ value }: { value: VideoOrientation }) {
	const dims =
		value === "portrait"
			? { w: 10, h: 16 }
			: value === "square"
				? { w: 14, h: 14 }
				: { w: 16, h: 10 };
	return (
		<span
			className="rounded-[2px] border-2 border-current"
			style={{ width: dims.w, height: dims.h }}
		/>
	);
}

export function GenerationForm({
	onGenerate,
	onGenerateMultiframe,
	busy,
	className,
}: GenerationFormProps) {
	// Sticky settings — last choice becomes the default next time.
	const {
		genMode,
		orientation,
		resolution,
		duration,
		cameraPreset,
		seedLocked,
		consistencyMode,
		set: setSettings,
	} = useStudioSettingsStore();

	// ── Backend-aware controls ────────────────────────────────────────────────
	// The catalog of configured video backends (BytePlus / Veo / Kling / …),
	// fetched client-safe from GET /api/studio/backends. Each carries its real
	// capability surface (resolutions / orientations / duration range / modes /
	// seed-lock / omni-reference / last-frame) so the form offers only what the
	// SELECTED backend actually supports instead of a flat option set.
	const { backends } = useBackends("video");
	const [backendId, setBackendId] = useState<string>("");
	// Resolve the active backend: the user's pick, else the platform default,
	// else the first configured one. `undefined` while the catalog is loading or
	// when no provider is configured — in that case we fall back to the full
	// option sets so the form never renders empty.
	const selectedBackend = useMemo(() => {
		if (backends.length === 0) return undefined;
		return (
			backends.find((b) => b.id === backendId) ??
			backends.find((b) => b.id === DEFAULT_BACKEND_ID.video) ??
			backends[0]
		);
	}, [backends, backendId]);

	// Constrained option sets, derived from the selected backend's capabilities.
	// Missing capability data (image-only backend, or still loading) ⇒ full set.
	const availableResolutions = useMemo(
		() =>
			selectedBackend?.resolutions
				? RESOLUTIONS.filter((r) =>
						selectedBackend.resolutions?.includes(r.value),
					)
				: RESOLUTIONS,
		[selectedBackend],
	);
	const availableOrientations = useMemo(
		() =>
			selectedBackend?.orientations
				? ORIENTATIONS.filter((o) =>
						selectedBackend.orientations?.includes(o.value),
					)
				: ORIENTATIONS,
		[selectedBackend],
	);
	// First-&-last and multiframe both ride flf2v, so they need last-frame
	// support; Omni is the base text-to-video mode and is always offered.
	const availableModes = useMemo(
		() =>
			GEN_MODES.filter((m) => {
				if (!selectedBackend) return true;
				if (m.value === "first-last" || m.value === "multiframe")
					return selectedBackend.supportsLastFrame;
				return true;
			}),
		[selectedBackend],
	);
	const durationRange = selectedBackend?.durationRangeSec ?? {
		min: 4,
		max: 15,
	};
	const supportsSeedLock = selectedBackend
		? selectedBackend.supportsSeedLock
		: true;
	const supportsOmniRef = selectedBackend
		? selectedBackend.supportsOmniReference
		: true;

	// Active persona drives reference-conditioned character consistency. When set,
	// generation is forced to image-to-video and the reference frame is supplied
	// server-side (see /api/studio/generate), so the manual reference UI is hidden.
	const activePersona = usePersonaStore((s) =>
		s.personas.find((p) => p.id === s.activePersonaId),
	);
	const clearPersona = usePersonaStore((s) => s.setActive);

	// Transient per-generation inputs.
	const [prompt, setPrompt] = useState("");
	const [seed, setSeed] = useState<string>("");
	// Omni references (images + videos) — drag from Assets, drop, or browse.
	const [refMedia, setRefMedia] = useState<ReferenceMediaItem[]>([]);
	const refUploading = refMedia.some((r) => r.status === "uploading");
	// First & last frame mode.
	const [firstFrameUrl, setFirstFrameUrl] = useState<string | null>(null);
	const [lastFrameUrl, setLastFrameUrl] = useState<string | null>(null);
	// Multiframe mode — an ordered list of keyframe slots (2–10).
	const [keyframes, setKeyframes] = useState<(string | null)[]>([null, null]);
	const [mfBusy, setMfBusy] = useState(false);
	// How many variations to generate at once (omni / first-last only).
	const [count, setCount] = useState(1);

	const isOmni = !activePersona && genMode === "omni";
	const isMultiframe = !activePersona && genMode === "multiframe";
	const readyKeyframes = keyframes.filter((k): k is string => !!k);
	// Omni's reference uploader + @mentions only make sense when the selected
	// backend actually conditions on omni references; otherwise Omni degrades to
	// plain text-to-video and we hide the attach UI. Persona always uses refs.
	const showOmniRefs = (isOmni && supportsOmniRef) || !!activePersona;

	// Coerce sticky settings that the newly selected backend can't honor: an
	// unsupported resolution/orientation, an out-of-range duration, a seed lock
	// on a seedless model, or a mode the backend doesn't offer. Runs on backend
	// switch (and initial load) so a stale localStorage choice never produces an
	// invalid request or a highlighted-but-absent control.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!selectedBackend) return;
		const patch: Partial<Parameters<typeof setSettings>[0]> = {};
		if (
			selectedBackend.resolutions &&
			!selectedBackend.resolutions.includes(resolution)
		) {
			patch.resolution = selectedBackend.resolutions.includes("720p")
				? "720p"
				: selectedBackend.resolutions[0];
		}
		if (
			selectedBackend.orientations &&
			!selectedBackend.orientations.includes(orientation)
		) {
			patch.orientation = selectedBackend.orientations[0];
		}
		const { min, max } = durationRange;
		if (duration < min) patch.duration = min;
		else if (duration > max) patch.duration = max;
		if (!supportsSeedLock && seedLocked) patch.seedLocked = false;
		if (!availableModes.some((m) => m.value === genMode)) {
			// Omni is never filtered out, so availableModes is always non-empty.
			patch.genMode = availableModes[0]?.value ?? "omni";
		}
		if (Object.keys(patch).length > 0) setSettings(patch);
	}, [selectedBackend]);

	// ── @mention referencing (Seedance omni-reference) ───────────────────────
	// Each ready attachment gets an ordered handle — @Image1.., @Video1.. — that
	// matches the order we send to BytePlus, so "@Image1 as the character" in the
	// prompt resolves to the first reference image. Mirrors Dreamina/Higgsfield.
	const referenceHandles = useMemo(() => {
		// Only Omni (and persona, which also uses omni refs) exposes @mentions.
		if (!showOmniRefs) return [];
		const out: {
			id: string;
			handle: string;
			kind: "image" | "video";
			url: string;
			name: string;
		}[] = [];
		let img = 0;
		let vid = 0;
		for (const r of refMedia) {
			if (r.status !== "ready") continue;
			const handle = r.kind === "image" ? `@Image${++img}` : `@Video${++vid}`;
			out.push({ id: r.id, handle, kind: r.kind, url: r.url, name: r.name });
		}
		return out;
	}, [refMedia, showOmniRefs]);

	const handleMap = useMemo(
		() => Object.fromEntries(referenceHandles.map((h) => [h.id, h.handle])),
		[referenceHandles],
	);

	const promptRef = useRef<HTMLTextAreaElement>(null);
	// Synchronous in-flight guard. `generating` is derived from render-time state,
	// so two rapid triggers (Enter + click) can both pass the busy check before
	// setMfBusy flushes; this ref blocks the second one immediately.
	const inFlightRef = useRef(false);

	// ── Frame chaining ────────────────────────────────────────────────────────
	// A frame extracted from a clip ("Use as next first frame") lands in the
	// frame-chain store as a hosted URL. Consume it: drop it into the First-frame
	// slot and, when the selected backend supports it, flip to First/Last mode so
	// the slot is visible. If the backend can't do first-last, we still set the
	// URL (the capability coercion effect keeps genMode valid) so nothing is lost.
	const pendingFirstFrame = useFrameChainStore((s) => s.pendingFirstFrame);
	const frameChainNonce = useFrameChainStore((s) => s.nonce);
	const clearPendingFirstFrame = useFrameChainStore(
		(s) => s.clearPendingFirstFrame,
	);
	// Consume-once on the nonce edge only — re-running on pendingFirstFrame /
	// availableModes changes would re-apply a frame the user already dismissed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional nonce-keyed one-shot
	useEffect(() => {
		if (!pendingFirstFrame) return;
		setFirstFrameUrl(pendingFirstFrame.url);
		if (availableModes.some((m) => m.value === "first-last")) {
			setSettings({ genMode: "first-last" });
		}
		clearPendingFirstFrame();
		requestAnimationFrame(() => promptRef.current?.focus());
	}, [frameChainNonce]);
	// Open autocomplete state: the partial query after "@" and where "@" starts.
	const [mention, setMention] = useState<{
		query: string;
		start: number;
	} | null>(null);
	const [mentionHi, setMentionHi] = useState(0);

	const mentionMatches = useMemo(() => {
		if (!mention) return [];
		const q = mention.query.toLowerCase();
		return referenceHandles.filter((h) =>
			h.handle.slice(1).toLowerCase().startsWith(q),
		);
	}, [mention, referenceHandles]);

	// Re-evaluate whether the caret sits in an "@partial" token.
	function refreshMention(el: HTMLTextAreaElement) {
		if (referenceHandles.length === 0) {
			setMention(null);
			return;
		}
		const caret = el.selectionStart ?? el.value.length;
		const before = el.value.slice(0, caret);
		const m = before.match(/(?:^|\s)@(\w*)$/);
		if (m) {
			setMention({ query: m[1], start: caret - m[1].length - 1 });
			setMentionHi(0);
		} else {
			setMention(null);
		}
	}

	function insertMention(handle: string) {
		if (!mention) return;
		const el = promptRef.current;
		const caret = el?.selectionStart ?? prompt.length;
		const next =
			prompt.slice(0, mention.start) + handle + " " + prompt.slice(caret);
		setPrompt(next);
		setMention(null);
		const pos = mention.start + handle.length + 1;
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	}

	function handlePromptKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (!mention || mentionMatches.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setMentionHi((i) => (i + 1) % mentionMatches.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setMentionHi(
				(i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
			);
		} else if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			insertMention(mentionMatches[mentionHi].handle);
		} else if (e.key === "Escape") {
			e.preventDefault();
			setMention(null);
		}
	}

	const readyImages = refMedia.filter(
		(r) => r.status === "ready" && r.kind === "image",
	);
	const readyVideos = refMedia.filter(
		(r) => r.status === "ready" && r.kind === "video",
	);

	// What each mode requires before you can generate. Omni and persona need
	// nothing extra (text alone is fine); First-&-last needs a start frame;
	// Multiframe needs at least two keyframes (one segment).
	const needsReference =
		!activePersona &&
		((genMode === "first-last" && !firstFrameUrl) ||
			(genMode === "multiframe" && readyKeyframes.length < 2));

	const generating = busy || mfBusy;

	// Live cost estimate — recomputes on every resolution/duration/consistency
	// change. The per-shot still (when persona High) is rendered once for the whole
	// batch, so it's added once here while the video cost scales with count/segments.
	const rendersStill = addsPerShotStill(!!activePersona, consistencyMode);
	const costMult = isMultiframe
		? Math.max(0, readyKeyframes.length - 1)
		: count;
	const cost = estimateCost(resolution, duration, rendersStill, costMult);

	async function handleGenerate() {
		if (!prompt.trim() || needsReference || refUploading || generating) return;
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		try {
			await runGenerate();
		} finally {
			inFlightRef.current = false;
		}
	}

	async function runGenerate() {
		// Multiframe runs its own orchestration: N-1 flf2v segments placed onto
		// the timeline in order (Seedance can't take >2 frames in one call).
		if (isMultiframe) {
			setMfBusy(true);
			try {
				await onGenerateMultiframe?.(readyKeyframes, {
					prompt: composePromptWithCamera(prompt, cameraPreset),
					resolution,
					orientation,
					duration,
					seed: seedLocked && seed ? parseInt(seed, 10) : undefined,
				});
			} finally {
				setMfBusy(false);
			}
			return;
		}

		// Persona High-consistency: render ONE reference still for the whole batch
		// up front so every draft shares an identical frame (drafts stay comparable
		// and promote-to-1080p reproduces the exact shot) and we pay for a single
		// gpt-image render instead of one per draft. Fast mode uses the persona
		// anchor directly (resolved server-side).
		let personaStillUrl: string | undefined;
		if (activePersona && consistencyMode === "high") {
			setMfBusy(true);
			try {
				const res = await fetch(
					`/api/studio/personas/${activePersona.id}/still`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							scenePrompt: prompt,
							size: STILL_SIZE_BY_ORIENTATION[orientation],
						}),
					},
				);
				if (!res.ok) {
					const data = (await res.json().catch(() => ({}))) as {
						error?: string;
					};
					throw new Error(data.error ?? "Failed to render persona still");
				}
				const data = (await res.json()) as { imageUrl: string };
				personaStillUrl = data.imageUrl;
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : "Failed to render persona still",
				);
				return;
			} finally {
				setMfBusy(false);
			}
		}

		// Map the active mode onto the provider's reference fields. Omni sends
		// role:reference_image refs (@mentioned in the prompt); First-&-last sends
		// a start frame (+ optional end frame) for i2v / flf2v.
		const omniImages =
			isOmni || activePersona ? readyImages.map((r) => r.url) : [];
		const omniVideos =
			isOmni || activePersona ? readyVideos.map((r) => r.url) : [];

		const params = {
			prompt: composePromptWithCamera(prompt, cameraPreset),
			referenceImageUrl:
				personaStillUrl ??
				(!activePersona && genMode === "first-last"
					? (firstFrameUrl ?? undefined)
					: undefined),
			lastFrameUrl:
				!activePersona && genMode === "first-last"
					? (lastFrameUrl ?? undefined)
					: undefined,
			referenceImages: omniImages.length ? omniImages : undefined,
			referenceVideos: omniVideos.length ? omniVideos : undefined,
			seed: seedLocked && seed ? parseInt(seed, 10) : undefined,
			resolution,
			orientation,
			duration,
			// First-&-last is image-conditioned; Omni is text-driven (refs aside).
			mode: (activePersona || (!activePersona && genMode === "first-last")
				? "image-to-video"
				: "text-to-video") as VideoMode,
			personaId: activePersona?.id,
			consistencyMode: activePersona ? consistencyMode : undefined,
		};

		// Fire `count` variations at once. With no locked seed each picks its own
		// random seed server-side, so you get distinct takes.
		for (let i = 0; i < count; i++) onGenerate(params);
	}

	return (
		<div className={cn("flex flex-col gap-4", className)}>
			{/* Model — pick which configured video backend to generate with. The
			    controls below (resolution / orientation / duration / mode / seed)
			    reshape to that backend's real capabilities. Hidden when only one
			    backend is configured (nothing to switch between). */}
			{backends.length > 1 && (
				<div className="space-y-1.5">
					<Label className="text-xs">Model</Label>
					<div className="flex flex-wrap gap-2">
						{backends.map((b) => (
							<button
								key={b.id}
								onClick={() => setBackendId(b.id)}
								title={`${b.vendor} · ${b.safetyTier}`}
								className={cn(
									"py-1.5 px-2.5 rounded-md text-xs font-medium border transition-colors",
									selectedBackend?.id === b.id
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:border-foreground",
								)}
							>
								{b.label}
							</button>
						))}
					</div>
					{selectedBackend && (
						<p className="text-[10px] text-muted-foreground">
							{selectedBackend.vendor}
						</p>
					)}
				</div>
			)}

			{/* Persona — when active, replaces mode selection and drives
			    reference-conditioned character consistency. */}
			{activePersona && (
				<div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2.5">
					<div className="flex items-center gap-2">
						<img
							src={activePersona.anchorImageUrl}
							alt={activePersona.name}
							className="h-9 w-9 rounded object-cover shrink-0"
						/>
						<div className="min-w-0 flex-1">
							<p className="text-xs font-medium truncate">
								Persona: {activePersona.name}
							</p>
							<p className="text-[10px] text-muted-foreground">
								Same character every shot · image-to-video
							</p>
						</div>
						<button
							onClick={() => clearPersona(null)}
							className="text-[10px] text-muted-foreground underline shrink-0"
						>
							Clear
						</button>
					</div>

					{/* Consistency toggle */}
					<div className="space-y-1">
						<span className="text-[10px] text-muted-foreground">
							Consistency
						</span>
						<div className="flex gap-1.5">
							{CONSISTENCY_OPTIONS.map((opt) => (
								<button
									key={opt.value}
									onClick={() => setSettings({ consistencyMode: opt.value })}
									title={opt.hint}
									className={cn(
										"flex-1 py-1 rounded text-[11px] font-medium border transition-colors whitespace-nowrap",
										consistencyMode === opt.value
											? "bg-primary text-primary-foreground border-primary"
											: "border-border text-muted-foreground hover:border-foreground",
									)}
								>
									{opt.label}
								</button>
							))}
						</div>
						<p className="text-[10px] text-muted-foreground">
							{
								CONSISTENCY_OPTIONS.find((o) => o.value === consistencyMode)
									?.hint
							}
						</p>
					</div>
				</div>
			)}

			{/* Reference mode — Omni reference or First & last frame. Hidden
			    while a persona is active (persona drives its own consistency). */}
			{!activePersona && (
				<div className="space-y-1.5">
					<Label className="text-xs">Mode</Label>
					<div className="flex gap-2">
						{availableModes.map((m) => (
							<button
								key={m.value}
								onClick={() => setSettings({ genMode: m.value })}
								className={cn(
									"flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors",
									genMode === m.value
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:border-foreground",
								)}
							>
								{m.label}
							</button>
						))}
					</div>
					<p className="text-[10px] text-muted-foreground">
						{GEN_MODES.find((m) => m.value === genMode)?.hint}
					</p>
					{/* A chained/extracted first frame is parked but the selected model
					    has no first-frame-capable mode — say so instead of silently
					    dropping it from the payload. */}
					{firstFrameUrl &&
						!availableModes.some((m) => m.value === "first-last") && (
							<p className="text-[10px] text-amber-600 dark:text-amber-500">
								A first frame is attached, but{" "}
								{selectedBackend?.label ?? "this model"} doesn&apos;t support a
								first-frame seed — pick a First/Last-capable model to use it.
							</p>
						)}
				</div>
			)}

			{/* Omni references — drag from Assets, drop, or browse; @mention them.
			    Hidden when the selected backend can't condition on omni refs. */}
			{showOmniRefs && (
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<Label className="text-xs">References</Label>
						<span className="text-[10px] text-muted-foreground">
							optional · drag, drop, or @mention
						</span>
					</div>
					<ReferenceMediaUploader
						items={refMedia}
						onChange={setRefMedia}
						handles={handleMap}
						disabled={busy}
					/>
				</div>
			)}

			{/* First & last frame */}
			{!activePersona && genMode === "first-last" && (
				<div className="space-y-1.5">
					<Label className="text-xs">Frames</Label>
					<div className="flex gap-2">
						<FrameSlot
							label="First frame"
							value={firstFrameUrl}
							onChange={setFirstFrameUrl}
							disabled={busy}
						/>
						<FrameSlot
							label="Last frame · optional"
							value={lastFrameUrl}
							onChange={setLastFrameUrl}
							disabled={busy}
						/>
					</div>
				</div>
			)}

			{/* Multiframe — 2–10 ordered keyframes; each consecutive pair becomes a
			    flf2v clip stitched onto the timeline. */}
			{isMultiframe && (
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<Label className="text-xs">Keyframes</Label>
						<span className="text-[10px] text-muted-foreground">
							{readyKeyframes.length >= 2
								? `${readyKeyframes.length - 1} clip${readyKeyframes.length - 1 === 1 ? "" : "s"}`
								: "add ≥ 2"}
						</span>
					</div>
					<div className="grid grid-cols-2 gap-2">
						{keyframes.map((url, i) => (
							<div key={i} className="relative">
								<FrameSlot
									label={`Frame ${i + 1}`}
									value={url}
									onChange={(v) =>
										setKeyframes((prev) =>
											prev.map((k, idx) => (idx === i ? v : k)),
										)
									}
									disabled={busy || mfBusy}
								/>
								{keyframes.length > 2 && (
									<button
										type="button"
										onClick={() =>
											setKeyframes((prev) => prev.filter((_, idx) => idx !== i))
										}
										className="absolute -right-1 -top-1 z-10 flex size-4 items-center justify-center rounded-full border border-border bg-background text-[10px] leading-none text-muted-foreground hover:text-foreground"
										aria-label={`Remove frame ${i + 1}`}
									>
										×
									</button>
								)}
							</div>
						))}
					</div>
					{keyframes.length < 10 && (
						<button
							type="button"
							onClick={() => setKeyframes((prev) => [...prev, null])}
							className="w-full rounded-md border border-dashed border-border py-1.5 text-[11px] text-muted-foreground hover:border-foreground hover:text-foreground"
						>
							+ Add keyframe
						</button>
					)}
					<p className="text-[10px] text-muted-foreground">
						Generates {Math.max(0, readyKeyframes.length - 1)} segment
						{readyKeyframes.length - 1 === 1 ? "" : "s"} in order and drops them
						on the timeline.
					</p>
				</div>
			)}

			{/* Prompt — supports @mention referencing of attached media */}
			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<Label className="text-xs">Prompt</Label>
					<EnhancePromptButton
						mode="video"
						getPrompt={() => prompt}
						setPrompt={setPrompt}
						getContext={() => {
							// Ground the rewrite in what each @handle actually points at, so
							// the model has a reason to keep — not just permission to keep —
							// the literal token (see enhance-prompt/route.ts's HARD RULE).
							// The route's schema caps assetNotes at 10 entries × 500 chars and
							// 400s the whole request past that — and attachments are uncapped
							// here — so stay inside the contract instead of silently breaking
							// Enhance for prolific attachers (handles 11+ lose grounding only;
							// the client-side restore backstop still covers them).
							const assetNotes = referenceHandles.length
								? referenceHandles
										.slice(0, 10)
										.map(
											(h) =>
												`${h.handle} = attached reference ${h.kind} ("${h.name.slice(0, 200)}")`,
										)
								: undefined;
							const persona = activePersona
								? `${activePersona.name}: ${activePersona.descriptor}`
								: undefined;
							return assetNotes || persona
								? { assetNotes, persona }
								: undefined;
						}}
					/>
				</div>
				<div className="relative">
					<Textarea
						ref={promptRef}
						placeholder={
							isOmni
								? "Describe your shot…  Type @ to reference attached media."
								: "Describe your shot…"
						}
						value={prompt}
						onChange={(e) => {
							setPrompt(e.target.value);
							refreshMention(e.target);
						}}
						onClick={(e) => refreshMention(e.currentTarget)}
						onKeyUp={(e) => refreshMention(e.currentTarget)}
						onKeyDown={handlePromptKeyDown}
						onBlur={() => setMention(null)}
						rows={3}
						className="resize-none text-sm border-border"
					/>

					{mention && mentionMatches.length > 0 && (
						<div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
							{mentionMatches.map((h, i) => (
								<button
									key={h.id}
									type="button"
									// onMouseDown (not onClick) so the textarea doesn't blur first.
									onMouseDown={(e) => {
										e.preventDefault();
										insertMention(h.handle);
									}}
									onMouseEnter={() => setMentionHi(i)}
									className={cn(
										"flex w-full items-center gap-2 px-2 py-1.5 text-left",
										i === mentionHi ? "bg-accent" : "hover:bg-accent/50",
									)}
								>
									{h.kind === "image" ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img
											src={h.url}
											alt=""
											className="size-7 shrink-0 rounded object-cover"
										/>
									) : (
										<video
											src={h.url}
											className="size-7 shrink-0 rounded object-cover"
											muted
										/>
									)}
									<span className="text-xs font-medium">{h.handle}</span>
									<span className="truncate text-[10px] text-muted-foreground">
										{h.name}
									</span>
								</button>
							))}
						</div>
					)}
				</div>
				{referenceHandles.length > 0 && (
					<p className="text-[10px] text-muted-foreground">
						Reference attached media in your prompt with{" "}
						{referenceHandles.map((h, i) => (
							<span key={h.id}>
								{i > 0 && ", "}
								<button
									type="button"
									onClick={() =>
										setPrompt(
											(p) =>
												p + (p && !p.endsWith(" ") ? " " : "") + h.handle + " ",
										)
									}
									className="rounded bg-muted px-1 font-mono text-foreground hover:bg-muted/70"
								>
									{h.handle}
								</button>
							</span>
						))}
					</p>
				)}
			</div>

			{/* Camera & motion */}
			<div className="space-y-1.5">
				<Label className="text-xs">Camera motion</Label>
				<CameraPresetPicker
					value={cameraPreset}
					onChange={(v) => setSettings({ cameraPreset: v })}
				/>
			</div>

			{/* Orientation */}
			<div className="space-y-1.5">
				<Label className="text-xs">Orientation</Label>
				<div className="flex gap-2">
					{availableOrientations.map((o) => (
						<button
							key={o.value}
							onClick={() => setSettings({ orientation: o.value })}
							className={cn(
								"flex-1 flex flex-col items-center gap-1 py-2 rounded-md text-xs font-medium border transition-colors",
								orientation === o.value
									? "bg-primary text-primary-foreground border-primary"
									: "border-border text-muted-foreground hover:border-foreground",
							)}
						>
							<span className="h-4 flex items-center">
								<OrientationGlyph value={o.value} />
							</span>
							<span>{o.label}</span>
							<span className="opacity-70">{o.ratio}</span>
						</button>
					))}
				</div>
			</div>

			{/* Seed — only shown for backends that accept a reproducible seed.
			    Seedless models (e.g. Veo, Kling, Luma) hide this entirely. */}
			{supportsSeedLock && (
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<Label className="text-xs">Seed</Label>
						<button
							onClick={() => setSettings({ seedLocked: !seedLocked })}
							className={cn(
								"text-xs px-2 py-0.5 rounded border transition-colors",
								seedLocked
									? "border-primary text-primary bg-primary/10"
									: "border-border text-muted-foreground hover:border-foreground",
							)}
						>
							{seedLocked ? "Locked" : "Random"}
						</button>
					</div>
					<Input
						type="number"
						placeholder="Leave blank for random"
						value={seed}
						disabled={!seedLocked}
						onChange={(e) => setSeed(e.target.value)}
						className="h-8 text-xs"
					/>
					<p className="text-xs text-muted-foreground">
						Every take stores its seed, so you can promote any winner to 1080p —
						no upscaling.
					</p>
				</div>
			)}

			{/* Resolution */}
			<div className="space-y-1.5">
				<Label className="text-xs">Resolution</Label>
				<div className="flex gap-2">
					{availableResolutions.map((r) => (
						<button
							key={r.value}
							onClick={() => setSettings({ resolution: r.value })}
							title={r.hint}
							className={cn(
								"flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors",
								resolution === r.value
									? "bg-primary text-primary-foreground border-primary"
									: "border-border text-muted-foreground hover:border-foreground",
							)}
						>
							{r.label}
						</button>
					))}
				</div>
				<p className="text-xs text-muted-foreground">
					{RESOLUTIONS.find((r) => r.value === resolution)?.hint}
				</p>
			</div>

			{/* Duration — in multiframe this is per-clip (the 15s cap is per flf2v
			    segment); the stitched total is per-clip × number of segments. */}
			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<Label className="text-xs">
						{isMultiframe ? "Duration / clip" : "Duration"}
					</Label>
					<span className="text-xs text-muted-foreground">
						{isMultiframe && readyKeyframes.length >= 2
							? `${duration}s × ${readyKeyframes.length - 1} = ${duration * (readyKeyframes.length - 1)}s total`
							: `${duration}s`}
					</span>
				</div>
				<Slider
					min={durationRange.min}
					max={durationRange.max}
					step={1}
					value={[duration]}
					onValueChange={([v]) => setSettings({ duration: v })}
				/>
				{isMultiframe && (
					<p className="text-[10px] text-muted-foreground">
						A single clip caps at {durationRange.max}s — multiframe stitches
						segments, so the full timeline runs much longer.
					</p>
				)}
			</div>

			{/* Variations — fire several generations at once (not for multiframe,
			    which is itself a sequence). */}
			{!isMultiframe && (
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<Label className="text-xs">Variations</Label>
						<span className="text-[10px] text-muted-foreground">
							{count === 1 ? "one take" : `${count} takes at once`}
						</span>
					</div>
					<div className="flex gap-2">
						{[1, 2, 3, 4].map((n) => (
							<button
								key={n}
								type="button"
								onClick={() => setCount(n)}
								className={cn(
									"flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors",
									count === n
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:border-foreground",
								)}
							>
								{n}
							</button>
						))}
					</div>
				</div>
			)}

			{/* Live cost estimate — adjusts with duration, resolution & consistency */}
			<div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
				<div className="flex flex-col">
					<span className="text-xs font-medium">Estimated cost</span>
					<span className="text-[10px] text-muted-foreground">
						{isMultiframe
							? `${Math.max(0, readyKeyframes.length - 1)} × ${duration}s · ${resolution}`
							: `${count > 1 ? `${count} × ` : ""}${duration}s · ${resolution}`}
						{rendersStill && " · +1 still"}
					</span>
				</div>
				<span className="text-sm font-semibold tabular-nums">
					{`${formatUsd(cost.low)}–${formatUsd(cost.high)}`}
				</span>
			</div>

			<Button
				onClick={handleGenerate}
				disabled={
					!prompt.trim() || needsReference || refUploading || generating
				}
				className="w-full"
				size="sm"
			>
				{mfBusy
					? "Generating segments…"
					: busy
						? "Generating…"
						: needsReference
							? isMultiframe
								? "Add at least 2 keyframes"
								: "Add a first frame"
							: refUploading
								? "Uploading…"
								: isMultiframe
									? `Generate ${Math.max(0, readyKeyframes.length - 1)} segments`
									: count > 1
										? `Generate ${count}`
										: "Generate"}
			</Button>
		</div>
	);
}
