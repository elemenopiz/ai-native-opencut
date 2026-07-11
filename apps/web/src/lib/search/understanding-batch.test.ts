import { describe, expect, it } from "bun:test";
import type { MediaAsset } from "@/types/assets";
import {
	selectUnderstandingCandidates,
	UNDERSTANDING_AUTORUN_TICK_CAP,
} from "./understanding-batch";

/** A minimal visual asset; override per test. */
function asset(over: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "m1",
		name: "clip.mp4",
		type: "video",
		url: "blob:clip",
		...over,
	} as MediaAsset;
}

describe("selectUnderstandingCandidates", () => {
	it("keeps only visual assets with a loaded url", () => {
		const picked = selectUnderstandingCandidates([
			asset({ id: "vid", type: "video" }),
			asset({ id: "img", type: "image", url: "blob:img" }),
			asset({ id: "aud", type: "audio" }), // no visual signal to caption
			asset({ id: "nourl", type: "video", url: undefined }), // nothing to sample
		]);
		expect(picked.map((a) => a.id)).toEqual(["vid", "img"]);
	});

	it("skips excluded ids (already understood / attempted / inflight)", () => {
		const picked = selectUnderstandingCandidates(
			[asset({ id: "a" }), asset({ id: "b" }), asset({ id: "c" })],
			{ exclude: new Set(["b"]) },
		);
		expect(picked.map((a) => a.id)).toEqual(["a", "c"]);
	});

	it("caps the batch, preserving input order (earliest imports first)", () => {
		const assets = ["a", "b", "c", "d", "e"].map((id) => asset({ id }));
		const picked = selectUnderstandingCandidates(assets, { cap: 3 });
		expect(picked.map((a) => a.id)).toEqual(["a", "b", "c"]);
	});

	it("applies the cap AFTER filtering, so ineligible assets don't eat slots", () => {
		const picked = selectUnderstandingCandidates(
			[
				asset({ id: "aud", type: "audio" }),
				asset({ id: "skip" }),
				asset({ id: "a" }),
				asset({ id: "b" }),
			],
			{ exclude: new Set(["skip"]), cap: 2 },
		);
		expect(picked.map((a) => a.id)).toEqual(["a", "b"]);
	});

	it("returns everything eligible when no cap is given (demand-driven path)", () => {
		const assets = Array.from(
			{ length: UNDERSTANDING_AUTORUN_TICK_CAP + 5 },
			(_, i) => asset({ id: `m${i}` }),
		);
		expect(selectUnderstandingCandidates(assets)).toHaveLength(
			UNDERSTANDING_AUTORUN_TICK_CAP + 5,
		);
	});

	it("cap of 0 selects nothing", () => {
		expect(selectUnderstandingCandidates([asset()], { cap: 0 })).toHaveLength(
			0,
		);
	});
});
