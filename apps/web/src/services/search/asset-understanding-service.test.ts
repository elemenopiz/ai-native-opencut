import { describe, expect, it } from "bun:test";
import type { MediaAsset } from "@/types/assets";
import {
	type AssetUnderstanding,
	UnderstandingRelayError,
} from "@/lib/search/asset-understanding";
import {
	probeAssetAudio,
	resolveUnderstandingModelName,
	UNDERSTANDING_MODEL,
	understandAssetBatch,
} from "./asset-understanding-service";
import type { AssetTranscript } from "@/lib/search/asset-transcript";

/** A minimal visual asset; override per test. */
function asset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		url: `blob:${id}`,
	} as MediaAsset;
}

/** A complete understanding record keyed to `mediaId`. */
function record(mediaId: string): AssetUnderstanding {
	return {
		mediaId,
		caption: "c",
		role: "b-roll",
		roleConfidence: 0.5,
		tags: [],
		faces: [],
		modelName: "test-model",
		createdAt: 1,
	};
}

/** The relay's 402 as `relayUnderstandAsset` throws it — body still readable. */
function creditGate402(): UnderstandingRelayError {
	const res = new Response(
		JSON.stringify({ error: "insufficient_credits", needed: 5, spendable: 0 }),
		{ status: 402 },
	);
	return new UnderstandingRelayError("relay 402", 402, res);
}

describe("understandAssetBatch", () => {
	it("processes sequentially and tallies understood vs. failed", async () => {
		const order: string[] = [];
		const summary = await understandAssetBatch(
			[asset("a"), asset("b"), asset("c")],
			{
				gate: async () => true,
				understandOne: async (m) => {
					order.push(m.id);
					return m.id === "b" ? null : record(m.id); // b fails softly
				},
			},
		);
		expect(order).toEqual(["a", "b", "c"]);
		expect(summary).toEqual({ processed: 3, understood: 2, gated: false });
	});

	it("routes a 402 through the gate ONCE and stops the batch", async () => {
		const attempted: string[] = [];
		const gatedBodies: unknown[] = [];
		const summary = await understandAssetBatch(
			[asset("a"), asset("b"), asset("c")],
			{
				gate: async (res) => {
					gatedBodies.push(await res.clone().json());
					return true;
				},
				understandOne: async (m) => {
					attempted.push(m.id);
					if (m.id === "b") throw creditGate402();
					return record(m.id);
				},
			},
		);
		expect(attempted).toEqual(["a", "b"]); // c never billed
		expect(summary.gated).toBe(true);
		expect(summary.understood).toBe(1);
		// The gate saw the un-consumed 402 body (gateOn402 needs it to size the modal).
		expect(gatedBodies).toEqual([
			{ error: "insufficient_credits", needed: 5, spendable: 0 },
		]);
	});

	it("keeps going past a non-credit error (per-asset failure, not policy)", async () => {
		const summary = await understandAssetBatch([asset("a"), asset("b")], {
			gate: async () => true,
			understandOne: async (m) => {
				if (m.id === "a") throw new Error("boom");
				return record(m.id);
			},
		});
		expect(summary).toEqual({ processed: 2, understood: 1, gated: false });
	});

	it("stops when shouldContinue flips false (hook unmounted)", async () => {
		let calls = 0;
		const summary = await understandAssetBatch(
			[asset("a"), asset("b"), asset("c")],
			{
				gate: async () => true,
				shouldContinue: () => calls < 1,
				understandOne: async (m) => {
					calls += 1;
					return record(m.id);
				},
			},
		);
		expect(summary.processed).toBe(1);
	});

	it("skips an asset another batch already has inflight (no double bill)", async () => {
		let release: () => void = () => {};
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		const attempts: string[] = [];
		const understandOne = async (m: MediaAsset) => {
			attempts.push(m.id);
			await blocked;
			return record(m.id);
		};
		const first = understandAssetBatch([asset("dup")], {
			gate: async () => true,
			understandOne,
		});
		// Second batch starts while "dup" is inflight in the first — it must skip.
		const second = await understandAssetBatch([asset("dup")], {
			gate: async () => true,
			understandOne,
		});
		expect(second).toEqual({ processed: 0, understood: 0, gated: false });
		release();
		expect(await first).toEqual({ processed: 1, understood: 1, gated: false });
		expect(attempts).toEqual(["dup"]);
	});
});

describe("resolveUnderstandingModelName — where a record's modelName originates", () => {
	/** Run `fn` with the env config set/cleared, restoring it afterwards (per-call read, no module reload). */
	function withEnvModel<T>(value: string | undefined, fn: () => T): T {
		const prev = process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
		if (value === undefined) delete process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
		else process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL = value;
		try {
			return fn();
		} finally {
			if (prev === undefined)
				delete process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
			else process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL = prev;
		}
	}

	it("defaults to the current pipeline tag", () => {
		withEnvModel(undefined, () => {
			expect(resolveUnderstandingModelName()).toBe(UNDERSTANDING_MODEL);
			// `vlm-v2` retires the `vlm-v1` corpus: those records carry a `motion`
			// and an `audio` the model invented, and there is nothing to repair.
			expect(resolveUnderstandingModelName()).toBe("vlm-v2");
		});
	});

	it("a configured model becomes the stored tag — flipping it invalidates old records", () => {
		withEnvModel("gemini-3.5-flash", () => {
			const tag = resolveUnderstandingModelName();
			expect(tag).toBe("gemini-3.5-flash");
			// The de-dupe check in understandAsset is `existing.modelName === tag`;
			// a record produced under the default tag no longer short-circuits.
			expect(tag === UNDERSTANDING_MODEL).toBe(false);
		});
	});

	it("an explicit per-call override wins over the env config", () => {
		withEnvModel("gemini-3.5-flash", () => {
			expect(resolveUnderstandingModelName("vlm-test")).toBe("vlm-test");
		});
	});
});

describe("probeAssetAudio — the MEASURED replacement for asking a blind model", () => {
	/** An asset carrying real bytes, so the energy half has something to decode. */
	function audioAsset(over: Partial<MediaAsset> = {}): MediaAsset {
		return {
			id: "m1",
			name: "clip.mp4",
			type: "video",
			url: "blob:m1",
			file: new File([new Uint8Array([1, 2, 3])], "clip.mp4", {
				type: "video/mp4",
			}),
			...over,
		} as MediaAsset;
	}

	function transcript(segments: AssetTranscript["segments"]): AssetTranscript {
		return {
			mediaId: "m1",
			segments,
			language: "en",
			createdAt: 1,
		} as AssetTranscript;
	}

	/** A decode stub returning a constant-amplitude signal at `level`. */
	const decodeAt = (level: number) => async () =>
		new Float32Array(16000).fill(level);

	it("takes hasSpeech from the TRANSCRIPT, which actually answers it", async () => {
		const probe = await probeAssetAudio(audioAsset(), {
			transcript: async () =>
				transcript([{ start: 0, end: 1, text: "hello there" }]),
			decode: decodeAt(0.5),
		});
		expect(probe?.hasSpeech).toBe(true);
	});

	it("distinguishes 'transcribed, silent' (false) from 'not transcribed yet' (absent)", async () => {
		const transcribedSilent = await probeAssetAudio(audioAsset(), {
			transcript: async () => transcript([]),
			decode: decodeAt(0.5),
		});
		expect(transcribedSilent?.hasSpeech).toBe(false);

		const notTranscribed = await probeAssetAudio(audioAsset(), {
			transcript: async () => undefined,
			decode: decodeAt(0.5),
		});
		expect(notTranscribed).toBeDefined();
		expect(notTranscribed?.hasSpeech).toBeUndefined();
	});

	it("bands energy off the real decoded signal", async () => {
		const hot = await probeAssetAudio(audioAsset(), {
			transcript: async () => undefined,
			decode: decodeAt(0.9),
		});
		expect(hot?.energy).toBe("high");

		const quiet = await probeAssetAudio(audioAsset(), {
			transcript: async () => undefined,
			decode: decodeAt(0.004),
		});
		expect(quiet?.energy).toBe("low");
	});

	it("returns undefined when NEITHER source has anything — never an empty shell", async () => {
		const probe = await probeAssetAudio(audioAsset(), {
			transcript: async () => undefined,
			decode: async () => {
				throw new Error("no decodable audio track");
			},
		});
		expect(probe).toBeUndefined();
	});

	it("keeps the speech half when the decode fails", async () => {
		const probe = await probeAssetAudio(audioAsset(), {
			transcript: async () =>
				transcript([{ start: 0, end: 1, text: "hello there" }]),
			decode: async () => {
				throw new Error("no decodable audio track");
			},
		});
		expect(probe).toEqual({ hasSpeech: true });
	});

	it("skips the decode for an image, and for an asset with no bytes", async () => {
		let decoded = 0;
		const countingDecode = async () => {
			decoded += 1;
			return new Float32Array(16000).fill(0.9);
		};
		const image = await probeAssetAudio(
			audioAsset({ type: "image", name: "still.jpg" }),
			{ transcript: async () => undefined, decode: countingDecode },
		);
		expect(image).toBeUndefined();

		const urlOnly = await probeAssetAudio(
			audioAsset({ file: undefined as unknown as File }),
			{ transcript: async () => undefined, decode: countingDecode },
		);
		expect(urlOnly).toBeUndefined();
		expect(decoded).toBe(0);
	});

	it("skips the decode for an over-long asset rather than chewing through it", async () => {
		let decoded = 0;
		const probe = await probeAssetAudio(
			audioAsset({ duration: 60 * 60 } as Partial<MediaAsset>),
			{
				transcript: async () => undefined,
				decode: async () => {
					decoded += 1;
					return new Float32Array(16000).fill(0.9);
				},
			},
		);
		expect(decoded).toBe(0);
		expect(probe).toBeUndefined();
	});

	it("a transcript-store failure degrades to absent instead of throwing", async () => {
		const probe = await probeAssetAudio(audioAsset(), {
			transcript: async () => {
				throw new Error("IndexedDB unavailable");
			},
			decode: decodeAt(0.9),
		});
		expect(probe).toEqual({ energy: "high" });
	});
});
