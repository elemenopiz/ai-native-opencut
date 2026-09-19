/**
 * Layer 2's read half (`docs/plans/2026-09-18-director-autonomy-architecture.md`
 * §2): "give it the beat map, the transcript with word timings, scene
 * boundaries and the loudness curve, and let it write a short program over
 * the primitives."
 *
 * REUSE, NEVER REIMPLEMENT — every accessor here is a thin projection of an
 * analysis this repo already ships, and NONE of them re-derives one:
 *  - `beats()`      → `stores/beat-grid-store.ts`'s `getTimelineBeatMarkers`,
 *                     which is itself `lib/timeline/audio-sync-utils.ts`'s
 *                     `mapBeatsToTimeline` (SOURCE-time beats projected
 *                     through the analyzed clip's placement). The Director's
 *                     own `cutOnBeat` verb reads beats exactly this way.
 *  - `speech()`     → the same projection `director-api.ts`'s
 *                     `gatherSpeechIntervals` performs
 *                     (`sourceRangeToTimelineRange` over an
 *                     `AssetTranscriptLookup`'s segments), so a program and
 *                     that verb agree to the sample on where speech is.
 *  - `words()`      → the caller-supplied `TranscriptionResult` word list.
 *  - `loudness()`   → `lib/director/mix-read.ts`'s `computeLoudnessCurveDb`,
 *                     which is `lib/auto-cut/engine.ts`'s `computeLoudness`
 *                     at a mix-scale interval.
 *  - `clips()`/`tracks()`/`scenes()` → the live timeline, read-only.
 *
 * UNITS, stated once: every `*Sec` field is SECONDS, and every one is
 * TIMELINE-absolute EXCEPT `words()`, which is ASSET-RELATIVE because word
 * timings belong to a media file, not to a placement (the same convention
 * `getTranscript` documents — and the same trap it warns about: an asset-
 * relative timestamp is in the TRIM's timebase, not the playhead's).
 *
 * CAPABILITY-SCOPED, AND HONEST ABOUT IT. Every source below is optional. An
 * accessor whose source is not wired in this context throws a
 * {@link ProgramRuntimeError} that NAMES what is missing, rather than
 * returning `[]`/`null` — a program that reads "no beats" when the truth is
 * "beat analysis was never run here" would go on to make confidently wrong
 * cuts, and an empty array is indistinguishable from a real answer.
 */

import {
	getTimelineBeatMarkers,
	type BeatGrid,
} from "@/stores/beat-grid-store";
import { sourceRangeToTimelineRange } from "@/lib/timeline/audio-sync-utils";
import type { TimelineElement, TimelineTrack } from "@/types/timeline";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import type { TranscriptionResult } from "@/types/ai";
import { computeLoudnessCurveDb } from "../mix-read";
import { CRAFT_EPSILON, roundSec } from "../craft/types";
import { ProgramRuntimeError } from "./errors";
import type { HostFunction } from "./interpreter";
import {
	describeProgramValue,
	isProgramObject,
	type ProgramValue,
} from "./values";

/** Already-decoded mono PCM for one media asset — the same `samples`/`sampleRate` contract `mix-read.ts` and `lib/auto-cut/engine.ts` take. Decode happens at the CALL SITE, never here (this module stays browser-free). */
export interface ProgramPcm {
	samples: Float32Array;
	sampleRate: number;
}

/**
 * Everything the derived-data layer can read. All optional: a context that
 * wires only `tracks` gets `clips`/`tracks`/`scenes` and a clear refusal from
 * the rest.
 */
export interface DerivedDataSources {
	/** Live timeline tracks. Production: `editor.timeline.getTracks`. */
	tracks?: () => TimelineTrack[];
	/** The analyzed beat grid. Production: `useBeatGridStore.getState().grid`. */
	beatGrid?: () => BeatGrid | null;
	/** Per-asset transcript (sentence-level). Production: `lib/director/transcript-lookup.ts`'s `assetTranscriptLookup`. */
	transcripts?: (mediaId: string) => AssetTranscript | undefined;
	/**
	 * Per-asset WORD-level transcription. Separate from `transcripts` because
	 * the stored `AssetTranscript` record deliberately drops word data
	 * (`lib/search/asset-transcript.ts`'s `fromTranscriptionResult`), so the
	 * only way a program can have word timings is a context that kept the raw
	 * `TranscriptionResult` around and wires it here.
	 */
	words?: (mediaId: string) => TranscriptionResult | undefined;
	/** Decoded PCM per media asset, for `loudness()`. */
	pcm?: (mediaId: string) => ProgramPcm | undefined;
}

// ---- argument helpers -------------------------------------------------------

function optionsArg(
	name: string,
	args: ProgramValue[],
): Record<string, ProgramValue> {
	const raw = args[0];
	if (raw === undefined || raw === null) return {};
	if (!isProgramObject(raw)) {
		throw new ProgramRuntimeError(
			`${name}() takes an optional object argument, got ${describeProgramValue(raw)}.`,
		);
	}
	return raw;
}

function stringField(
	fn: string,
	bag: Record<string, ProgramValue>,
	key: string,
	required: boolean,
): string | undefined {
	const value = bag[key];
	if (value === undefined || value === null) {
		if (required) throw new ProgramRuntimeError(`${fn}() requires "${key}".`);
		return undefined;
	}
	if (typeof value !== "string") {
		throw new ProgramRuntimeError(
			`${fn}() argument "${key}" must be a string, got ${describeProgramValue(value)}.`,
		);
	}
	return value;
}

function numberField(
	fn: string,
	bag: Record<string, ProgramValue>,
	key: string,
): number | undefined {
	const value = bag[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ProgramRuntimeError(
			`${fn}() argument "${key}" must be a finite number, got ${describeProgramValue(value)}.`,
		);
	}
	return value;
}

function requireSource<T>(
	value: T | undefined,
	accessor: string,
	whatIsMissing: string,
): T {
	if (value === undefined) {
		throw new ProgramRuntimeError(
			`${accessor}() is unavailable here — ${whatIsMissing}`,
		);
	}
	return value;
}

// ---- projections ------------------------------------------------------------

/** One timeline element, flattened into the closed value domain. Mirrors the fields `craft/cut-on-beat.ts`'s `CraftClip` needs, plus the identity/kind fields a program needs to pick targets. */
function toClipValue(
	track: TimelineTrack,
	element: TimelineElement,
): ProgramValue {
	const mediaId = (element as { mediaId?: string }).mediaId;
	return {
		id: element.id,
		trackId: track.id,
		trackKind: track.type,
		kind: element.type,
		name: element.name,
		startSec: element.startTime,
		durationSec: element.duration,
		endSec: roundSec(element.startTime + element.duration),
		trimStart: element.trimStart ?? 0,
		trimEnd: element.trimEnd ?? 0,
		// `generation` is the canonical "this is a reel slot" marker
		// (`types/timeline.ts`). Surfaced because the primitive layer's
		// slot-only targeting (see `primitives.ts`'s TARGETING CAVEAT) makes it
		// the difference between a trim that lands and one that fails.
		isSlot: Boolean((element as { generation?: unknown }).generation),
		...(mediaId ? { mediaId } : {}),
	};
}

function sortedElements(track: TimelineTrack): TimelineElement[] {
	return [...track.elements].sort((a, b) => a.startTime - b.startTime);
}

/**
 * Which accessors will actually ANSWER in this context, as opposed to
 * refusing with "unavailable here". `createDerivedDataFunctions` always binds
 * all seven — an accessor that simply vanished would produce the much worse
 * `Unknown function "beats"` instead of a message naming the missing source —
 * so availability has to be reported separately, and this is what a prompt or
 * a tool-catalog entry should enumerate rather than the full key set.
 */
export function listAvailableDerivedAccessors(
	sources: DerivedDataSources,
): string[] {
	const hasTracks = Boolean(sources.tracks);
	const available: string[] = [];
	if (hasTracks) available.push("clips", "scenes", "tracks");
	if (hasTracks && sources.beatGrid) available.push("beats");
	if (hasTracks && sources.transcripts) available.push("speech");
	if (sources.words) available.push("words");
	if (sources.pcm) available.push("loudness");
	return available.sort();
}

// ---- the accessor table -----------------------------------------------------

/**
 * Build the read-only half of a program's global table. Pure per call — the
 * returned functions close over `sources`, read through them on EVERY call
 * (so a program sees the timeline as it is now, not as it was when the run
 * started), and never mutate anything.
 */
export function createDerivedDataFunctions(
	sources: DerivedDataSources,
): Record<string, HostFunction> {
	const readTracks = (accessor: string): TimelineTrack[] =>
		requireSource(
			sources.tracks,
			accessor,
			"no timeline is wired into this program run.",
		)();

	/** Shared by `clips()`/`scenes()`: the target track, or every track when unscoped. */
	const scopedTracks = (
		accessor: string,
		trackId: string | undefined,
	): TimelineTrack[] => {
		const tracks = readTracks(accessor);
		if (!trackId) return tracks;
		const found = tracks.find((t) => t.id === trackId);
		if (!found) {
			throw new ProgramRuntimeError(
				`${accessor}(): no track with id "${trackId}". Live track ids: ${tracks.map((t) => t.id).join(", ") || "(none)"}.`,
			);
		}
		return [found];
	};

	return {
		/** Every track's identity + element count. The map a program reads before choosing a `trackId`. */
		tracks: () =>
			readTracks("tracks").map((track) => ({
				id: track.id,
				kind: track.type,
				elementCount: track.elements.length,
			})),

		/** Clips in start-time order, optionally scoped to one track. See {@link toClipValue} for the field set. */
		clips: (args) => {
			const bag = optionsArg("clips", args);
			const trackId = stringField("clips", bag, "trackId", false);
			const kind = stringField("clips", bag, "kind", false);
			const out: ProgramValue[] = [];
			for (const track of scopedTracks("clips", trackId)) {
				for (const element of sortedElements(track)) {
					if (kind && element.type !== kind) continue;
					out.push(toClipValue(track, element));
				}
			}
			// Cross-track results are still globally start-ordered, so a program
			// that omits `trackId` reads the timeline the way a person scrubs it.
			out.sort(
				(a, b) =>
					((a as { startSec: number }).startSec ?? 0) -
					((b as { startSec: number }).startSec ?? 0),
			);
			return out;
		},

		/**
		 * Beats in TIMELINE time. Empty only when the grid's source clip has
		 * been trimmed past every beat; a MISSING grid throws instead, because
		 * "no beat analysis has run" and "this clip has no beats in view" are
		 * different answers and a program must not conflate them.
		 */
		beats: () => {
			const readGrid = requireSource(
				sources.beatGrid,
				"beats",
				"no beat grid is wired into this program run.",
			);
			const grid = readGrid();
			if (!grid) {
				throw new ProgramRuntimeError(
					"beats() has no analyzed beat grid — analyze a music/audio clip's beats first (the timeline's beat-snap toggle), then re-run.",
				);
			}
			return getTimelineBeatMarkers({
				tracks: readTracks("beats"),
				grid,
			}).map((marker) => ({
				time: marker.time,
				isDownbeat: marker.isDownbeat,
			}));
		},

		/**
		 * Speech spans in TIMELINE time, projected from each clip's transcript
		 * through its trim window — the same projection `gatherSpeechIntervals`
		 * performs for `duckMusicUnderSpeech`/`tightenToLength`, so a program's
		 * idea of "where the talking is" matches those verbs' exactly.
		 */
		speech: (args) => {
			const bag = optionsArg("speech", args);
			const trackId = stringField("speech", bag, "trackId", false);
			const lookup = requireSource(
				sources.transcripts,
				"speech",
				"no transcript pass is wired into this program run.",
			);
			const out: ProgramValue[] = [];
			for (const track of scopedTracks("speech", trackId)) {
				for (const element of track.elements) {
					const mediaId = (element as { mediaId?: string }).mediaId;
					if (!mediaId) continue;
					const transcript = lookup(mediaId);
					if (!transcript) continue;
					for (const segment of transcript.segments) {
						if (!segment.text.trim()) continue;
						const range = sourceRangeToTimelineRange({
							element,
							range: { start: segment.start, end: segment.end },
						});
						if (!range) continue;
						out.push({
							startSec: range.start,
							endSec: range.end,
							text: segment.text,
							mediaId,
							clipId: element.id,
						});
					}
				}
			}
			out.sort(
				(a, b) =>
					((a as { startSec: number }).startSec ?? 0) -
					((b as { startSec: number }).startSec ?? 0),
			);
			return out;
		},

		/**
		 * WORD timings for one media asset, ASSET-RELATIVE. Separate accessor
		 * (and separate source) from `speech()` because the repo's stored
		 * transcript record drops word data — see
		 * {@link DerivedDataSources.words}.
		 */
		words: (args) => {
			const bag = optionsArg("words", args);
			const mediaId = stringField("words", bag, "mediaId", true) as string;
			const lookup = requireSource(
				sources.words,
				"words",
				"no word-level transcription is wired into this program run (the stored per-asset transcript is sentence-level; use speech() for that).",
			);
			const result = lookup(mediaId);
			if (!result) {
				throw new ProgramRuntimeError(
					`words(): no word-level transcription for media "${mediaId}".`,
				);
			}
			const out: ProgramValue[] = [];
			for (const segment of result.segments) {
				for (const word of segment.words ?? []) {
					out.push({
						word: word.word,
						startSec: word.start,
						endSec: word.end,
						confidence: word.confidence,
						...(segment.speaker ? { speaker: segment.speaker } : {}),
					});
				}
			}
			return out;
		},

		/**
		 * Scene (shot-run) boundaries on a track: each maximal run of clips
		 * that JOIN end-to-start within {@link CRAFT_EPSILON}. This repo has no
		 * visual shot-detection pass, so a "scene boundary" here is the cut
		 * structure the timeline actually has — a gap between clips is a scene
		 * break, contiguous clips are one scene. Grounded, not invented; if a
		 * real detector ever lands, this is where it attaches.
		 */
		scenes: (args) => {
			const bag = optionsArg("scenes", args);
			const trackId = stringField("scenes", bag, "trackId", false);
			const out: ProgramValue[] = [];
			for (const track of scopedTracks("scenes", trackId)) {
				const elements = sortedElements(track);
				let current: {
					trackId: string;
					index: number;
					startSec: number;
					endSec: number;
					clipIds: ProgramValue[];
				} | null = null;
				for (const element of elements) {
					const start = element.startTime;
					const end = element.startTime + element.duration;
					if (current && Math.abs(start - current.endSec) <= CRAFT_EPSILON) {
						current.endSec = end;
						current.clipIds.push(element.id);
						continue;
					}
					if (current) out.push(sealScene(current));
					current = {
						trackId: track.id,
						index: out.length,
						startSec: start,
						endSec: end,
						clipIds: [element.id],
					};
				}
				if (current) out.push(sealScene(current));
			}
			return out;
		},

		/**
		 * The loudness curve of one media asset's decoded audio, in dBFS at
		 * `intervalSec` resolution. `atSec` is ASSET-RELATIVE (it is a property
		 * of the file, like `words()`), so project it through a clip's
		 * placement before comparing it to a timeline time.
		 */
		loudness: (args) => {
			const bag = optionsArg("loudness", args);
			const mediaId = stringField("loudness", bag, "mediaId", true) as string;
			const intervalSec = numberField("loudness", bag, "intervalSec");
			if (intervalSec !== undefined && intervalSec <= 0) {
				throw new ProgramRuntimeError(
					"loudness(): intervalSec must be greater than 0.",
				);
			}
			const lookup = requireSource(
				sources.pcm,
				"loudness",
				"no decoded audio is wired into this program run.",
			);
			const pcm = lookup(mediaId);
			if (!pcm) {
				throw new ProgramRuntimeError(
					`loudness(): no decoded audio for media "${mediaId}".`,
				);
			}
			return computeLoudnessCurveDb(
				pcm.samples,
				pcm.sampleRate,
				intervalSec,
			).map((point) => ({ atSec: point.atSec, levelDb: point.levelDb }));
		},
	};
}

function sealScene(scene: {
	trackId: string;
	index: number;
	startSec: number;
	endSec: number;
	clipIds: ProgramValue[];
}): ProgramValue {
	return {
		trackId: scene.trackId,
		index: scene.index,
		startSec: scene.startSec,
		endSec: roundSec(scene.endSec),
		durationSec: roundSec(scene.endSec - scene.startSec),
		clipIds: scene.clipIds,
	};
}
