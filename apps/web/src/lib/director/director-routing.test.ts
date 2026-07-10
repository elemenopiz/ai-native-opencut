import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import type { GenerationSpec, Take } from "@/types/timeline";
import type {
	BackendCatalogEntry,
	GenerateExecutor,
	TakeCritic,
} from "./types";
import { createDirectorApi } from "./director-api";

/**
 * Coverage for the cost/quality-aware model-routing policy the Director layers on
 * top of the backend router:
 *  - a `backendId` on generate/reroll pins the take's `spec.model` (the field the
 *    studio pipeline forwards to `/api/studio/generate`, where routeSlot honors it),
 *  - `compareTake` renders one take per backend and either auto-picks with a
 *    vision critic (D1) or presents both takes when none is wired,
 *  - `getBackends` reads through the injected catalog provider.
 *
 * The editor is a minimal in-memory stub implementing only the timeline take
 * bookkeeping these verbs touch, so locateSlots/captureReel see live mutations.
 */

function baseSpec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
	return {
		prompt: "a wide desert landscape",
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
		command: {
			canUndo: () => false,
			canRedo: () => false,
			beginTransaction: () => {},
			commitTransaction: () => {},
			rollbackTransaction: () => {},
		},
	} as unknown as EditorCore;

	return { editor, elements };
}

/** An executor that records the specs it ran and returns a ready take each time. */
function recordingExecutor() {
	const runs: { spec: GenerationSpec; takeId: string }[] = [];
	const executor: GenerateExecutor = {
		run: async ({ spec, takeId }) => {
			runs.push({ spec, takeId });
			return { status: "ready", mediaId: `media-${takeId}` };
		},
	};
	return { executor, runs };
}

describe("generate/reroll backendId pin", () => {
	it("threads generate's backendId onto every take's spec.model", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { executor, runs } = recordingExecutor();
		const director = createDirectorApi(editor, { executor });

		await director.generate({
			slotIds: ["s1"],
			alternatives: 2,
			backendId: "premium-x",
		});

		expect(runs).toHaveLength(2);
		expect(runs.every((r) => r.spec.model === "premium-x")).toBe(true);
	});

	it("leaves spec.model unset when no backendId is given (auto-route)", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { executor, runs } = recordingExecutor();
		const director = createDirectorApi(editor, { executor });

		await director.generate({ slotIds: ["s1"], alternatives: 1 });

		expect(runs[0].spec.model).toBeUndefined();
	});

	it("threads reroll's backendId onto the fresh take", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { executor, runs } = recordingExecutor();
		const director = createDirectorApi(editor, { executor });

		await director.reroll({ slotId: "s1", backendId: "cheap-y" });

		expect(runs).toHaveLength(1);
		expect(runs[0].spec.model).toBe("cheap-y");
	});
});

describe("compareTake", () => {
	it("renders one take per backend, each pinned to its backendId", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { executor, runs } = recordingExecutor();
		const director = createDirectorApi(editor, { executor });

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.ok).toBe(true);
		expect(res.data?.takeIds).toHaveLength(2);
		expect(runs.map((r) => r.spec.model).sort()).toEqual([
			"backend-a",
			"backend-b",
		]);
	});

	it("auto-picks the critic's winner when a vision critic is wired (D1 present)", async () => {
		const { editor, elements } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);
		const { executor } = recordingExecutor();
		// Critic always prefers the SECOND ready take.
		const critic: TakeCritic = {
			pickBest: async ({ takes }) => ({ takeId: takes[1].takeId }),
		};
		const director = createDirectorApi(editor, { executor, critic });

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(true);
		expect(res.data?.winner).toBe(res.data?.takeIds[1]);
		expect(elements[0].activeTakeId).toBe(res.data?.winner);
		expect(res.message).toMatch(/critic auto-picked/i);
	});

	it("presents both takes (no auto-pick) when no critic is wired (D1 absent)", async () => {
		const { editor, elements } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);
		const { executor } = recordingExecutor();
		const director = createDirectorApi(editor, { executor }); // no critic

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(false);
		expect(res.data?.winner).toBeUndefined();
		expect(res.data?.takeIds).toHaveLength(2);
		// Nothing force-selected — the user chooses.
		expect(elements[0].activeTakeId).toBeUndefined();
		expect(res.message).toMatch(/no vision critic/i);
	});

	it("falls back to presenting both when the critic returns no confident pick", async () => {
		const { editor, elements } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);
		const { executor } = recordingExecutor();
		const critic: TakeCritic = { pickBest: async () => null };
		const director = createDirectorApi(editor, { executor, critic });

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(false);
		expect(elements[0].activeTakeId).toBeUndefined();
	});

	it("rejects fewer than two distinct backends", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { executor } = recordingExecutor();
		const director = createDirectorApi(editor, { executor });

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-a"],
		});

		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/at least 2 distinct/i);
	});

	it("queues one take per backend when no executor is configured", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const director = createDirectorApi(editor); // no executor

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.ok).toBe(true);
		expect(res.data?.takeIds).toHaveLength(2);
		expect(res.data?.autoPicked).toBe(false);
		expect(res.message).toMatch(/queued/i);
	});
});

describe("getBackends", () => {
	const entry: BackendCatalogEntry = {
		id: "byteplus-seedance",
		label: "Seedance",
		vendor: "BytePlus",
		modality: "video",
		safetyTier: "partner",
		intents: ["broll-video"],
		supportsSeedLock: true,
		supportsReferenceEdits: false,
		costTier: "cheap",
		relativeCost: 100,
	};

	it("reads through the injected catalog provider", async () => {
		const { editor } = makeEditor([]);
		const director = createDirectorApi(editor, {
			backends: async () => [entry],
		});

		const res = await director.getBackends();

		expect(res.ok).toBe(true);
		expect(res.data).toEqual([entry]);
	});

	it("reports an empty catalog gracefully when no provider is wired", async () => {
		const { editor } = makeEditor([]);
		const director = createDirectorApi(editor);

		const res = await director.getBackends();

		expect(res.ok).toBe(true);
		expect(res.data).toEqual([]);
		expect(res.message).toMatch(/default auto-routing/i);
	});
});
