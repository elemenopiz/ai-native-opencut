import { describe, expect, it } from "bun:test";
import type { AssetUnderstanding } from "@/lib/search/asset-understanding";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import type { AssetBeatGrid, AssetBeatGridLookup } from "../asset-manifest";
import type { AssetTranscriptLookup } from "../transcript-lookup";
import {
	buildFootageInventory,
	type AssetUnderstandingCanonicalLookup,
	type SilenceMapLookup,
} from "./inventory";
import type { InventoryMediaAsset } from "./types";

/**
 * `buildFootageInventory` is the ONLY stage SE-1 implements (design doc §2:
 * deterministic, no model calls). These tests pin: (a) the `speechShare`
 * formula's edge cases exactly as documented on `FootageInventory.speechShare`
 * in `types.ts`, (b) full determinism, and (c) that the function reads
 * NOTHING beyond its `input` argument — no store, no global, no module-level
 * state — by constructing every fixture inline and never importing a
 * store/service module here.
 */

function transcript(
	segments: { start: number; end: number; text: string }[],
): AssetTranscript {
	return {
		mediaId: "unused",
		segments,
		language: "en",
		durationSec: 0,
		engine: "test",
		createdAt: 0,
	};
}

function understanding(
	overrides: Partial<AssetUnderstanding> = {},
): AssetUnderstanding {
	return {
		mediaId: "unused",
		caption: "a clip",
		role: "b-roll",
		roleConfidence: 0.5,
		tags: [],
		faces: [],
		modelName: "test",
		createdAt: 0,
		...overrides,
	};
}

function lookupFrom<T>(
	byId: Record<string, T | undefined>,
): (id: string) => T | undefined {
	return (id: string) => byId[id];
}

describe("buildFootageInventory", () => {
	it("empty library: speechShare = 0 by definition, not a 0/0 fallback", () => {
		const inv = buildFootageInventory({ assets: [] });
		expect(inv).toEqual({
			assets: [],
			totalDurationSec: 0,
			speechShare: 0,
			untranscribedCount: 0,
		});
	});

	it("all-speech: every asset transcribed with real speech ⇒ speechShare = 1", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "a", kind: "video", durationSec: 10 },
			{ id: "b", kind: "video", durationSec: 20 },
		];
		const transcripts: AssetTranscriptLookup = lookupFrom({
			a: transcript([{ start: 0, end: 1, text: "hello" }]),
			b: transcript([{ start: 0, end: 1, text: "world" }]),
		});
		const inv = buildFootageInventory({ assets, transcripts });
		expect(inv.totalDurationSec).toBe(30);
		expect(inv.speechShare).toBe(1);
		expect(inv.untranscribedCount).toBe(0);
		expect(inv.assets.every((a) => a.hasTranscriptSegments === true)).toBe(
			true,
		);
	});

	it("mixed: half speech, half silent-but-transcribed ⇒ speechShare reflects only the speech half", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "a", kind: "video", durationSec: 10 }, // speech
			{ id: "b", kind: "video", durationSec: 10 }, // transcribed, silent
		];
		const transcripts: AssetTranscriptLookup = lookupFrom({
			a: transcript([{ start: 0, end: 1, text: "hello" }]),
			b: transcript([]), // transcribed, no speech found — a REAL answer
		});
		const inv = buildFootageInventory({ assets, transcripts });
		expect(inv.speechShare).toBe(0.5);
		expect(inv.untranscribedCount).toBe(0); // both were checked — neither is "possibly" anything
		const byId = new Map(inv.assets.map((a) => [a.id, a]));
		expect(byId.get("a")?.hasTranscriptSegments).toBe(true);
		expect(byId.get("b")?.hasTranscriptSegments).toBe(false);
		expect(byId.get("b")?.possiblyUntranscribed).toBe(false);
	});

	it("untranscribed speech-bearing media: no transcript record ⇒ possiblyUntranscribed, counted as non-speech (never guessed)", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "video-untranscribed", kind: "video", durationSec: 10 },
			{ id: "audio-untranscribed", kind: "audio", durationSec: 5 },
		];
		// No `transcripts` lookup supplied at all.
		const inv = buildFootageInventory({ assets });
		expect(inv.speechShare).toBe(0);
		expect(inv.untranscribedCount).toBe(2);
		expect(inv.assets.every((a) => a.hasTranscriptSegments === undefined)).toBe(
			true,
		);
		expect(inv.assets.every((a) => a.possiblyUntranscribed === true)).toBe(
			true,
		);
	});

	it("images are never flagged possiblyUntranscribed, even with no transcript lookup", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "img", kind: "image", durationSec: 3 },
		];
		const inv = buildFootageInventory({ assets });
		expect(inv.assets[0].possiblyUntranscribed).toBe(false);
		expect(inv.assets[0].hasTranscriptSegments).toBeUndefined();
	});

	it("unprobed/invalid durationSec resolves to 0, never NaN/undefined in aggregates", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "a", kind: "video", durationSec: undefined },
			{ id: "b", kind: "video", durationSec: -5 },
			{ id: "c", kind: "video", durationSec: Number.NaN },
			{ id: "d", kind: "video", durationSec: 10 },
		];
		const inv = buildFootageInventory({ assets });
		expect(inv.totalDurationSec).toBe(10);
		expect(inv.assets.map((a) => a.durationSec)).toEqual([0, 0, 0, 10]);
		expect(Number.isFinite(inv.speechShare)).toBe(true);
	});

	it("understanding + deep-understanding presence flags, via the canonical isDeepUnderstanding contract", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "none", kind: "video", durationSec: 1 },
			{ id: "shallow", kind: "video", durationSec: 1 },
			{ id: "deep", kind: "video", durationSec: 1 },
		];
		const understandingLookup: AssetUnderstandingCanonicalLookup = lookupFrom({
			shallow: understanding(), // no shotType ⇒ shallow
			// `shotType` alone is the deep signal — `motion` is measured outside the
			// model call now and is legitimately absent on stills, so requiring it
			// would mark those permanently shallow. See `isDeepUnderstanding`.
			deep: understanding({ shotType: "medium" }),
		});
		const inv = buildFootageInventory({
			assets,
			understanding: understandingLookup,
		});
		const byId = new Map(inv.assets.map((a) => [a.id, a]));
		expect(byId.get("none")).toMatchObject({
			hasUnderstanding: false,
			hasDeepUnderstanding: false,
		});
		expect(byId.get("shallow")).toMatchObject({
			hasUnderstanding: true,
			hasDeepUnderstanding: false,
		});
		expect(byId.get("deep")).toMatchObject({
			hasUnderstanding: true,
			hasDeepUnderstanding: true,
		});
	});

	it("beat-grid and silence-map presence flags degrade to false when absent", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "a", kind: "audio", durationSec: 1 },
			{ id: "b", kind: "audio", durationSec: 1 },
		];
		const grid: AssetBeatGrid = { bpm: 120, beatCount: 40, downbeatCount: 10 };
		const beatGrid: AssetBeatGridLookup = lookupFrom({ a: grid });
		const silenceMap: SilenceMapLookup = lookupFrom({ a: true, b: false });

		const inv = buildFootageInventory({ assets, beatGrid, silenceMap });
		const byId = new Map(inv.assets.map((x) => [x.id, x]));
		expect(byId.get("a")?.hasBeatGrid).toBe(true);
		expect(byId.get("b")?.hasBeatGrid).toBe(false);
		expect(byId.get("a")?.hasSilenceMap).toBe(true);
		expect(byId.get("b")?.hasSilenceMap).toBe(false);
	});

	it("no lookups supplied at all: every row degrades gracefully, no crash", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "a", kind: "video", durationSec: 5 },
			{ id: "b", kind: "image", durationSec: 2 },
		];
		const inv = buildFootageInventory({ assets });
		for (const a of inv.assets) {
			expect(a.hasBeatGrid).toBe(false);
			expect(a.hasUnderstanding).toBe(false);
			expect(a.hasDeepUnderstanding).toBe(false);
			expect(a.hasSilenceMap).toBe(false);
		}
	});

	it("is deterministic: same input twice ⇒ deep-equal output", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "a", kind: "video", durationSec: 10 },
			{ id: "b", kind: "audio", durationSec: 4 },
			{ id: "c", kind: "image", durationSec: 2 },
		];
		const transcripts: AssetTranscriptLookup = lookupFrom({
			a: transcript([{ start: 0, end: 1, text: "hi" }]),
		});
		const understandingLookup: AssetUnderstandingCanonicalLookup = lookupFrom({
			c: understanding({ motion: "static", shotType: "wide" }),
		});
		const beatGrid: AssetBeatGridLookup = lookupFrom({
			b: { bpm: 100, beatCount: 20, downbeatCount: 5 },
		});
		const silenceMap: SilenceMapLookup = lookupFrom({ a: true });

		const input = {
			assets,
			transcripts,
			understanding: understandingLookup,
			beatGrid,
			silenceMap,
		};
		const first = buildFootageInventory(input);
		const second = buildFootageInventory(input);
		expect(second).toEqual(first);

		// Re-running against freshly-built (but equivalent) fixtures also matches —
		// pins that the function has no hidden internal state carried between calls.
		const third = buildFootageInventory({
			assets: [...assets],
			transcripts,
			understanding: understandingLookup,
			beatGrid,
			silenceMap,
		});
		expect(third).toEqual(first);
	});

	it("asset order in the output mirrors input order (stable, no implicit sort)", () => {
		const assets: InventoryMediaAsset[] = [
			{ id: "z", kind: "video", durationSec: 1 },
			{ id: "a", kind: "video", durationSec: 1 },
			{ id: "m", kind: "video", durationSec: 1 },
		];
		const inv = buildFootageInventory({ assets });
		expect(inv.assets.map((a) => a.id)).toEqual(["z", "a", "m"]);
	});
});
