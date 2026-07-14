import { afterEach, describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { usePersonaStore } from "@/stores/persona-store";
import { createDirectorApi } from "./director-api";
import type { AssetUnderstanding } from "./asset-manifest";

/**
 * Integration tests for Flow B (propose-first) over a real `DirectorApi` on an
 * in-memory editor: proposeReel GROUNDS citations against the live media library
 * (a fabricated id is repaired to generate), reviseProposal re-plans one line
 * stably, and acceptProposal materializes library shots as clips + generate shots
 * as slots and persists the plan to the Project Bible.
 */

interface FakeAsset {
	id: string;
	name: string;
	type: "image" | "video" | "audio";
	url?: string;
	duration?: number;
}

function makeEditor(assets: FakeAsset[]): {
	editor: EditorCore;
	elements: Array<Record<string, unknown>>;
} {
	const elements: Array<Record<string, unknown>> = [];
	const tracks = [{ id: "track_1", elements }];
	let counter = 0;
	const editor = {
		timeline: {
			getTotalDuration: () =>
				elements.reduce(
					(max, e) =>
						Math.max(max, (e.startTime as number) + (e.duration as number)),
					0,
				),
			getTracks: () => tracks,
			addGenerativeSlot: ({
				spec,
				duration,
				startTime,
			}: {
				spec: unknown;
				duration: number;
				startTime?: number;
			}) => {
				const id = `slot_${++counter}`;
				elements.push({
					id,
					type: "video",
					generation: spec,
					duration,
					startTime: startTime ?? 0,
					takes: [],
				});
				return id;
			},
			insertElement: ({
				element,
				placement: _placement,
			}: {
				element: Record<string, unknown>;
				placement: unknown;
			}) => {
				const id = (element.id as string) ?? `el_${++counter}`;
				elements.push({ ...element, id });
				return id;
			},
		},
		command: new CommandManager(),
		media: {
			getAssetById: (id: string) => assets.find((a) => a.id === id),
			getAssets: () => assets,
		},
		project: {
			getActiveOrNull: () => null,
			getDirectorBrief: () => ({}),
			setDirectorBrief: () => {},
			getProjectBible: () => bible,
			setProjectBible: ({ bible: b }: { bible: unknown }) => {
				bible = b;
			},
		},
	} as unknown as EditorCore;
	let bible: unknown;
	return { editor, elements };
}

const UNDERSTANDING: Record<string, AssetUnderstanding> = {
	m_rooftop: {
		mediaId: "m_rooftop",
		role: "b-roll",
		caption: "rooftop b-roll, dusk",
	},
	m_hero: {
		mediaId: "m_hero",
		role: "hero",
		caption: "product on marble",
	},
};

const ASSETS: FakeAsset[] = [
	{
		id: "m_rooftop",
		name: "rooftop.mp4",
		type: "video",
		url: "https://x/r.mp4",
	},
	{ id: "m_hero", name: "packshot.mp4", type: "video", url: "https://x/h.mp4" },
];

afterEach(() => {
	usePersonaStore.setState({ personas: [], activePersonaId: null });
});

describe("proposeReel — grounded draft", () => {
	it("validates real citations and REPAIRS a fabricated one to generate", () => {
		const { editor } = makeEditor(ASSETS);
		const director = createDirectorApi(editor, {
			understanding: (id) => UNDERSTANDING[id],
		});

		const res = director.proposeReel({
			shots: [
				{
					source: "library",
					citation: { mediaId: "m_rooftop" },
					importance: "broll",
					prompt: "",
				},
				{
					source: "library",
					citation: { mediaId: "m_HALLUCINATED" },
					importance: "broll",
					prompt: "",
				},
				{ source: "generate", prompt: "founder to camera" },
			],
		});

		expect(res.ok).toBe(true);
		const proposal = res.data?.proposal;
		expect(proposal).toBeDefined();
		// Shot 1 grounded from the understanding store.
		expect(proposal?.shots[0].source).toBe("library");
		expect(proposal?.shots[0].citation?.caption).toBe("rooftop b-roll, dusk");
		expect(proposal?.shots[0].citation?.ref).toBe("#1");
		// Shot 2 fabricated → repaired to generate, no citation.
		expect(proposal?.shots[1].source).toBe("generate");
		expect(proposal?.shots[1].citation).toBeUndefined();
		expect(proposal?.repairs).toHaveLength(1);
		expect(proposal?.repairs[0].citedMediaId).toBe("m_HALLUCINATED");
		// Nothing placed on the timeline yet — it's just a draft.
		expect(director.getReel().slots).toHaveLength(0);
	});

	it("grounds even without the Understanding Pass (existence is the media store)", () => {
		const { editor } = makeEditor(ASSETS);
		const director = createDirectorApi(editor); // no understanding lookup

		const res = director.proposeReel({
			shots: [
				{ source: "library", citation: { mediaId: "m_hero" }, prompt: "" },
			],
		});
		const c = res.data?.proposal.shots[0].citation;
		expect(res.data?.proposal.shots[0].source).toBe("library");
		expect(c?.mediaId).toBe("m_hero");
		expect(c?.ref).toBe("#2");
		// No caption (no understanding), but still a valid, grounded citation.
		expect(c?.caption).toBeUndefined();
	});
});

describe("reviseProposal — single-line re-plan", () => {
	it("re-plans one shot and rejects a fabricated swap-in", () => {
		const { editor } = makeEditor(ASSETS);
		const director = createDirectorApi(editor, {
			understanding: (id) => UNDERSTANDING[id],
		});
		director.proposeReel({
			shots: [
				{ source: "library", citation: { mediaId: "m_rooftop" }, prompt: "" },
				{ source: "generate", prompt: "shot two" },
			],
		});

		const good = director.reviseProposal({
			index: 2,
			source: "library",
			citation: { mediaId: "m_hero" },
		});
		expect(good.ok).toBe(true);
		expect(good.data?.proposal.shots[1].source).toBe("library");
		expect(good.data?.proposal.shots[1].citation?.caption).toBe(
			"product on marble",
		);
		// Shot 1 untouched.
		expect(good.data?.proposal.shots[0].citation?.mediaId).toBe("m_rooftop");

		const bad = director.reviseProposal({
			index: 2,
			citation: { mediaId: "m_NOPE" },
		});
		expect(bad.data?.proposal.shots[1].source).toBe("generate");
		expect(bad.data?.proposal.shots[1].citation).toBeUndefined();
	});

	it("fails when there is no pending draft", () => {
		const { editor } = makeEditor(ASSETS);
		const director = createDirectorApi(editor);
		const res = director.reviseProposal({ index: 1, prompt: "x" });
		expect(res.ok).toBe(false);
	});
});

describe("acceptProposal — materialization", () => {
	it("places library shots as clips and generate shots as slots, then persists the plan", () => {
		const { editor, elements } = makeEditor(ASSETS);
		const director = createDirectorApi(editor, {
			understanding: (id) => UNDERSTANDING[id],
		});

		director.proposeReel({
			bible: { palette: "warm amber" },
			shots: [
				{
					source: "library",
					citation: { mediaId: "m_rooftop" },
					importance: "broll",
					prompt: "",
				},
				{
					source: "generate-to-match",
					citation: { mediaId: "m_hero" },
					importance: "hero",
					prompt: "hero packshot, warm",
				},
				{ source: "generate", prompt: "founder to camera", duration: 5 },
			],
		});

		const res = director.acceptProposal();
		expect(res.ok).toBe(true);
		expect(res.data?.elementIds).toHaveLength(3);

		// One plain clip (library) + two generative slots (generate + g2m).
		const slots = elements.filter((e) => e.generation);
		expect(slots).toHaveLength(2);
		const clips = elements.filter((e) => !e.generation);
		expect(clips).toHaveLength(1);
		expect((clips[0] as { mediaId?: string }).mediaId).toBe("m_rooftop");

		// generate-to-match attached the cited asset as an omni-reference (its look).
		const g2m = slots.find(
			(s) =>
				(s.generation as { prompt?: string }).prompt === "hero packshot, warm",
		);
		expect(g2m).toBeDefined();
		const g2mGen = g2m?.generation as { referenceImages?: string[] };
		expect(g2mGen.referenceImages).toEqual(["https://x/h.mp4"]);

		// The accepted plan is persisted and read back off getReel().
		const reel = director.getReel();
		expect(reel.plan?.shotCount).toBe(3);
		// Consistency context seeded from the bible.
		expect(reel.consistency).toBeDefined();
		// Draft consumed.
		expect(director.getProposal().data).toBeUndefined();
	});

	it("fails when there is no pending draft", () => {
		const { editor } = makeEditor(ASSETS);
		const director = createDirectorApi(editor);
		expect(director.acceptProposal().ok).toBe(false);
	});
});
