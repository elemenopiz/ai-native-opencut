import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import type { DirectorBrief } from "@/types/project";
import type { GenerationSpec, Take } from "@/types/timeline";
import type { GenerateExecutor } from "./types";
import { createDirectorApi } from "./director-api";
import {
	createVisionTakeCritic,
	type VisionRelay,
} from "./take-critic-adapter";

/**
 * End-to-end coverage of the REAL vision-critic adapter driving `compareTake`'s
 * auto-pick: `createVisionTakeCritic` runs its actual logic (frame gate → label
 * map → prompt build → parse → take-id map); only the model round-trip (relay)
 * and the frame decode are stubbed. Verifies the winner is selected AND the
 * rationale is folded into the durable brief, plus the graceful-degradation
 * fallbacks (relay error / too-few-frames / no-pick → present both takes).
 */

const FRAME = "data:image/jpeg;base64,AAAA";

function baseSpec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
	return {
		prompt: "a lone astronaut on a red dune",
		mode: "text-to-video",
		resolution: "720p",
		orientation: "landscape",
		duration: 6,
		...overrides,
	};
}

interface StubElement {
	id: string;
	type: "video";
	generation: GenerationSpec;
	takes: Take[];
	activeTakeId?: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
}

/** Editor stub with the take bookkeeping, a media resolver, and a brief store. */
function makeEditor(slots: { id: string; generation: GenerationSpec }[]) {
	const elements: StubElement[] = slots.map((s) => ({
		id: s.id,
		type: "video",
		generation: s.generation,
		takes: [],
		activeTakeId: undefined,
		startTime: 0,
		duration: s.generation.duration,
		trimStart: 0,
		trimEnd: 0,
	}));
	const track = { id: "track1", elements };
	const find = (id: string) => elements.find((e) => e.id === id);
	let brief: DirectorBrief = {};

	const editor = {
		timeline: {
			getTracks: () => [track],
			getTotalDuration: () => 6,
			addTakeToElement: ({
				elementId,
				take,
			}: {
				elementId: string;
				take: Take;
			}) => {
				const el = find(elementId);
				if (el) el.takes = [...el.takes, take];
			},
			updateTake: ({
				elementId,
				takeId,
				patch,
			}: {
				elementId: string;
				takeId: string;
				patch: Partial<Take>;
			}) => {
				const el = find(elementId);
				if (el)
					el.takes = el.takes.map((t) =>
						t.id === takeId ? { ...t, ...patch } : t,
					);
			},
			selectTake: ({
				elementId,
				takeId,
			}: {
				elementId: string;
				takeId: string;
			}) => {
				const el = find(elementId);
				if (el) el.activeTakeId = takeId;
			},
		},
		media: {
			// Every take imports to a video asset, so the adapter's decode path runs.
			getAssetById: (id: string) => ({ type: "video", url: `blob:${id}` }),
		},
		project: {
			getDirectorBrief: () => brief,
			setDirectorBrief: ({ brief: next }: { brief: DirectorBrief }) => {
				brief = next;
			},
		},
		command: {
			canUndo: () => false,
			canRedo: () => false,
			beginTransaction: () => {},
			commitTransaction: () => {},
			rollbackTransaction: () => {},
		},
	} as unknown as EditorCore;

	return { editor, elements, getBrief: () => brief };
}

/** An executor that renders every take ready with a stable mediaId. */
function readyExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId }) => ({
			status: "ready",
			mediaId: `media-${takeId}`,
		}),
	};
}

describe("compareTake × real vision-critic adapter", () => {
	it("picks the critic's winner and records the rationale in the brief", async () => {
		const { editor, elements, getBrief } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);

		// Real adapter: real logic, stubbed model call + frame decode. The relay
		// always names candidate "B" (the second take) as the winner.
		const relayCalls: { system: string }[] = [];
		const relay: VisionRelay = async ({ system, content }) => {
			relayCalls.push({ system });
			// Sanity: the adapter must actually attach image blocks for both takes.
			const imageBlocks = content.filter((b) => b.type === "image");
			expect(imageBlocks.length).toBeGreaterThanOrEqual(2);
			return '{"winner":"B","reason":"B is sharper and on-brief"}';
		};
		const critic = createVisionTakeCritic({
			relay,
			extractFrames: async () => [FRAME, FRAME],
		});

		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			critic,
		});

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		// Winner is the second take, and it is force-selected on the reel.
		expect(res.data?.autoPicked).toBe(true);
		expect(res.data?.winner).toBe(res.data?.takeIds[1]);
		expect(elements[0].activeTakeId).toBe(res.data?.winner);
		expect(relayCalls).toHaveLength(1);

		// The rationale rides into the result message …
		expect(res.message).toMatch(/sharper and on-brief/i);

		// … and is folded into the durable brief so future shots learn from it,
		// tagged with the WINNING backend.
		const notes = getBrief().notes ?? [];
		expect(notes.some((n) => /A\/B auto-pick/i.test(n))).toBe(true);
		expect(notes.some((n) => /backend "backend-b" won/.test(n))).toBe(true);
		expect(notes.some((n) => /sharper and on-brief/i.test(n))).toBe(true);
	});

	it("falls back to presenting both takes when the relay call fails", async () => {
		const { editor, elements, getBrief } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);
		const critic = createVisionTakeCritic({
			relay: async () => {
				throw new Error("relay down");
			},
			extractFrames: async () => [FRAME, FRAME],
		});
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			critic,
		});

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(false);
		expect(res.data?.winner).toBeUndefined();
		expect(elements[0].activeTakeId).toBeUndefined();
		expect(getBrief().notes ?? []).toHaveLength(0);
	});

	it("presents both takes when fewer than two candidates yield frames", async () => {
		const { editor, elements } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);
		let call = 0;
		const critic = createVisionTakeCritic({
			relay: async () => '{"winner":"A"}',
			// Only the first take decodes; the second yields nothing → can't compare.
			extractFrames: async () => (call++ === 0 ? [FRAME] : []),
		});
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			critic,
		});

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(false);
		expect(elements[0].activeTakeId).toBeUndefined();
	});

	it("presents both takes when the critic reply names no valid winner", async () => {
		const { editor, elements } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);
		const critic = createVisionTakeCritic({
			relay: async () => '{"winner":null,"reason":"too close to call"}',
			extractFrames: async () => [FRAME, FRAME],
		});
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			critic,
		});

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(false);
		expect(elements[0].activeTakeId).toBeUndefined();
	});
});
