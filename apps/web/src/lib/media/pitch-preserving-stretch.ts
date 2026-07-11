/**
 * Pitch-preserving time-stretch seam — the ONE place both the preview
 * (AudioManager) and the export mixdown (createTimelineAudioBuffer) go through
 * when a clip has a constant playback-speed change. Routing both paths through
 * the same renderer is what guarantees preview and export sound identical.
 *
 * Uses signalsmith-stretch (MIT, WASM AudioWorklet) rendered offline: the
 * source segment covered by the clip's timeline slot is stretched once into a
 * rate-1 AudioBuffer of exactly the slot's duration, which callers then play or
 * mix with no further rate handling.
 *
 * Failure policy: this module NEVER throws to callers and NEVER blocks
 * playback. Any failure (WASM/worklet load, offline render, timeout) resolves
 * to `null`, and callers fall back to the previous raw-rate behavior
 * (correct speed, shifted pitch) with a console warning.
 */

const STRETCH_RENDER_TIMEOUT_MS = 30_000;
/** Cap on how many output channels we stretch/render (matches export mixdown). */
const MAX_STRETCH_CHANNELS = 2;
/**
 * Memory guard: a stretched slot is held fully decoded in RAM
 * (~duration * rate * sampleRate * channels * 4 bytes of source + the output).
 * Slots longer than this fall back to pitch-shifted playback instead of
 * risking an OOM. 300 s stereo @48 kHz ≈ 115 MB output.
 */
const MAX_STRETCH_SLOT_SECONDS = 300;

/**
 * The subset of the signalsmith-stretch node API we use. The real node is an
 * AudioWorkletNode with these methods attached after the ready handshake.
 */
export interface StretchNodeLike {
	connect: (destination: AudioNode) => AudioNode;
	addBuffers: (buffers: Float32Array[]) => Promise<number>;
	schedule: (change: {
		output?: number;
		input?: number;
		rate?: number;
		active?: boolean;
	}) => Promise<unknown>;
}

export type StretchFactory = (
	audioContext: BaseAudioContext,
	options?: {
		numberOfInputs?: number;
		numberOfOutputs?: number;
		outputChannelCount?: number[];
	},
) => Promise<StretchNodeLike>;

export type StretchFactoryLoader = () => Promise<StretchFactory | null>;

/**
 * Constant-rate speed decision shared by preview and export:
 * - "bypass": rate is 1 (or invalid) — take the untouched original path.
 * - "stretch": constant rate != 1 — pitch-preserving time-stretch at `rate`.
 * - "constant-fallback": keyframed (variable) speed curve — out of scope for
 *   stretching; both paths keep today's behavior (constant base `rate`,
 *   pitch-shifted).
 */
export type StretchDecision =
	| { mode: "bypass"; rate: 1 }
	| { mode: "stretch"; rate: number }
	| { mode: "constant-fallback"; rate: number };

export function resolveStretchDecision({
	playbackRate,
	hasVariableRate,
}: {
	playbackRate: number | undefined | null;
	hasVariableRate?: boolean;
}): StretchDecision {
	const rate =
		typeof playbackRate === "number" &&
		Number.isFinite(playbackRate) &&
		playbackRate > 0
			? playbackRate
			: 1;

	if (rate === 1) return { mode: "bypass", rate: 1 };
	if (hasVariableRate) return { mode: "constant-fallback", rate };
	return { mode: "stretch", rate };
}

/** True when a clip should go through the pitch-preserving stretcher. */
export function shouldTimeStretch({
	playbackRate,
	hasVariableRate,
}: {
	playbackRate: number | undefined | null;
	hasVariableRate?: boolean;
}): boolean {
	return (
		resolveStretchDecision({ playbackRate, hasVariableRate }).mode === "stretch"
	);
}

let warnedLoadFailure = false;
let factoryPromise: Promise<StretchFactory | null> | null = null;
let loaderOverride: StretchFactoryLoader | null = null;

/**
 * Vendored, pristine copy of node_modules/signalsmith-stretch/
 * SignalsmithStretch.mjs (MIT — see THIRD_PARTY_NOTICES.md). It MUST be loaded
 * as an untouched native ES module: the library builds its AudioWorklet
 * processor by STRINGIFYING its own functions into a Blob module, so any
 * bundler transformation (webpack/turbopack wrapping, minification) corrupts
 * the generated worklet script — the node's ready handshake then never fires
 * and every render hangs until the timeout. A unit test asserts this copy
 * stays byte-identical to the installed package.
 */
const VENDORED_STRETCH_URL = "/vendor/signalsmith-stretch-1.3.2.mjs";

const defaultLoader: StretchFactoryLoader = async () => {
	if (typeof window === "undefined") return null;
	// Native dynamic import, hidden from both bundlers (see note above). Also
	// keeps the ~110 KB WASM module out of every page load; it is only fetched
	// the first time a speed-changed clip is actually rendered.
	const mod = (await import(
		/* webpackIgnore: true */ /* turbopackIgnore: true */ VENDORED_STRETCH_URL
	)) as { default: StretchFactory };
	return mod.default;
};

/**
 * Test hook: replace (or with `null`, restore) how the stretch factory is
 * loaded. Also resets the cached factory + warning state.
 */
export function setStretchFactoryLoaderForTests(
	loader: StretchFactoryLoader | null,
): void {
	loaderOverride = loader;
	factoryPromise = null;
	warnedLoadFailure = false;
}

async function loadStretchFactory(): Promise<StretchFactory | null> {
	if (!factoryPromise) {
		const loader = loaderOverride ?? defaultLoader;
		factoryPromise = loader().catch((error) => {
			if (!warnedLoadFailure) {
				warnedLoadFailure = true;
				// console.error (not warn): next.config strips console.warn from
				// production bundles, and this once-per-session signal must survive
				// there — it explains why every speed-changed clip sounds chipmunked.
				console.error(
					"Pitch-preserving stretch unavailable (failed to load signalsmith-stretch); " +
						"speed-changed clips will play with shifted pitch.",
					error,
				);
			}
			return null;
		});
	}
	return factoryPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Stretch render timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Render a pitch-preserved, rate-1 version of the source span a speed-changed
 * clip covers.
 *
 * Time model (matches VisualNode.getSourceLocalTime): the clip occupies a fixed
 * timeline slot of `duration` seconds and traverses the source at
 * `playbackRate`, so it consumes `duration * playbackRate` seconds of source
 * starting at `trimStart`. The returned buffer is that span time-stretched to
 * `duration` seconds at `targetSampleRate` — play/mix it at rate 1 starting at
 * the clip's timeline start.
 *
 * Resolves `null` (never throws) when stretching is not applicable or anything
 * fails; callers must fall back to the raw-rate (pitch-shifted) path.
 */
export async function stretchAudioBufferSegment({
	buffer,
	playbackRate,
	trimStart,
	duration,
	targetSampleRate,
}: {
	buffer: AudioBuffer;
	playbackRate: number;
	trimStart: number;
	duration: number;
	targetSampleRate: number;
}): Promise<AudioBuffer | null> {
	if (!shouldTimeStretch({ playbackRate })) return null;
	if (!(duration > 0) || !(targetSampleRate > 0)) return null;
	if (duration > MAX_STRETCH_SLOT_SECONDS) {
		console.warn(
			`Pitch-preserving stretch skipped: clip slot is ${Math.round(duration)}s ` +
				`(limit ${MAX_STRETCH_SLOT_SECONDS}s); playing with shifted pitch.`,
		);
		return null;
	}

	const factory = await loadStretchFactory();
	if (!factory) return null;

	try {
		return await withTimeout(
			renderStretchedSegment({
				buffer,
				playbackRate,
				trimStart,
				duration,
				targetSampleRate,
				factory,
			}),
			STRETCH_RENDER_TIMEOUT_MS,
		);
	} catch (error) {
		console.warn(
			`Pitch-preserving stretch failed (rate ${playbackRate}x); ` +
				"falling back to pitch-shifted playback for this clip.",
			error,
		);
		return null;
	}
}

async function renderStretchedSegment({
	buffer,
	playbackRate,
	trimStart,
	duration,
	targetSampleRate,
	factory,
}: {
	buffer: AudioBuffer;
	playbackRate: number;
	trimStart: number;
	duration: number;
	targetSampleRate: number;
	factory: StretchFactory;
}): Promise<AudioBuffer | null> {
	const channels = Math.min(MAX_STRETCH_CHANNELS, buffer.numberOfChannels);
	if (channels < 1) return null;

	// Source span covered by the timeline slot.
	const sourceStart = Math.max(0, trimStart);
	const sourceDuration = duration * playbackRate;
	const sourceEnd = Math.min(buffer.duration, sourceStart + sourceDuration);
	if (sourceEnd <= sourceStart) return null;

	// 1) Extract (and if needed resample to targetSampleRate) the source span.
	// The stretch worklet consumes raw sample arrays at its context's rate, so
	// samples must already be at targetSampleRate when fed in.
	const segment = await extractSegmentAtRate({
		buffer,
		channels,
		startSeconds: sourceStart,
		endSeconds: sourceEnd,
		targetSampleRate,
	});
	if (!segment) return null;

	// 2) Offline render: feed the segment through the stretcher at
	// `playbackRate` so `sourceDuration` seconds of input fill the `duration`
	// second slot with the original pitch.
	//
	// AudioWorklet-in-OfflineAudioContext gotcha: the rendering thread (which
	// pumps the worklet's MessagePort — the factory's ready handshake, and the
	// addBuffers/schedule round-trips) only runs once startRendering() has been
	// called. Awaiting the handshake before starting the render deadlocks. So:
	// suspend at frame 0, start rendering, build the worklet graph while
	// suspended, then resume.
	const outputLength = Math.ceil(duration * targetSampleRate);
	const renderContext = new OfflineAudioContext(
		channels,
		outputLength,
		targetSampleRate,
	);

	const setup = renderContext.suspend(0).then(async () => {
		try {
			const stretch = await factory(renderContext, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [channels],
			});
			stretch.connect(renderContext.destination);
			await stretch.addBuffers(segment);
			await stretch.schedule({
				output: 0,
				input: 0,
				rate: playbackRate,
				active: true,
			});
		} finally {
			// Always resume so startRendering() can finish; if setup failed the
			// rejection below outranks the (silent) render result.
			await renderContext.resume().catch(() => {});
		}
	});

	const [rendered] = await Promise.all([renderContext.startRendering(), setup]);
	return rendered;
}

/**
 * Copy a [start, end) span of an AudioBuffer into per-channel Float32Arrays at
 * `targetSampleRate`, resampling via OfflineAudioContext when rates differ
 * (same resampling strategy the export decode path already uses).
 */
async function extractSegmentAtRate({
	buffer,
	channels,
	startSeconds,
	endSeconds,
	targetSampleRate,
}: {
	buffer: AudioBuffer;
	channels: number;
	startSeconds: number;
	endSeconds: number;
	targetSampleRate: number;
}): Promise<Float32Array[] | null> {
	const spanSeconds = endSeconds - startSeconds;

	if (buffer.sampleRate === targetSampleRate) {
		const startSample = Math.floor(startSeconds * buffer.sampleRate);
		const endSample = Math.min(
			buffer.length,
			Math.ceil(endSeconds * buffer.sampleRate),
		);
		if (endSample <= startSample) return null;
		return Array.from({ length: channels }, (_, channel) => {
			const source = buffer.getChannelData(
				Math.min(channel, buffer.numberOfChannels - 1),
			);
			// Copy: the worklet transfers/holds these; never hand it views into
			// the caller's live buffer.
			return source.slice(startSample, endSample);
		});
	}

	const outputLength = Math.ceil(spanSeconds * targetSampleRate);
	if (outputLength <= 0) return null;
	const resampleContext = new OfflineAudioContext(
		channels,
		outputLength,
		targetSampleRate,
	);
	const sourceNode = resampleContext.createBufferSource();
	sourceNode.buffer = buffer;
	sourceNode.connect(resampleContext.destination);
	sourceNode.start(0, startSeconds, spanSeconds);
	const resampled = await resampleContext.startRendering();
	return Array.from({ length: channels }, (_, channel) =>
		resampled
			.getChannelData(Math.min(channel, resampled.numberOfChannels - 1))
			.slice(),
	);
}
