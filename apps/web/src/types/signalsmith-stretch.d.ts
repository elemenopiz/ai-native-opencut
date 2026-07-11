/**
 * Types for signalsmith-stretch@1.3.2 (no upstream .d.ts). Mirrors the
 * documented API: https://signalsmith-audio.co.uk/code/stretch/ — a factory
 * that resolves to an AudioWorkletNode with stretch methods attached after the
 * ready handshake.
 */
declare module "signalsmith-stretch" {
	export interface StretchScheduleChange {
		/** Audio-context time for this change (seconds). */
		output?: number;
		/** Processing audio or not. */
		active?: boolean;
		/** Position in the input buffer (seconds). */
		input?: number;
		/** Playback rate, e.g. 0.5 == half speed. */
		rate?: number;
		/** Pitch shift in semitones. */
		semitones?: number;
		tonalityHz?: number;
		formantSemitones?: number;
		formantCompensation?: boolean;
		formantBaseHz?: number;
		loopStart?: number;
		loopEnd?: number;
	}

	export interface StretchNode extends AudioWorkletNode {
		/** Current input time within the sample buffer (seconds). */
		inputTime: number;
		schedule(change: StretchScheduleChange): Promise<unknown>;
		start(when?: number, offset?: number, duration?: number): Promise<unknown>;
		stop(when?: number): Promise<unknown>;
		/** Append per-channel sample arrays; resolves to the new buffer end (seconds). */
		addBuffers(buffers: Float32Array[]): Promise<number>;
		dropBuffers(
			toSeconds?: number,
		): Promise<{ start: number; end: number } | undefined>;
		latency(): Promise<number>;
		configure(options: {
			blockMs?: number | null;
			intervalMs?: number;
			splitComputation?: boolean;
			preset?: "default" | "cheaper";
		}): Promise<unknown>;
		setUpdateInterval(
			seconds: number,
			callback?: (inputTime: number) => void,
		): Promise<unknown>;
	}

	/**
	 * Creates a Stretch node on the given context (registers the worklet module
	 * on first use; the WASM is inlined in the package).
	 */
	export default function SignalsmithStretch(
		audioContext: BaseAudioContext,
		options?: {
			numberOfInputs?: number;
			numberOfOutputs?: number;
			outputChannelCount?: number[];
			channelCount?: number;
		},
	): Promise<StretchNode>;
}
