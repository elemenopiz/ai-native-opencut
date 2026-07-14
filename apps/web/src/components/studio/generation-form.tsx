"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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
import { addsPerShotStill, estimateCost } from "@/lib/studio/cost";
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
import { useOmniReferenceChainStore } from "@/stores/omni-reference-chain-store";
import { usePersonaStore } from "@/stores/persona-store";
import { EnhancePromptButton } from "@/components/editor/ai/enhance-prompt-button";
import {
	ChipGrid,
	GenerationBottomBar,
	GenerationCard,
	TextTabs,
} from "@/components/studio/generation-bottom-bar";
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
		generateAudio?: boolean;
		/** Manual model pin — the routed backend id from the bottom bar's model
		 *  picker. The generate route accepts this as `model` and forwards it to
		 *  the router's `preferredBackendId`; omitted ⇒ auto-route (unchanged
		 *  behavior). Additive-only: `useStudioGeneration`'s `generate()` just
		 *  `JSON.stringify`s whatever params it's given, so this rides along
		 *  without any hook-signature change. */
		model?: string;
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

/** Candidate seconds to offer as Duration chips — filtered down to whatever
 *  falls inside the selected backend's real [min, max] range, with the range's
 *  own endpoints always included so every backend gets at least one chip. */
const DURATION_STEP_CANDIDATES = [3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30];

function durationChipOptions(min: number, max: number) {
	const values = new Set<number>([min, max]);
	for (const c of DURATION_STEP_CANDIDATES)
		if (c > min && c < max) values.add(c);
	return [...values]
		.sort((a, b) => a - b)
		.map((v) => ({ value: v, label: `${v}s` }));
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
		consistencyMode,
		set: setSettings,
	} = useStudioSettingsStore();

	// ── Backend-aware controls ────────────────────────────────────────────────
	// The catalog of configured video backends (BytePlus / Kling / Veo / …),
	// fetched client-safe from GET /api/studio/backends. Each carries its real
	// capability surface (resolutions / orientations / duration range / modes /
	// omni-reference / last-frame / audio-toggle) so the bottom bar's settings
	// popover offers only what the SELECTED backend actually supports.
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
	const durationOptions = useMemo(
		() => durationChipOptions(durationRange.min, durationRange.max),
		[durationRange.min, durationRange.max],
	);
	const supportsOmniRef = selectedBackend
		? selectedBackend.supportsOmniReference
		: true;
	const supportsAudioToggle = selectedBackend?.supportsAudioToggle ?? false;

	// Active persona drives reference-conditioned character consistency. When set,
	// generation is forced to image-to-video and the reference frame is supplied
	// server-side (see /api/studio/generate), so the manual reference UI is hidden.
	const activePersona = usePersonaStore((s) =>
		s.personas.find((p) => p.id === s.activePersonaId),
	);
	const clearPersona = usePersonaStore((s) => s.setActive);

	// Transient per-generation inputs.
	const [prompt, setPrompt] = useState("");
	// Cosmetic, local-only label — not sent to the provider. Palmier-style
	// "Name" field so a shot is easy to tell apart in a busy panel before it has
	// a take; surfaces in this form's own toasts only.
	const [name, setName] = useState("");
	// Silent-render toggle — only meaningful for backends that can actually turn
	// generated audio off (see `supportsAudioToggle`). Defaults to on (provider
	// default) so backends without the capability are never silently muted.
	const [audioOn, setAudioOn] = useState(true);
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
	const showReferencesRow =
		showOmniRefs || genMode === "first-last" || isMultiframe;

	// Coerce sticky settings that the newly selected backend can't honor: an
	// unsupported resolution/orientation, an out-of-range duration, or a mode
	// the backend doesn't offer. Runs on backend switch (and initial load) so a
	// stale localStorage choice never produces an invalid request or a
	// highlighted-but-absent control.
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
		if (!availableModes.some((m) => m.value === genMode)) {
			// Omni is never filtered out, so availableModes is always non-empty.
			patch.genMode = availableModes[0]?.value ?? "omni";
		}
		if (Object.keys(patch).length > 0) setSettings(patch);
	}, [selectedBackend]);

	// A backend without the audio-toggle capability can't honor `audioOn` at
	// all — reset to "on" (provider default) so switching TO an untoggleable
	// backend never carries a stale "off" choice that would silently be ignored.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!supportsAudioToggle) setAudioOn(true);
	}, [supportsAudioToggle]);

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

	// ── Omni-reference chaining ───────────────────────────────────────────────
	// A trimmed clip sent from the timeline ("Send to Omni Reference") lands in
	// the omni-reference-chain store as a hosted URL + kind. Consume it: APPEND it
	// as a new ready chip to the Omni reference list and, when the selected
	// backend supports Omni, flip to Omni mode so the reference uploader is
	// visible. If the backend can't do Omni, we still append (the capability
	// coercion effect keeps genMode valid) so nothing is lost. Kept separate from
	// the first-frame effect above — different destination (chip list vs. slot).
	const pendingReference = useOmniReferenceChainStore(
		(s) => s.pendingReference,
	);
	const omniRefChainNonce = useOmniReferenceChainStore((s) => s.nonce);
	const clearPendingReference = useOmniReferenceChainStore(
		(s) => s.clearPendingReference,
	);
	// Consume-once on the nonce edge only — re-running on pendingReference /
	// availableModes changes would re-append a reference the user already removed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional nonce-keyed one-shot
	useEffect(() => {
		if (!pendingReference) return;
		setRefMedia((prev) => [
			...prev,
			{
				id: crypto.randomUUID(),
				url: pendingReference.url,
				kind: pendingReference.kind,
				name: pendingReference.label,
				status: "ready",
			},
		]);
		if (genMode !== "omni" && availableModes.some((m) => m.value === "omni")) {
			setSettings({ genMode: "omni" });
		}
		clearPendingReference();
		requestAnimationFrame(() => promptRef.current?.focus());
	}, [omniRefChainNonce]);
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
	const cost = estimateCost(
		duration,
		rendersStill,
		costMult,
		selectedBackend?.id,
		resolution,
	);

	// Bottom-bar trigger summary — "Seedance 2 · 1080p · 5s · 16:9" — the whole
	// generation recipe at a glance without opening the popover.
	const summary = useMemo(() => {
		const modelLabel = selectedBackend?.label ?? "Auto";
		const ratio =
			ORIENTATIONS.find((o) => o.value === orientation)?.ratio ?? orientation;
		const parts = [modelLabel, resolution, `${duration}s`, ratio];
		if (!isMultiframe && count > 1) parts.push(`×${count}`);
		return parts.join(" · ");
	}, [selectedBackend, resolution, duration, orientation, count, isMultiframe]);

	const helperText = needsReference
		? isMultiframe
			? "Add at least 2 keyframes to generate"
			: "Add a first frame to generate"
		: refUploading
			? "Uploading references…"
			: null;

	const submitLabel = mfBusy
		? "Generating segments…"
		: busy
			? "Generating…"
			: isMultiframe
				? `Generate ${Math.max(0, readyKeyframes.length - 1)} segments`
				: count > 1
					? `Generate ${count} takes`
					: "Generate";

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
		if (name.trim()) {
			toast.info(`Generating "${name.trim()}"…`);
		}

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
					// No user-facing seed control — always random. The provider
					// picks (or we pin one) server-side and persists it as
					// provenance; see /api/studio/generate's `effectiveSeed`.
					seed: undefined,
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
			// No user-facing seed control — always random per take. The provider
			// route pins (or generates) a concrete seed server-side regardless and
			// persists it on the take's spec + provenance, so reruns/debugging can
			// still read exactly what seed rendered a given take.
			seed: undefined,
			resolution,
			orientation,
			duration,
			// First-&-last is image-conditioned; Omni is text-driven (refs aside).
			mode: (activePersona || (!activePersona && genMode === "first-last")
				? "image-to-video"
				: "text-to-video") as VideoMode,
			personaId: activePersona?.id,
			consistencyMode: activePersona ? consistencyMode : undefined,
			generateAudio: supportsAudioToggle ? audioOn : undefined,
			// Manual model pin, only once the catalog has actually resolved a
			// choice — omitted while loading so the server's auto-route (today:
			// Seedance) is unaffected, matching the pre-bottom-bar behavior.
			model: selectedBackend?.id,
		};

		// Fire `count` variations at once. With no locked seed each picks its own
		// random seed server-side, so you get distinct takes.
		for (let i = 0; i < count; i++) onGenerate(params);
	}

	// ── Settings popover content — camera / duration / aspect / resolution /
	// audio only. Reference mode, persona consistency, and variation count all
	// live on the main surface now (see the return below) — this list is short
	// enough to always fit the popover without internal scrolling, even in the
	// tallest case (Seedance: model + camera + duration + aspect + resolution +
	// audio, all six sections).
	const settingsContent = (
		<>
			{backends.length > 1 && (
				<div className="space-y-1.5">
					<span className="text-xs font-medium text-muted-foreground">
						Model
					</span>
					<div className="flex flex-wrap gap-1.5">
						{backends.map((b) => (
							<button
								key={b.id}
								type="button"
								onClick={() => setBackendId(b.id)}
								title={`${b.vendor} · ${b.safetyTier}`}
								className={cn(
									"rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
									selectedBackend?.id === b.id
										? "border-transparent bg-foreground/15 text-foreground"
										: "border-border/50 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
								)}
							>
								{b.label}
							</button>
						))}
					</div>
				</div>
			)}

			<div className="space-y-1.5">
				<span className="text-xs font-medium text-muted-foreground">
					Camera motion
				</span>
				<CameraPresetPicker
					value={cameraPreset}
					onChange={(v) => setSettings({ cameraPreset: v })}
				/>
			</div>

			<ChipGrid
				label="Duration"
				options={durationOptions}
				value={duration}
				onChange={(v) => setSettings({ duration: v })}
				hint={isMultiframe ? "per clip" : undefined}
			/>

			<ChipGrid
				label="Aspect ratio"
				options={availableOrientations.map((o) => ({
					value: o.value,
					label: o.ratio,
					title: o.label,
				}))}
				value={orientation}
				onChange={(v) => setSettings({ orientation: v })}
			/>

			<ChipGrid
				label="Resolution"
				variant="solid"
				options={availableResolutions.map((r) => ({
					value: r.value,
					label: r.label,
					title: r.hint,
				}))}
				value={resolution}
				onChange={(v) => setSettings({ resolution: v })}
			/>

			{supportsAudioToggle && (
				<ChipGrid
					label="Audio"
					options={[
						{ value: "on", label: "On" },
						{ value: "off", label: "Off" },
					]}
					value={audioOn ? "on" : "off"}
					onChange={(v) => setAudioOn(v === "on")}
					hint="model-generated sound"
				/>
			)}
		</>
	);

	return (
		<div className={cn("flex flex-col gap-3", className)}>
			{/* Persona — when active, replaces mode selection below and drives
			    reference-conditioned character consistency. */}
			{activePersona && (
				<div className="flex items-center gap-2 rounded-lg border border-border/60 p-2">
					<img
						src={activePersona.anchorImageUrl}
						alt={activePersona.name}
						className="h-8 w-8 rounded object-cover shrink-0"
					/>
					<div className="min-w-0 flex-1">
						<p className="text-xs font-medium truncate">{activePersona.name}</p>
						<p className="text-[10px] text-muted-foreground">
							Same character every shot
						</p>
					</div>
					<button
						type="button"
						onClick={() => clearPersona(null)}
						className="text-[10px] text-muted-foreground underline shrink-0"
					>
						Clear
					</button>
				</div>
			)}

			{/* Mode selection — Palmier-style text tabs on the main surface (was
			    buried in the settings popover, which also clipped it — see
			    generation-bottom-bar.tsx). Persona active ⇒ Consistency tier takes
			    this slot instead, since persona replaces mode selection outright. */}
			{activePersona ? (
				<TextTabs
					options={CONSISTENCY_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						title: o.hint,
					}))}
					value={consistencyMode}
					onChange={(v) => setSettings({ consistencyMode: v })}
				/>
			) : (
				availableModes.length > 1 && (
					<TextTabs
						options={availableModes.map((m) => ({
							value: m.value,
							label: m.label,
							title: m.hint,
						}))}
						value={genMode}
						onChange={(v) => setSettings({ genMode: v })}
						testIdPrefix="video-gen-mode"
					/>
				)
			)}

			{/* References — Omni reference chips, First/Last frame slots, or the
			    multiframe keyframe row, whichever the active mode calls for. */}
			{showReferencesRow && (
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<span className="text-xs font-medium text-muted-foreground">
							References
						</span>
						<span className="text-[10px] text-muted-foreground">
							{isMultiframe
								? readyKeyframes.length >= 2
									? `${readyKeyframes.length - 1} clip${readyKeyframes.length - 1 === 1 ? "" : "s"}`
									: "add ≥ 2"
								: "optional · drag, drop, or @mention"}
						</span>
					</div>

					{showOmniRefs && (
						<ReferenceMediaUploader
							items={refMedia}
							onChange={setRefMedia}
							handles={handleMap}
							disabled={busy}
						/>
					)}

					{!activePersona && genMode === "first-last" && (
						<div className="flex gap-2">
							<FrameSlot
								label="First Frame"
								value={firstFrameUrl}
								onChange={setFirstFrameUrl}
								disabled={busy}
							/>
							<FrameSlot
								label="Last Frame · optional"
								value={lastFrameUrl}
								onChange={setLastFrameUrl}
								disabled={busy}
							/>
						</div>
					)}

					{isMultiframe && (
						<div className="flex flex-wrap gap-2">
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
												setKeyframes((prev) =>
													prev.filter((_, idx) => idx !== i),
												)
											}
											className="absolute -right-1.5 -top-1.5 z-10 flex size-5 items-center justify-center rounded-full border border-border/60 bg-background text-[11px] leading-none text-foreground shadow-sm"
											aria-label={`Remove frame ${i + 1}`}
										>
											×
										</button>
									)}
								</div>
							))}
							{keyframes.length < 10 && (
								<button
									type="button"
									onClick={() => setKeyframes((prev) => [...prev, null])}
									className="flex aspect-video w-[150px] shrink-0 flex-col items-center justify-center gap-1 self-end rounded-lg border border-dashed border-border/60 text-[10px] font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
								>
									+ Add keyframe
								</button>
							)}
						</div>
					)}

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

			{helperText && (
				<p className="text-[10px] text-amber-600 dark:text-amber-500">
					{helperText}
				</p>
			)}

			{/* One calm surface: Name, Prompt, Variations, and the bottom bar all
			    live inside a single hairline-divided card. */}
			<GenerationCard>
				<div className="px-3 py-2">
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Name (optional)"
						className="h-6 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
					/>
				</div>

				<div className="space-y-1.5 p-3">
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
							rows={4}
							className="resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 pr-9 min-h-24"
						/>
						<div className="absolute right-1.5 top-0">
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
													p +
													(p && !p.endsWith(" ") ? " " : "") +
													h.handle +
													" ",
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

				{/* Variations — moved out of the settings popover, a compact row
				    just above the bottom bar (multiframe's segment count is derived
				    from its keyframes, so it doesn't apply here). */}
				{!isMultiframe && (
					<div className="px-3 py-2">
						<ChipGrid
							label="Variations"
							options={[1, 2, 3, 4].map((n) => ({
								value: n,
								label: String(n),
							}))}
							value={count}
							onChange={setCount}
							hint={count === 1 ? "one take" : `${count} at once`}
						/>
					</div>
				)}

				<GenerationBottomBar
					summary={summary}
					settingsContent={settingsContent}
					cost={cost}
					onSubmit={handleGenerate}
					submitDisabled={
						!prompt.trim() || needsReference || refUploading || generating
					}
					busy={generating}
					submitLabel={submitLabel}
					testIdPrefix="video-gen"
				/>
			</GenerationCard>
		</div>
	);
}
