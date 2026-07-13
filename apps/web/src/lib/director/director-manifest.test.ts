import { afterEach, describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { usePersonaStore } from "@/stores/persona-store";
import { createDirectorApi } from "./director-api";
import type {
	AssetUnderstanding,
	AssetUnderstandingLookup,
} from "./asset-manifest";

/**
 * `getProjectInfo` (Tier-0 grounding, folded into the agent's system prompt) and
 * the `getLibraryManifest` verb both surface the faceted library manifest. These
 * tests wire the manifest through a real `DirectorApi` over an in-memory editor —
 * once WITHOUT the Understanding Pass (graceful fallback) and once WITH an
 * injected lookup (grounded, role-aware digest) — proving the feature ships and
 * is testable independently of the sibling agent.
 */

function mediaAsset(
	id: string,
	name: string,
	type: "image" | "video" | "audio",
	extra?: {
		width?: number;
		height?: number;
		duration?: number;
		source?: "ai";
	},
) {
	return {
		id,
		name,
		type,
		file: new File([new Uint8Array([1])], name),
		...extra,
	};
}

/** Optional active-project settings (canvas size) to exercise the ORIENTATION-MISMATCH facet. */
function makeEditor(
	assets: ReturnType<typeof mediaAsset>[],
	canvasSize?: { width: number; height: number },
): EditorCore {
	return {
		timeline: {
			getTotalDuration: () => 0,
			getTracks: () => [{ id: "track_1", elements: [] }],
		},
		command: { canUndo: () => false, canRedo: () => false },
		media: {
			getAssetById: (id: string) => assets.find((a) => a.id === id),
			getAssets: () => assets,
		},
		project: {
			getActiveOrNull: () =>
				canvasSize ? { settings: { fps: 30, canvasSize } } : null,
		},
	} as unknown as EditorCore;
}

afterEach(() => {
	usePersonaStore.setState({ personas: [], activePersonaId: null });
});

describe("getProjectInfo — manifest grounding", () => {
	it("carries a media-type fallback manifest when no Understanding Pass is wired", () => {
		const editor = makeEditor([
			mediaAsset("m1", "a.mp4", "video"),
			mediaAsset("m2", "b.mp4", "video"),
			mediaAsset("m3", "logo.png", "image"),
		]);
		const director = createDirectorApi(editor);

		const info = director.getProjectInfo().data;
		expect(info?.assetCount).toBe(3);
		expect(info?.manifest.grounded).toBe(false);
		expect(info?.manifest.typeCounts).toEqual({ video: 2, image: 1 });
		expect(info?.manifest.digest).toContain(
			"LIBRARY (3 assets): 2 video · 1 image",
		);
		expect(info?.manifest.digest).toContain("Recent: a.mp4, b.mp4, logo.png");
	});

	it("produces a role-aware digest when the Understanding Pass lookup is injected", () => {
		const editor = makeEditor([
			mediaAsset("m1", "shot1.mp4", "video"),
			mediaAsset("m2", "shot2.mp4", "video"),
			mediaAsset("m3", "shot3.mp4", "video"),
		]);
		const rows: Record<string, AssetUnderstanding> = {
			m1: { mediaId: "m1", role: "hero", caption: "product hero on marble" },
			m2: {
				mediaId: "m2",
				role: "face-anchor",
				faces: [{ personaMatch: "p_mara" }],
			},
			// m3 has no row → b-roll.
		};
		const understanding: AssetUnderstandingLookup = (id) => rows[id];

		usePersonaStore.setState({
			personas: [
				{
					id: "p_mara",
					name: "Mara",
					descriptor: "woman, dark curls",
				} as never,
			],
			activePersonaId: null,
		});

		const director = createDirectorApi(editor, { understanding });
		const info = director.getProjectInfo().data;

		expect(info?.manifest.grounded).toBe(true);
		expect(info?.manifest.roleCounts).toEqual({
			hero: 1,
			"face-anchor": 1,
			"b-roll": 1,
		});
		expect(info?.manifest.digest).toBe(
			'LIBRARY (3 assets): 1 hero · 1 face-anchor (Mara ×1) · 1 b-roll. Heroes: #1 "product hero on marble". 1 more b-roll — searchable via searchMedia.',
		);
	});
});

describe("getLibraryManifest verb", () => {
	it("returns the digest as the message and the structured facets as data", () => {
		const editor = makeEditor([
			mediaAsset("m1", "hero.mp4", "video"),
			mediaAsset("m2", "broll.mp4", "video"),
		]);
		const understanding: AssetUnderstandingLookup = (id) =>
			id === "m1"
				? { mediaId: "m1", role: "hero", caption: "the packshot" }
				: undefined;

		const director = createDirectorApi(editor, { understanding });
		const res = director.getLibraryManifest();

		expect(res.ok).toBe(true);
		const manifest = res.data;
		expect(manifest).toBeDefined();
		if (!manifest) return;
		// The message IS the one-line digest (already in the prompt); data carries facets.
		expect(res.message).toBe(manifest.digest);
		expect(manifest.heroes).toEqual([
			// The stub asset resolves but carries no width/height; no explicit
			// `source` ⇒ "upload" (see director-api.ts's `buildManifest` mapping).
			{ ref: "#1", mediaId: "m1", caption: "the packshot", source: "upload" },
		]);
		expect(manifest.tail).toEqual({ count: 1, role: "b-roll" });
	});

	it("is registered in the shared tool catalog as a read-only verb", async () => {
		const { toolCatalog, scopeForTool } = await import("./tool-catalog");
		const entry = toolCatalog().find((t) => t.name === "getLibraryManifest");
		expect(entry).toBeDefined();
		expect(entry?.mutating).toBe(false);
		expect(scopeForTool("getLibraryManifest")).toBe("reel:read");
	});
});

describe("manifest — dims/provenance/orientation wiring (real MediaAsset → ManifestAsset)", () => {
	it("carries a hero's width/height/durationSec/source through from the real editor asset", () => {
		const editor = makeEditor([
			mediaAsset("m1", "hero.mp4", "video", {
				width: 1920,
				height: 1080,
				duration: 12.5,
				source: "ai",
			}),
			mediaAsset("m2", "broll.mp4", "video"),
		]);
		const understanding: AssetUnderstandingLookup = (id) =>
			id === "m1"
				? { mediaId: "m1", role: "hero", caption: "the packshot" }
				: undefined;

		const director = createDirectorApi(editor, { understanding });
		const manifest = director.getProjectInfo().data?.manifest;

		expect(manifest?.heroes).toEqual([
			{
				ref: "#1",
				mediaId: "m1",
				caption: "the packshot",
				width: 1920,
				height: 1080,
				durationSec: 12.5,
				source: "ai",
				orientation: "16:9",
			},
		]);
	});

	it("appends the orientation-mismatch warning when library assets conflict with the canvas", () => {
		const editor = makeEditor(
			[
				mediaAsset("m1", "a.mp4", "video", { width: 1920, height: 1080 }),
				mediaAsset("m2", "b.mp4", "video", { width: 1920, height: 1080 }),
				mediaAsset("m3", "c.mp4", "video", { width: 1080, height: 1920 }),
			],
			{ width: 1080, height: 1920 }, // portrait canvas
		);
		const director = createDirectorApi(editor);
		const info = director.getProjectInfo().data;

		expect(info?.orientation).toBe("portrait");
		expect(info?.manifest.orientationMismatch).toEqual({
			canvasOrientation: "portrait",
			counts: { landscape: 2 },
			total: 2,
		});
		expect(info?.manifest.digest).toContain(
			"⚠ 2 landscape assets, canvas is portrait.",
		);
	});

	it("adds nothing to the digest when every dimensioned asset matches the canvas orientation", () => {
		const editor = makeEditor(
			[mediaAsset("m1", "a.mp4", "video", { width: 1080, height: 1920 })],
			{ width: 1080, height: 1920 },
		);
		const director = createDirectorApi(editor);
		const info = director.getProjectInfo().data;

		expect(info?.manifest.orientationMismatch).toBeUndefined();
		expect(info?.manifest.digest).not.toContain("⚠");
	});
});
