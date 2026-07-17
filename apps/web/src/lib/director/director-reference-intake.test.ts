import { afterEach, describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import type { DirectorBrief } from "@/types/project";
import { usePersonaStore } from "@/stores/persona-store";
import { createDirectorApi } from "./director-api";
import type { DerivedReference } from "./reference-intake";

/**
 * In-memory `EditorCore` stub for the reference-intake path: a media library of
 * uploaded reference assets, an in-memory durable brief, and no-op timeline. The
 * point under test is that `intakeReferences` turns what the model SEES in the
 * references into the reel's consistency context (STYLE), a locked+activated
 * persona (CHARACTER, seed-lock path), and a durable brief entry (D4) — the
 * "eyes on input → every shot inherits the look/cast" wiring.
 */
function imageAsset(id: string, name: string) {
	// A tiny real File so the verb's arrayBuffer→base64 decode produces a data URL.
	const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10])], name, {
		type: "image/png",
	});
	return { id, name, type: "image" as const, file };
}

function makeEditor(assets: ReturnType<typeof imageAsset>[]): {
	editor: EditorCore;
	readBrief: () => DirectorBrief;
} {
	let brief: DirectorBrief = {};
	const editor = {
		timeline: {
			getTotalDuration: () => 0,
			getTracks: () => [{ id: "track_1", elements: [] }],
		},
		command: new CommandManager(),
		media: {
			getAssetById: (id: string) => assets.find((a) => a.id === id),
			getAssets: () => assets,
		},
		project: {
			getActiveOrNull: () => null,
			getDirectorBrief: () => brief,
			setDirectorBrief: ({ brief: next }: { brief: DirectorBrief }) => {
				brief = next;
			},
		},
	} as unknown as EditorCore;
	return { editor, readBrief: () => brief };
}

/** A style-only derivation (a mood board — no lockable character). */
const STYLE_ONLY: DerivedReference = {
	style: {
		palette: "bleached teal + faded orange",
		lensMood: "16mm grain, handheld",
		setting: "empty boardwalk, golden hour",
	},
	summary: "a sun-bleached seaside film look",
};

/** A derivation that also carries a lockable persona (a character photo). */
const WITH_PERSONA: DerivedReference = {
	style: { lensMood: "soft studio portrait light" },
	persona: {
		name: "Mara",
		descriptor: "woman, early 30s, dark curls, silver hoops",
		anchorIndex: 1,
	},
	summary: "studio portrait of Mara",
};

afterEach(() => {
	usePersonaStore.setState({ personas: [], activePersonaId: null });
});

describe("intakeReferences — style derivation", () => {
	it("seeds the reel consistency context from the derived StyleBible", async () => {
		const { editor } = makeEditor([imageAsset("m1", "board.png")]);
		const director = createDirectorApi(editor, {
			references: { derive: async () => STYLE_ONLY },
		});

		const res = await director.intakeReferences({ mediaIds: ["m1"] });

		expect(res.ok).toBe(true);
		expect(res.data?.styleApplied).toBe(true);
		// Ready for a direct storyboard({ bible }) handoff.
		expect(res.data?.bible).toEqual(STYLE_ONLY.style);

		const ctx = director.getConsistencyContext().data;
		expect(ctx?.style).toBe(
			"bleached teal + faded orange; 16mm grain, handheld",
		);
		expect(ctx?.setting).toBe("empty boardwalk, golden hour");
	});

	it("records the derived look on the durable brief (D4)", async () => {
		const { editor, readBrief } = makeEditor([imageAsset("m1", "board.png")]);
		const director = createDirectorApi(editor, {
			references: { derive: async () => STYLE_ONLY },
		});

		await director.intakeReferences({ mediaIds: ["m1"] });

		const brief = readBrief();
		expect(brief.styleNote).toBe(
			"bleached teal + faded orange; 16mm grain, handheld; empty boardwalk, golden hour",
		);
		expect(brief.notes?.[0]).toContain("a sun-bleached seaside film look");
	});

	it("passes the actual decoded reference images to the model", async () => {
		const { editor } = makeEditor([
			imageAsset("m1", "a.png"),
			imageAsset("m2", "b.png"),
		]);
		let seenImages: string[] = [];
		const director = createDirectorApi(editor, {
			references: {
				derive: async (images) => {
					seenImages = images;
					return STYLE_ONLY;
				},
			},
		});

		await director.intakeReferences({
			mediaIds: ["m1", "m2"],
			hint: "match this",
		});

		expect(seenImages).toHaveLength(2);
		expect(seenImages.every((i) => i.startsWith("data:image/"))).toBe(true);
	});
});

describe("intakeReferences — persona (seed-lock path)", () => {
	it("locks & activates a persona from the character and folds it into consistency", async () => {
		const { editor } = makeEditor([
			imageAsset("m1", "wide.png"),
			imageAsset("m2", "face.png"),
		]);
		const created: { anchorImageUrl: string; refImageUrls?: string[] }[] = [];
		const uploaded: string[] = [];
		const director = createDirectorApi(editor, {
			references: {
				derive: async () => WITH_PERSONA,
				uploadAnchor: async (file) => {
					const url = `https://cdn.test/${file.name}`;
					uploaded.push(url);
					return url;
				},
				createPersona: async (input) => {
					created.push(input);
					const persona = {
						id: "persona_mara",
						name: input.name,
						descriptor: input.descriptor,
						anchorImageUrl: input.anchorImageUrl,
						refImageUrls: input.refImageUrls ?? [],
						seed: input.seed ?? null,
						createdAt: "2026-07-10",
					};
					// Mimic the real store.create side effect so the consistency re-pull sees it.
					usePersonaStore.setState((s) => ({
						personas: [persona, ...s.personas],
					}));
					return { id: persona.id };
				},
			},
		});

		const res = await director.intakeReferences({
			mediaIds: ["m1", "m2"],
			seed: 42,
		});

		expect(res.ok).toBe(true);
		expect(res.data?.personaId).toBe("persona_mara");

		// anchorIndex 1 (the face) became the anchor; the wide shot rode along as a ref.
		expect(created).toHaveLength(1);
		expect(created[0].anchorImageUrl).toBe("https://cdn.test/face.png");
		expect(created[0].refImageUrls).toEqual(["https://cdn.test/wide.png"]);

		// The persona is now the active identity threaded through generation.
		expect(usePersonaStore.getState().activePersonaId).toBe("persona_mara");

		// And it appears as a reel-level character (descriptor + persona id) so every
		// shot's generate call keeps that face.
		const mara = director
			.getConsistencyContext()
			.data?.characters.find((c) => c.name === "Mara");
		expect(mara?.descriptor).toBe("woman, early 30s, dark curls, silver hoops");
		expect(mara?.personaId).toBe("persona_mara");
	});

	it("honors createPersona:false — derives STYLE but never locks a character", async () => {
		const { editor } = makeEditor([imageAsset("m1", "face.png")]);
		let personaCreated = false;
		const director = createDirectorApi(editor, {
			references: {
				derive: async () => WITH_PERSONA,
				createPersona: async () => {
					personaCreated = true;
					return { id: "x" };
				},
			},
		});

		const res = await director.intakeReferences({
			mediaIds: ["m1"],
			createPersona: false,
		});

		expect(res.ok).toBe(true);
		expect(personaCreated).toBe(false);
		expect(res.data?.personaId).toBeUndefined();
		// Style still applied.
		expect(director.getConsistencyContext().data?.style).toBe(
			"soft studio portrait light",
		);
	});

	it("overrides the derived persona name when personaName is given", async () => {
		const { editor } = makeEditor([imageAsset("m1", "face.png")]);
		let createdName = "";
		const director = createDirectorApi(editor, {
			references: {
				derive: async () => WITH_PERSONA,
				uploadAnchor: async () => "https://cdn.test/face.png",
				createPersona: async (input) => {
					createdName = input.name;
					return { id: "p1" };
				},
			},
		});

		await director.intakeReferences({
			mediaIds: ["m1"],
			personaName: "The Founder",
		});

		expect(createdName).toBe("The Founder");
	});
});

describe("intakeReferences — guards", () => {
	it("fails with actionable copy when no mediaIds are given", async () => {
		const { editor } = makeEditor([]);
		const director = createDirectorApi(editor, {
			references: { derive: async () => STYLE_ONLY },
		});
		const res = await director.intakeReferences({ mediaIds: [] });
		expect(res.ok).toBe(false);
		expect(res.message).toContain("at least one reference");
	});

	it("fails when none of the mediaIds resolve to a decodable asset", async () => {
		const { editor } = makeEditor([imageAsset("m1", "a.png")]);
		let derived = false;
		const director = createDirectorApi(editor, {
			references: {
				derive: async () => {
					derived = true;
					return STYLE_ONLY;
				},
			},
		});
		const res = await director.intakeReferences({ mediaIds: ["missing"] });
		expect(res.ok).toBe(false);
		expect(res.message).toContain("Couldn't decode");
		// The model is never called if there's nothing to show it.
		expect(derived).toBe(false);
	});

	it("reports unresolved ids but still proceeds on the ones that decode", async () => {
		const { editor } = makeEditor([imageAsset("m1", "a.png")]);
		const director = createDirectorApi(editor, {
			references: { derive: async () => STYLE_ONLY },
		});
		const res = await director.intakeReferences({
			mediaIds: ["m1", "ghost"],
		});
		expect(res.ok).toBe(true);
		expect(res.data?.imageCount).toBe(1);
		expect(res.data?.missingMediaIds).toEqual(["ghost"]);
	});

	it("surfaces a model/relay failure as a clean fail (no throw)", async () => {
		const { editor } = makeEditor([imageAsset("m1", "a.png")]);
		const director = createDirectorApi(editor, {
			references: {
				derive: async () => {
					throw new Error("relay 503");
				},
			},
		});
		const res = await director.intakeReferences({ mediaIds: ["m1"] });
		expect(res.ok).toBe(false);
		expect(res.message).toContain("relay 503");
	});
});
