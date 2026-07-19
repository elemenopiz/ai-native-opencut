"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Cancel01Icon,
	SquareLock01Icon,
	BookOpen01Icon,
} from "@hugeicons/core-free-icons";
import {
	Popover,
	PopoverArrow,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
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
import { estimateGenerationSeconds } from "@/lib/studio/generation-eta";
import { useSession } from "@/lib/auth/client";
import { isOwnerEmail } from "@/lib/credits/signup-grant";
import { useSavedVerifiedAssets } from "@/lib/studio/saved-verified-assets";
import { useBackends } from "@/hooks/use-backends";
// Client-safe: registry.ts is pure data (a Map + type imports), no secret env.
import { DEFAULT_BACKEND_ID } from "@/lib/studio/backends/registry";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import { useFrameChainStore } from "@/stores/frame-chain-store";
import { useOmniReferenceChainStore } from "@/stores/omni-reference-chain-store";
import { usePersonaStore } from "@/stores/persona-store";
import { useBoardStore } from "@/stores/board-store";
import { useEditor } from "@/hooks/use-editor";
import {
	getStoredConsistencyContext,
	serializeConsistencyContext,
} from "@/lib/director/consistency-prompt";
import type { EditorCore } from "@/core";
import { EnhancePromptButton } from "@/components/editor/ai/enhance-prompt-button";
import {
	ChipGrid,
	GenerationBottomBar,
	GenerationCard,
	SegmentedControl,
	TextTabs,
} from "@/components/studio/generation-bottom-bar";
import { toast } from "sonner";

/**
 * Two-step read mirroring exactly what the generate/rerun fold paths read:
 * the live session `ConsistencyContext` (WeakMap, set by the Director this
 * session) if present, else the persisted bible's `consistencyContext`
 * (`hydrateDirectorStateFromBible` restores ONLY this field into the WeakMap
 * on mount — a bible carrying just a `styleBible` never folds, so it must
 * never show the chip). Returns `null` when neither carries anything.
 */
function getStyleBiblePreview(editor: EditorCore): string | null {
	const context =
		getStoredConsistencyContext(editor) ??
		editor.project.getProjectBible()?.consistencyContext;
	if (!context) return null;
	const text = serializeConsistencyContext(context).trim();
	return text || null;
}

/** Abbreviate a persona's locked seed for the compact inline badge — the
 *  popover-free indicator only needs to signal "there's a number, it's
 *  fixed," not the full value. */
function abbreviateSeed(seed: number): string {
	const s = String(seed);
	return s.length > 6 ? `${s.slice(0, 6)}…` : s;
}

/** Muted "Style bible" chip — appears wherever a reel-level consistency
 *  context (session or persisted) exists, independent of persona state.
 *  Popover previews the folded text read-only; no editing surface here.
 *  Currently unmounted (UI-only removal, 2026-07-19) — the render call sat
 *  right below `styleBiblePreview` in the JSX; re-add `{styleBiblePreview &&
 *  <StyleBibleChip text={styleBiblePreview} />}` there to bring it back. */
// biome-ignore lint/correctness/noUnusedVariables: kept intentionally for the Style Bible chip re-mount, see doc comment above.
function StyleBibleChip({ text }: { text: string }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-testid="consistency-style-bible-chip"
					title="Style bible — folded into every generation in this project"
					className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground/[0.06] px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.09] hover:text-foreground"
				>
					<HugeiconsIcon icon={BookOpen01Icon} className="size-[11px]" />
					Style bible
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				sideOffset={8}
				collisionPadding={12}
				className="w-72 space-y-2 rounded-[16px] border-foreground/[0.12] bg-popover/95 p-3.5 shadow-xl backdrop-blur-xl"
			>
				<p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">
					Style bible
				</p>
				<pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground/80">
					{text}
				</pre>
				<p className="text-[11px] text-muted-foreground">
					Folded into every generation in this project.
				</p>
				<PopoverArrow />
			</PopoverContent>
		</Popover>
	);
}

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
		batchSize: number;
	}) => Promise<void>;
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
		label: "First–Last",
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

function clamp(n: number, min: number, max: number) {
	return Math.min(max, Math.max(min, n));
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
	// Silent-render toggle — only meaningful for backends that can actually turn
	// generated audio off (see `supportsAudioToggle`). Defaults to on (provider
	// default) so backends without the capability are never silently muted.
	const [audioOn, setAudioOn] = useState(true);
	// Omni references (images + videos) — drag from Assets, drop, or browse.
	const [refMedia, setRefMedia] = useState<ReferenceMediaItem[]>([]);
	const refUploading = refMedia.some((r) => r.status === "uploading");
	// Verified real-human assets (BytePlus `asset://`) are owner-only: every
	// asset lives under the single BYTEPLUS_API_KEY account, so a picker shown
	// to other users would expose the owner's likeness. Gated to OWNER_EMAILS.
	const { data: session } = useSession();
	const isOwner = isOwnerEmail(session?.user?.email);
	const savedVerifiedAssets = useSavedVerifiedAssets();
	// First & last frame mode.
	const [firstFrameUrl, setFirstFrameUrl] = useState<string | null>(null);
	const [lastFrameUrl, setLastFrameUrl] = useState<string | null>(null);
	// Multiframe mode — an ordered list of keyframe slots (2–10).
	const [keyframes, setKeyframes] = useState<(string | null)[]>([null, null]);
	const [mfBusy, setMfBusy] = useState(false);
	// How many variations to generate at once (omni / first-last only).
	const [count, setCount] = useState(1);
	// "Match @VideoN" duration pin — see the Duration section of settingsContent.
	const [matchRef, setMatchRef] = useState(false);

	// Mirrors the generate route's seed-lock rule exactly: a persona with a
	// stored non-null seed rides seed-locked ONLY for a single-shot generation
	// (count 1) with no explicit seed override — a batch of unlocked drafts
	// still wants distinct seeds per take, so the lock never applies there.
	const seedLocked =
		!!activePersona && activePersona.seed != null && count === 1;

	// Reel-level style bible — session consistency context if the Director set
	// one this session, else the project's persisted look. Read fresh every
	// render (editor is a stable singleton so a memo keyed on it would never
	// re-run when the underlying project/session state changes).
	const editor = useEditor();
	// Preview-only value for the (currently unmounted) StyleBibleChip — kept
	// live intentionally so re-adding the chip render is the only step needed
	// to bring the UI back; see StyleBibleChip's doc comment above.
	// biome-ignore lint/correctness/noUnusedVariables: kept intentionally for the Style Bible chip re-mount.
	const styleBiblePreview = getStyleBiblePreview(editor);

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

	// The first ready omni video reference with a known duration — powers the
	// "Match @VideoN · {n}s" duration chip. Order matches referenceHandles, so
	// its handle is always correct even once earlier videos are removed.
	const omniVideoWithDuration = useMemo(() => {
		if (!showOmniRefs) return null;
		for (const r of refMedia) {
			if (r.status === "ready" && r.kind === "video" && r.durationSec) {
				const handle = referenceHandles.find((h) => h.id === r.id)?.handle;
				if (handle) return { id: r.id, handle, durationSec: r.durationSec };
			}
		}
		return null;
	}, [refMedia, referenceHandles, showOmniRefs]);

	const matchedDurationSec = omniVideoWithDuration
		? Math.round(
				clamp(
					omniVideoWithDuration.durationSec,
					durationRange.min,
					durationRange.max,
				),
			)
		: null;

	// Keep the pinned duration in lockstep with the matched reference: re-clamp
	// on backend/range change, and deselect automatically if the reference is
	// removed (or stops being the omni video with a known duration).
	// biome-ignore lint/correctness/useExhaustiveDependencies: setSettings is a stable zustand action
	useEffect(() => {
		if (!matchRef) return;
		if (!omniVideoWithDuration || matchedDurationSec === null) {
			setMatchRef(false);
			return;
		}
		setSettings({ duration: matchedDurationSec });
	}, [matchRef, omniVideoWithDuration, matchedDurationSec]);

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

	// Insert a handle straight from its on-thumb tag (ReferenceMediaUploader's
	// `onHandleClick`) — the below-prompt helper paragraph this used to live in
	// is gone; the thumb tag is now the only click-to-insert affordance.
	function insertHandleFromThumb(id: string) {
		const handle = handleMap[id];
		if (!handle) return;
		setPrompt((p) => p + (p && !p.endsWith(" ") ? " " : "") + handle + " ");
		requestAnimationFrame(() => promptRef.current?.focus());
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

	// Bottom-bar trigger — bright model name + a muted settings recap, e.g.
	// "Seedance 2" · "1080p · 5s · 16:9" — the whole generation recipe at a
	// glance without opening the popover.
	const modelLabel = selectedBackend?.label ?? "Auto";
	const settingsSummary = useMemo(() => {
		const ratio =
			ORIENTATIONS.find((o) => o.value === orientation)?.ratio ?? orientation;
		const parts = [resolution, `${duration}s`, ratio];
		if (!isMultiframe && count > 1) parts.push(`×${count}`);
		return parts.join(" · ");
	}, [resolution, duration, orientation, count, isMultiframe]);

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

	const promptPlaceholder = isMultiframe
		? "Describe how the keyframes connect…"
		: !activePersona && genMode === "first-last"
			? "Describe the motion between your two frames…"
			: "Describe your shot…  Type @ to reference attached media.";

	// ── Progress strip (Generating… · pct% · ~Ns left) ───────────────────────
	// Aggregate-only: useStudioGeneration exposes a single submitting/polling
	// status, not per-take completion, so the strip paces one shared ETA for
	// the whole batch rather than tracking individual takes.
	const [progress, setProgress] = useState(0);
	const [remainingSec, setRemainingSec] = useState(0);
	const [showProgress, setShowProgress] = useState(false);
	const [progressFadingOut, setProgressFadingOut] = useState(false);
	// Snapshot of the settings a run would use, refreshed every render so the
	// progress effect can read "what was selected right when generation
	// started" without needing them as effect dependencies.
	const genParamsRef = useRef({
		backendId: selectedBackend?.id,
		resolution,
		duration,
	});
	genParamsRef.current = {
		backendId: selectedBackend?.id,
		resolution,
		duration,
	};

	useEffect(() => {
		if (generating) {
			setShowProgress(true);
			setProgressFadingOut(false);
			setProgress(0);
			const eta = estimateGenerationSeconds(genParamsRef.current);
			const start = Date.now();
			const tick = () => {
				const elapsed = (Date.now() - start) / 1000;
				setProgress(Math.min(0.92, (elapsed / eta) * 0.9));
				setRemainingSec(Math.max(0, Math.round(eta - elapsed)));
			};
			tick();
			const id = setInterval(tick, 250);
			return () => clearInterval(id);
		}
		// Busy just flipped false — snap to 100%, hold briefly, then fade out.
		setProgress(1);
		setRemainingSec(0);
		const fadeTimer = setTimeout(() => setProgressFadingOut(true), 600);
		const hideTimer = setTimeout(() => setShowProgress(false), 900);
		return () => {
			clearTimeout(fadeTimer);
			clearTimeout(hideTimer);
		};
	}, [generating]);

	const activeTakeCount = isMultiframe
		? Math.max(0, readyKeyframes.length - 1)
		: count;

	function openBoard() {
		useBoardStore.getState().setOpen(true);
	}

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
		// random seed server-side, so you get distinct takes. `batchSize` rides
		// along on every request so the hook can auto-route the result: straight
		// to Assets for a lone take, held in Board for a batch to pick from.
		const batchSize = count;
		const results = await Promise.allSettled(
			Array.from({ length: batchSize }, () =>
				onGenerate({ ...params, batchSize }),
			),
		);
		const succeeded = results.filter((r) => r.status === "fulfilled").length;
		if (succeeded === 0) return;
		if (batchSize === 1) {
			toast.success("Added to Assets.");
		} else {
			toast.success(
				`${succeeded} take${succeeded === 1 ? "" : "s"} ready — pick your favorite`,
				{
					action: {
						label: "Open Board",
						onClick: () => useBoardStore.getState().setOpen(true),
					},
				},
			);
		}
	}

	// ── Settings popover content — model / duration / aspect / resolution /
	// audio. Camera now lives on the composer's tool row (see the return
	// below); reference mode, persona consistency, and variation count all
	// live on the main surface too.
	const settingsContent = (
		<>
			{backends.length > 1 && (
				<ChipGrid
					label="Model"
					options={backends.map((b) => ({
						value: b.id,
						label: b.label,
						title: `${b.vendor} · ${b.safetyTier}`,
					}))}
					value={selectedBackend?.id ?? ""}
					onChange={(v) => setBackendId(v)}
				/>
			)}

			<div className="space-y-1.5">
				<ChipGrid
					label="Duration"
					columns={5}
					options={durationOptions}
					value={duration}
					onChange={(v) => {
						setMatchRef(false);
						setSettings({ duration: v });
					}}
					hint={isMultiframe ? "per clip" : undefined}
				/>
				{omniVideoWithDuration && matchedDurationSec !== null && (
					<button
						type="button"
						onClick={() => setMatchRef((m) => !m)}
						className={cn(
							"flex h-[30px] w-full items-center justify-center rounded-[10px] px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
							matchRef
								? "bg-foreground/[0.16] font-semibold text-foreground"
								: "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
						)}
					>
						Match {omniVideoWithDuration.handle} · {matchedDurationSec}s
					</button>
				)}
			</div>

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

			<div className="space-y-1.5">
				<span className="text-[13px] font-semibold text-foreground/70">
					Resolution
				</span>
				<SegmentedControl
					options={availableResolutions.map((r) => ({
						value: r.value,
						label: r.label,
						title: r.hint,
					}))}
					value={resolution}
					onChange={(v) => setSettings({ resolution: v })}
				/>
			</div>

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
			{/* Consistency strip — passive status only (no picker UI): when a
			    persona is active (set programmatically, e.g. by the Director),
			    shows it with a seed-lock badge mirroring the generate route's
			    exact condition and a way to clear it. Renders nothing in the
			    no-persona case — there's no in-form entry point to pick one
			    anymore. (The reel-level consistency-context preview chip that
			    used to live here — styleBiblePreview/StyleBibleChip below — is
			    intentionally unmounted too; the data flow that feeds it stays
			    live so it can be re-shown later.) */}
			{activePersona && (
				<div className="flex flex-wrap items-center gap-2">
					{/* Persona — when active, replaces mode selection below and drives
					    reference-conditioned character consistency. Restyled to a quiet
					    row: no border, a ✕ chip instead of an underlined "Clear" link. */}
					<div
						data-testid="consistency-persona-chip"
						className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-foreground/[0.04] p-2"
					>
						<img
							src={activePersona.anchorImageUrl}
							alt={activePersona.name}
							className="h-8 w-8 shrink-0 rounded object-cover"
						/>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<p className="truncate text-[13px] font-semibold">
									{activePersona.name}
								</p>
								{seedLocked && (
									<span
										data-testid="consistency-seed-lock"
										title="Takes reuse this persona's locked seed — identity holds across generations"
										className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.08] px-1.5 py-[1px] text-[10.5px] font-medium tabular-nums text-foreground/70"
									>
										<HugeiconsIcon
											icon={SquareLock01Icon}
											className="size-[9px]"
										/>
										{abbreviateSeed(activePersona.seed as number)}
									</span>
								)}
							</div>
							<p className="text-[11.5px] text-muted-foreground">
								{seedLocked
									? "Same character, same seed every shot"
									: "Same character every shot"}
							</p>
						</div>
						<button
							type="button"
							onClick={() => clearPersona(null)}
							aria-label="Clear persona"
							className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-muted-foreground transition-colors hover:bg-foreground/[0.14] hover:text-foreground"
						>
							<HugeiconsIcon icon={Cancel01Icon} className="size-[11px]" />
						</button>
					</div>
				</div>
			)}

			{/* Mode selection — Palmier-style text tabs on the main surface.
			    Persona active ⇒ Consistency tier takes this slot instead, since
			    persona replaces mode selection outright. */}
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

			{/* References — Omni reference thumbs, First–Last frame slots, or the
			    multiframe keyframe grid, whichever the active mode calls for. */}
			{showReferencesRow && (
				<div className="space-y-1.5">
					{showOmniRefs && (
						<>
							<div className="flex items-center justify-between">
								<span className="text-[13px] font-semibold text-foreground/70">
									References
								</span>
								<span className="text-[11.5px] text-muted-foreground">
									type @ to reference
								</span>
							</div>
							<ReferenceMediaUploader
								items={refMedia}
								onChange={setRefMedia}
								handles={handleMap}
								disabled={busy}
								onHandleClick={insertHandleFromThumb}
								allowVerifiedAsset={supportsOmniRef && isOwner}
								savedAssets={savedVerifiedAssets.assets}
								onSaveAsset={savedVerifiedAssets.add}
								onRemoveSavedAsset={savedVerifiedAssets.remove}
							/>
						</>
					)}

					{!activePersona && genMode === "first-last" && (
						<>
							<div className="flex gap-2">
								<span className="w-[150px] shrink-0 text-[13px] font-semibold text-foreground/70">
									First Frame
								</span>
								<span className="w-[150px] shrink-0 text-[13px] font-semibold text-foreground/70">
									Last Frame{" "}
									<span className="font-normal text-muted-foreground">
										· optional
									</span>
								</span>
							</div>
							<div className="flex gap-2">
								<FrameSlot
									label="First Frame"
									hideLabel
									value={firstFrameUrl}
									onChange={setFirstFrameUrl}
									disabled={busy}
								/>
								<FrameSlot
									label="Last Frame"
									hideLabel
									value={lastFrameUrl}
									onChange={setLastFrameUrl}
									disabled={busy}
								/>
							</div>
						</>
					)}

					{isMultiframe && (
						<>
							<div className="flex items-center justify-between">
								<span className="text-[13px] font-semibold text-foreground/70">
									Keyframes
								</span>
								<span className="text-[11.5px] text-muted-foreground">
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
											fixedWidth={false}
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
												className="absolute right-1.5 top-[26px] z-10 flex size-[18px] items-center justify-center rounded-full bg-black/70 text-white/80"
												aria-label={`Remove frame ${i + 1}`}
											>
												<HugeiconsIcon
													icon={Cancel01Icon}
													className="size-[11px]"
												/>
											</button>
										)}
									</div>
								))}
								{keyframes.length < 10 && (
									<button
										type="button"
										onClick={() => setKeyframes((prev) => [...prev, null])}
										className="flex aspect-[16/10] flex-col items-center justify-center gap-1 self-end rounded-xl border-[1.5px] border-dashed border-foreground/[0.18] text-[11.5px] text-muted-foreground transition-colors hover:border-foreground/30"
									>
										+ Add keyframe
									</button>
								)}
							</div>
						</>
					)}

					{firstFrameUrl &&
						!availableModes.some((m) => m.value === "first-last") && (
							<p className="text-[11.5px] text-muted-foreground">
								A first frame is attached, but{" "}
								{selectedBackend?.label ?? "this model"} doesn&apos;t support a
								first-frame seed — pick a First–Last-capable model to use it.
							</p>
						)}
				</div>
			)}

			{helperText && (
				<p className="text-[11.5px] text-muted-foreground">{helperText}</p>
			)}

			{/* One calm surface: Prompt, tool row, Variations, the progress strip,
			    and the bottom bar all live inside a single hairline-divided card. */}
			<GenerationCard>
				{/* Prompt + its tool row share one section (no hairline between them)
				    so Camera/Enhance read as part of the composer, not a separate
				    boxed area. */}
				<div className="px-4 pb-3 pt-4">
					<div className="relative pb-1">
						<Textarea
							ref={promptRef}
							placeholder={promptPlaceholder}
							value={prompt}
							onChange={(e) => {
								setPrompt(e.target.value);
								refreshMention(e.target);
							}}
							onClick={(e) => refreshMention(e.currentTarget)}
							onKeyUp={(e) => refreshMention(e.currentTarget)}
							onKeyDown={handlePromptKeyDown}
							onBlur={() => setMention(null)}
							className="min-h-28 resize-none border-0 bg-transparent p-0 text-[14.5px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
						/>

						{mention && mentionMatches.length > 0 && (
							<div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-foreground/[0.12] bg-popover shadow-lg">
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
											"flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12.5px]",
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
										<span className="font-medium">{h.handle}</span>
										<span className="truncate text-[11.5px] text-muted-foreground">
											{h.name}
										</span>
									</button>
								))}
							</div>
						)}
					</div>

					{/* Tool row — camera motion (opens its own popover) + Enhance. */}
					<div className="flex items-center gap-2 pt-1">
						<CameraPresetPicker
							value={cameraPreset}
							onChange={(v) => setSettings({ cameraPreset: v })}
						/>
						<EnhancePromptButton
							mode="video"
							getPrompt={() => prompt}
							setPrompt={setPrompt}
							className="ml-auto"
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
				</div>

				{/* Variations — multiframe's segment count is derived from its
				    keyframes, so it doesn't apply here. */}
				{!isMultiframe && (
					<div className="flex items-center gap-2 px-4 py-2">
						<span className="text-[13px] font-semibold text-foreground/70">
							Variations
						</span>
						<div className="ml-auto flex gap-1.5">
							{[1, 2, 3, 4].map((n) => {
								const active = count === n;
								return (
									<button
										key={n}
										type="button"
										onClick={() => setCount(n)}
										className={cn(
											"flex size-7 items-center justify-center rounded-[9px] text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
											active
												? "bg-foreground/[0.16] font-semibold text-foreground"
												: "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
										)}
									>
										{n}
									</button>
								);
							})}
						</div>
					</div>
				)}

				{showProgress && (
					<div
						className={cn(
							"space-y-1.5 px-4 pb-3 pt-2 transition-opacity duration-300",
							progressFadingOut ? "opacity-0" : "opacity-100",
						)}
					>
						<div className="h-[3px] w-full overflow-hidden rounded-full bg-foreground/[0.12]">
							<div
								className="h-full rounded-full bg-zinc-900 transition-[width] duration-300 ease-linear dark:bg-[#f2efe9]"
								style={{ width: `${Math.round(progress * 100)}%` }}
							/>
						</div>
						<div className="flex items-center justify-between text-[11.5px] tabular-nums text-muted-foreground">
							<span>
								Generating
								{activeTakeCount > 1
									? ` ${activeTakeCount} ${isMultiframe ? "segments" : "takes"}`
									: ""}{" "}
								· {Math.round(progress * 100)}% · ~{remainingSec}s left
							</span>
							<button
								type="button"
								onClick={openBoard}
								className="font-semibold text-foreground/80 transition-colors hover:text-foreground"
							>
								Open Board →
							</button>
						</div>
					</div>
				)}

				<GenerationBottomBar
					modelLabel={modelLabel}
					settingsSummary={settingsSummary}
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
