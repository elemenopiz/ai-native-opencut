"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { useBackends } from "@/hooks/use-backends";
import { estimateAudioCredits } from "@/lib/credits/estimate";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import { uploadReferenceFile } from "@/lib/studio/reference-upload";
import {
	ReferenceMediaUploader,
	type ReferenceMediaItem,
} from "@/components/studio/reference-media-uploader";
import {
	ChipGrid,
	GenerationBottomBar,
} from "@/components/studio/generation-bottom-bar";
import { gateOn402 } from "@/lib/credits/client-gate";
import { useCreditsStore } from "@/stores/credits-store";
import { apiFetch } from "@/lib/auth/unauthorized";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import type { VideoElement } from "@/types/timeline";

/** Score's real-world ceiling (MMAudio V2 via fal.ai) — matches
 *  `MMAUDIO_MAX_DURATION_SEC` in `lib/studio/backends/audio/fal-mmaudio.ts`.
 *  Duplicated as a literal (not imported) because that module is server-only
 *  (reads `webEnv`), and this is a client component. */
const SCORE_MAX_DURATION_SEC = 30;
const SCORE_DURATION_OPTIONS = [4, 8, 15, 20, 30];
const MUSIC_DURATION_OPTIONS = [15, 30, 60, 120];

type AudioMode = "score" | "music" | "voiceover";

interface CapturedSource {
	trackId: string;
	elementId: string;
	startTime: number;
	duration: number;
}

/**
 * Audio tab of the Generate panel — "score" (video-to-audio via MMAudio V2)
 * and "music" (text-to-music via ElevenLabs Music), following the same
 * Palmier-pattern bottom bar as Video/Image. Voiceover has its own full
 * pipeline (language/translation/segments) in the Assets panel's Audio tab —
 * this surface links to it rather than re-implementing it.
 */
export function AudioPanel({ className }: { className?: string }) {
	const editor = useEditor();
	const [mode, setMode] = useState<AudioMode>("score");

	return (
		<div className={cn("flex flex-col gap-3", className)}>
			<div className="flex gap-2">
				{(
					[
						{ id: "score", label: "Score" },
						{ id: "music", label: "Music" },
						{ id: "voiceover", label: "Voiceover" },
					] as const
				).map((m) => (
					<button
						key={m.id}
						type="button"
						onClick={() => setMode(m.id)}
						className={cn(
							"flex-1 px-2 py-1.5 rounded-md text-xs font-medium border transition-colors",
							mode === m.id
								? "bg-primary text-primary-foreground border-primary"
								: "border-border text-muted-foreground hover:border-foreground",
						)}
					>
						{m.label}
					</button>
				))}
			</div>

			{mode === "score" && <ScoreMode editor={editor} />}
			{mode === "music" && <MusicMode editor={editor} />}
			{mode === "voiceover" && <VoiceoverRedirect />}
		</div>
	);
}

// ─── Score (video-to-audio) ───────────────────────────────────────────────

function ScoreMode({ editor }: { editor: ReturnType<typeof useEditor> }) {
	const { backends } = useBackends("audio");
	const scoreBackend = useMemo(
		() => backends.find((b) => b.id === "fal-mmaudio"),
		[backends],
	);
	const maxDuration =
		scoreBackend?.durationRangeSec?.max ?? SCORE_MAX_DURATION_SEC;

	const [refMedia, setRefMedia] = useState<ReferenceMediaItem[]>([]);
	const [prompt, setPrompt] = useState("");
	const [duration, setDuration] = useState(8);
	const [busy, setBusy] = useState(false);
	const [capturedSource, setCapturedSource] = useState<CapturedSource | null>(
		null,
	);
	const [lastResult, setLastResult] = useState<{
		mediaIds: string[];
		url: string;
	} | null>(null);

	// Cancels the in-flight generation (poll loop + eventual Assets insert)
	// started by `handleGenerate`. Set while a generation is running, cleared
	// once it settles. Invoked from the unmount effect below and from
	// `editor.project.subscribe` the moment the active project stops matching
	// the one that started the generation — the poll can run for up to ~2
	// minutes, and EditorCore is a reused singleton across client-side project
	// switches, so this component does NOT reliably unmount just because the
	// user navigated to a different project.
	const cancelGenerationRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		return () => cancelGenerationRef.current?.();
	}, []);

	// Only the most recently attached video counts as the source — MMAudio
	// takes exactly one. Keeps the familiar reference-uploader idiom (drag
	// from Assets, drop, or browse) while behaving like a single-video slot.
	const source = [...refMedia].reverse().find((r) => r.kind === "video");
	const handleRefChange = (next: ReferenceMediaItem[]) => {
		const videos = next.filter((r) => r.kind === "video");
		if (videos.length <= 1) {
			setRefMedia(next);
			return;
		}
		// Keep only the newest video (plus anything still uploading).
		const newestVideo = videos[videos.length - 1];
		setRefMedia(
			next.filter((r) => r.kind !== "video" || r.id === newestVideo.id),
		);
	};

	// Default to the selected timeline clip's video, once, when Score mode
	// first mounts with a clip already selected and no source attached yet.
	const defaultAppliedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only one-shot (defaultAppliedRef guards re-entry)
	useEffect(() => {
		if (defaultAppliedRef.current || refMedia.length > 0) return;
		defaultAppliedRef.current = true;

		const selected = editor.selection.getSelectedElements();
		if (selected.length !== 1) return;
		const { trackId, elementId } = selected[0];
		const track = editor.timeline
			.getTracks()
			.find((t) => t.id === trackId && t.type === "video");
		if (!track) return;
		const el = track.elements.find(
			(e): e is VideoElement => e.id === elementId && e.type === "video",
		);
		if (!el) return;
		const asset = editor.media.getAssets().find((a) => a.id === el.mediaId);
		if (!asset?.file) return;

		const localId = crypto.randomUUID();
		setRefMedia([
			{
				id: localId,
				url: asset.url ?? "",
				kind: "video",
				name: asset.name,
				status: "uploading",
			},
		]);
		setCapturedSource({
			trackId,
			elementId,
			startTime: el.startTime,
			duration: el.duration,
		});

		void uploadReferenceFile(asset.file)
			.then(({ url }) => {
				setRefMedia((prev) =>
					prev.map((r) =>
						r.id === localId ? { ...r, url, status: "ready" } : r,
					),
				);
			})
			.catch((err) => {
				setRefMedia((prev) =>
					prev.map((r) =>
						r.id === localId
							? {
									...r,
									status: "error",
									error: err instanceof Error ? err.message : "Upload failed",
								}
							: r,
					),
				);
			});
	}, []);

	const cost = estimateAudioCredits(duration, "fal-mmaudio");
	const summary = useMemo(() => {
		const parts = ["MMAudio V2", `${duration}s`];
		return parts.join(" · ");
	}, [duration]);

	async function handleGenerate() {
		if (!source || source.status !== "ready") return;
		setBusy(true);
		setLastResult(null);

		// Capture the originating project ONCE, up front — never re-read
		// `editor.project.getActive()` after the poll resolves. The poll can run
		// for up to ~2 minutes; re-reading "active" at that point silently
		// attaches the result to whichever project the user happens to be in
		// when it resolves, not the project that paid for and started the job.
		let originProjectId: string | null = null;
		try {
			originProjectId = editor.project.getActive().metadata.id;
		} catch {
			originProjectId = null;
		}

		// Cancellation: flips once the active project stops matching
		// `originProjectId` (the user switched projects) or the panel unmounts.
		// The AbortController stops the poll loop's network requests outright
		// instead of letting it spin for up to 2 minutes against a project the
		// user already left; `cancelled` additionally gates the post-poll
		// Assets insert in case a switch lands in the gap between the poll's
		// last tick and the insert.
		const controller = new AbortController();
		let cancelled = false;
		const cancel = () => {
			if (cancelled) return;
			cancelled = true;
			controller.abort();
		};
		cancelGenerationRef.current = cancel;
		const unsubscribeProject = editor.project.subscribe(() => {
			const activeId = editor.project.getActiveOrNull()?.metadata.id ?? null;
			if (activeId !== originProjectId) cancel();
		});

		try {
			const res = await apiFetch("/api/studio/audio", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "score",
					prompt: prompt.trim() || "Ambient sound matching the scene",
					videoUrl: source.url,
					duration,
				}),
				signal: controller.signal,
			});
			if (!res.ok) {
				if (await gateOn402(res)) return;
				const data = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(data.error ?? "Score generation failed");
			}
			const data = (await res.json()) as {
				jobId: string;
				status: string;
				resultUrl: string | null;
			};

			let resultUrl = data.resultUrl;
			if (data.status !== "completed") {
				const outcome = await pollAudioJob(data.jobId, {
					signal: controller.signal,
				});
				if (outcome.status === "cancelled") return;
				if (outcome.status !== "completed" || !outcome.resultUrl) {
					throw new Error(outcome.error ?? "Score generation failed");
				}
				resultUrl = outcome.resultUrl;
			}
			if (!resultUrl) throw new Error("No result returned");

			void useCreditsStore.getState().refresh();

			// The project changed while this job was in flight — the credits were
			// already spent (settled server-side), but landing the clip in
			// whichever project is now open would silently attach it to the wrong
			// project (MediaManager's asset list is a reused-singleton in-memory
			// list, not keyed live off `projectId`). Skip the insert; the user can
			// regenerate from the project they actually meant.
			if (cancelled) {
				toast.info(
					"Score finished, but you've switched projects — it wasn't added. Regenerate it from that project if you still want it.",
				);
				return;
			}

			// MMAudio returns the source video re-muxed with the new track — land
			// it in Assets as a video (see docs/audio-generation.md).
			if (originProjectId) {
				const { added, mediaIds } = await addItemsToProjectMedia({
					editor,
					projectId: originProjectId,
					source: "ai",
					items: [
						{
							url: resultUrl,
							name: (prompt.trim() || "Scored video").slice(0, 48),
							kind: "video",
						},
					],
				});
				if (added > 0) {
					toast.success("Scored video added to Assets.");
					setLastResult({ mediaIds, url: resultUrl });
				}
			}
		} catch (err) {
			if (controller.signal.aborted) return;
			toast.error(
				err instanceof Error ? err.message : "Score generation failed",
			);
		} finally {
			unsubscribeProject();
			if (cancelGenerationRef.current === cancel) {
				cancelGenerationRef.current = null;
			}
			setBusy(false);
		}
	}

	function placeOnTimeline() {
		if (!lastResult?.mediaIds[0] || !capturedSource) return;

		// Re-validate the captured span against the CURRENT timeline — nothing
		// blocks editing while generation is in flight, so the track/element the
		// user had selected minutes ago may have been trimmed, moved, or deleted
		// by now. Inserting at a stale position could land on a track that holds
		// different content, or one that no longer exists.
		const [hit] = editor.timeline.getElementsWithTracks({
			elements: [
				{
					trackId: capturedSource.trackId,
					elementId: capturedSource.elementId,
				},
			],
		});
		const stillValid =
			hit &&
			hit.element.startTime === capturedSource.startTime &&
			hit.element.duration === capturedSource.duration;

		if (!stillValid) {
			toast.error(
				"That clip's spot on the timeline changed since generation started — the scored video is still in Assets, so drag it in manually.",
			);
			setCapturedSource(null);
			return;
		}

		const element = buildElementFromMedia({
			mediaId: lastResult.mediaIds[0],
			mediaType: "video",
			name: "Scored video",
			duration: capturedSource.duration,
			startTime: capturedSource.startTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "explicit", trackId: capturedSource.trackId },
		});
		toast.success("Placed on the timeline at that span.");
	}

	const settingsContent = (
		<ChipGrid
			label="Duration"
			options={SCORE_DURATION_OPTIONS.filter((d) => d <= maxDuration).map(
				(d) => ({ value: d, label: `${d}s` }),
			)}
			value={duration}
			onChange={setDuration}
			hint={`up to ${maxDuration}s`}
		/>
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<Label className="text-xs">Source video</Label>
					<span className="text-[10px] text-muted-foreground">
						required · drag, drop, or browse
					</span>
				</div>
				<ReferenceMediaUploader
					items={refMedia}
					onChange={handleRefChange}
					disabled={busy}
				/>
			</div>

			<div className="space-y-1.5">
				<Label className="text-xs">Prompt · optional</Label>
				<Textarea
					placeholder="Describe the ambience or sound design (leave blank to let the model match the scene)…"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					rows={3}
					className="resize-none text-sm"
				/>
			</div>

			{!source && (
				<p className="text-[10px] text-amber-600 dark:text-amber-500">
					Attach a source video to generate.
				</p>
			)}

			<GenerationBottomBar
				summary={summary}
				settingsContent={settingsContent}
				cost={cost}
				onSubmit={handleGenerate}
				submitDisabled={!source || source.status !== "ready" || busy}
				busy={busy}
				submitLabel="Generate score"
				testIdPrefix="audio-gen"
			/>

			{lastResult && capturedSource && (
				<button
					type="button"
					onClick={placeOnTimeline}
					className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-left text-xs font-medium text-primary hover:bg-primary/10"
				>
					Place on timeline at that span
				</button>
			)}
		</div>
	);
}

/** Aborts early via rejection when `signal` fires, instead of always waiting
 *  out the full `ms` — lets {@link pollAudioJob} stop between ticks the
 *  moment its caller cancels, rather than up to one `intervalMs` late. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

/** Poll `/api/studio/audio/[jobId]` (MMAudio's async fal.ai queue) to a
 *  terminal state. Bounded — never spins forever on a stuck job. Also stops
 *  immediately (no further network requests) once `signal` aborts — e.g. the
 *  caller switched projects or unmounted, so the up-to-40×3s worth of polling
 *  would otherwise keep hitting the network for a job nobody's waiting on. */
async function pollAudioJob(
	jobId: string,
	{
		maxAttempts = 40,
		intervalMs = 3000,
		signal,
	}: { maxAttempts?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{
	status: "completed" | "failed" | "cancelled";
	resultUrl?: string;
	error?: string;
}> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			await abortableSleep(intervalMs, signal);
		} catch {
			return { status: "cancelled" };
		}
		try {
			const res = await apiFetch(`/api/studio/audio/${jobId}`, { signal });
			const data = (await res.json()) as {
				status: string;
				resultUrl?: string | null;
				error?: string;
			};
			if (data.status === "completed") {
				return { status: "completed", resultUrl: data.resultUrl ?? undefined };
			}
			if (data.status === "failed") {
				return { status: "failed", error: data.error ?? "Generation failed" };
			}
		} catch {
			if (signal?.aborted) return { status: "cancelled" };
			// Transient poll error — keep trying until maxAttempts.
		}
	}
	return { status: "failed", error: "Generation timed out" };
}

// ─── Music (text-to-music) ────────────────────────────────────────────────

function MusicMode({ editor }: { editor: ReturnType<typeof useEditor> }) {
	const [prompt, setPrompt] = useState("");
	const [instrumental, setInstrumental] = useState(false);
	const [lyrics, setLyrics] = useState("");
	const [showLyrics, setShowLyrics] = useState(false);
	const [duration, setDuration] = useState(30);
	const [busy, setBusy] = useState(false);
	const [resultUrl, setResultUrl] = useState<string | null>(null);

	const cost = estimateAudioCredits(duration, "elevenlabs-music");
	const summary = useMemo(
		() =>
			`ElevenLabs Music · ${duration}s${instrumental ? " · instrumental" : ""}`,
		[duration, instrumental],
	);

	async function handleGenerate() {
		if (!prompt.trim()) return;
		setBusy(true);
		setResultUrl(null);
		try {
			const res = await apiFetch("/api/studio/audio", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "music",
					prompt: prompt.trim(),
					duration,
					instrumental,
					lyrics: !instrumental && lyrics.trim() ? lyrics.trim() : undefined,
				}),
			});
			if (!res.ok) {
				if (await gateOn402(res)) return;
				const data = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(data.error ?? "Music generation failed");
			}
			const data = (await res.json()) as {
				status: string;
				resultUrl: string | null;
			};
			// ElevenLabs Music is synchronous — already terminal + rehosted by the
			// route by the time the POST resolves.
			if (data.status !== "completed" || !data.resultUrl) {
				throw new Error("Music generation failed");
			}
			void useCreditsStore.getState().refresh();

			let projectId: string | null = null;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				projectId = null;
			}
			if (projectId) {
				const { added } = await addItemsToProjectMedia({
					editor,
					projectId,
					source: "ai",
					items: [
						{
							url: data.resultUrl,
							name: prompt.trim().slice(0, 48) || "AI music",
							kind: "audio",
						},
					],
				});
				if (added > 0) {
					toast.success("Music added to Assets.");
					setResultUrl(data.resultUrl);
				}
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Music generation failed",
			);
		} finally {
			setBusy(false);
		}
	}

	const settingsContent = (
		<>
			<ChipGrid
				label="Vocals"
				options={[
					{ value: "vocals", label: "With vocals" },
					{ value: "instrumental", label: "Instrumental" },
				]}
				value={instrumental ? "instrumental" : "vocals"}
				onChange={(v) => setInstrumental(v === "instrumental")}
			/>
			<ChipGrid
				label="Duration"
				options={MUSIC_DURATION_OPTIONS.map((d) => ({
					value: d,
					label: `${d}s`,
				}))}
				value={duration}
				onChange={setDuration}
			/>
		</>
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="space-y-1.5">
				<Label className="text-xs">Prompt</Label>
				<Textarea
					placeholder="Describe the track — genre, mood, instrumentation…"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					rows={4}
					className="resize-none text-sm"
				/>
			</div>

			{!instrumental && (
				<div className="space-y-1.5">
					<button
						type="button"
						onClick={() => setShowLyrics((v) => !v)}
						className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
					>
						{showLyrics ? "− Hide lyrics" : "+ Add lyrics"}
					</button>
					{showLyrics && (
						<Textarea
							placeholder="Optional lyrics to guide the vocals…"
							value={lyrics}
							onChange={(e) => setLyrics(e.target.value)}
							rows={3}
							className="resize-none text-sm"
						/>
					)}
				</div>
			)}

			<GenerationBottomBar
				summary={summary}
				settingsContent={settingsContent}
				cost={cost}
				onSubmit={handleGenerate}
				submitDisabled={!prompt.trim() || busy}
				busy={busy}
				submitLabel="Generate music"
				testIdPrefix="audio-gen"
			/>

			{resultUrl && (
				// biome-ignore lint/a11y/useMediaCaption: generated music has no caption track
				<audio controls className="w-full h-8" src={resultUrl} />
			)}
		</div>
	);
}

// ─── Voiceover (links to the canonical pipeline) ──────────────────────────

/**
 * Voiceover has its own full pipeline (language/translation/segments,
 * ~875 lines in `assets/views/voiceover.tsx`) that the Director's
 * `addVoiceover` verb also targets via `generate-voiceover-take.ts`. Rather
 * than fork that logic into a second implementation here, this mode just
 * routes to it — one click to the Assets panel's Audio tab, where the
 * Voiceover sub-tab lives.
 */
function VoiceoverRedirect() {
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	return (
		<div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
			<p className="text-xs font-medium">Full voiceover pipeline</p>
			<p className="text-[11px] text-muted-foreground">
				Script, language, voice cloning, and per-segment takes live in the
				Assets panel's Audio tab — the same pipeline the Director uses.
			</p>
			<button
				type="button"
				onClick={() => {
					setActiveTab("audio");
					toast.info('Opened Audio — pick the "Voiceover" sub-tab.');
				}}
				className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
			>
				Open Voiceover
			</button>
		</div>
	);
}
