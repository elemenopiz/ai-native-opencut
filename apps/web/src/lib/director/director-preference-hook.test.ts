import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import type { DirectorBrief } from "@/types/project";
import type { GenerationSpec, Take } from "@/types/timeline";
import { createDirectorApi } from "./director-api";
import type { PreferenceEvent } from "./preference-learning";
import type { BoardDiscardFn, GenerateExecutor, TakeCritic } from "./types";

/**
 * Coverage for the Bet 3b preference-capture HOOK wired into the four
 * `DirectorApi` call sites (`chooseTake`/`reroll`/`compareTake`/
 * `discardBoardItem`). The distill/storage rules themselves (Bet 3a) are
 * exercised directly in `preference-learning.test.ts`; this suite only
 * verifies the CALL-SITE WIRING:
 *  - an honest event fires on each verb's SUCCESS path, and NEVER on a
 *    failure path,
 *  - `compareTake`'s `winner` (a TAKE id) is correctly resolved to a
 *    `wonBackendId` via the internal `{takeId, backendId}` pairing — the
 *    subtlety called out in `preference-learning.ts`'s module doc,
 *  - a missing/unresolvable project seam degrades to a silent no-op and
 *    never affects the verb's own result.
 *
 * Captured via the injectable `preferenceLearning.logEvent` seam
 * (`CreateDirectorApiOptions`) — deliberately NOT bun's `mock.module`, which
 * is process-global and leaks across test files in one process (see
 * `director-media-search.test.ts`'s comment on the same hazard).
 */

function baseSpec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
	return {
		prompt: "a lone lighthouse at dusk",
		mode: "text-to-video",
		resolution: "720p",
		orientation: "landscape",
		duration: 6,
		cameraPreset: "slow-dolly-in",
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

/**
 * Editor stub WITH a real `project.getActiveOrNull` seam — the hook needs it
 * to resolve `projectId` — plus the take/board bookkeeping the four verbs
 * touch. Mirrors `director-critic-adapter.test.ts`'s stub shape.
 */
function makeEditor(
	slots: { id: string; generation: GenerationSpec; takes?: Take[] }[],
	opts?: { board?: { discard?: BoardDiscardFn } },
) {
	const elements: StubElement[] = slots.map((s) => ({
		id: s.id,
		type: "video",
		generation: s.generation,
		takes: s.takes ?? [],
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
		project: {
			getActiveOrNull: () => ({ metadata: { id: "proj-1" } }),
			getDirectorBrief: () => brief,
			setDirectorBrief: ({ brief: next }: { brief: DirectorBrief }) => {
				brief = next;
			},
		},
		command: new CommandManager(),
	} as unknown as EditorCore;

	return { editor, elements, board: opts?.board };
}

/** Collects every event the hook logs via the injectable seam. */
function spyEvents() {
	const events: PreferenceEvent[] = [];
	const logEvent = async (event: PreferenceEvent) => {
		events.push(event);
	};
	return { events, logEvent };
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

// ── chooseTake ───────────────────────────────────────────────────────────

describe("chooseTake preference capture", () => {
	it("logs a chooseTake event with the take's recipe/provenance + rationale on success", async () => {
		const take: Take = {
			id: "t1",
			status: "ready",
			mediaId: "m1",
			spec: baseSpec({ seedLocked: true }),
			provenance: {
				backendId: "byteplus-seedance",
				vendor: "BytePlus",
				model: "seedance-1.0",
				safetyTier: "partner",
				generatedAt: Date.now(),
			},
			createdAt: Date.now(),
		};
		const { editor } = makeEditor([
			{ id: "s1", generation: baseSpec(), takes: [take] },
		]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		const res = await director.chooseTake({
			slotId: "s1",
			takeId: "t1",
			rationale: "prefers the warmer, handheld take",
		});

		expect(res.ok).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "chooseTake",
			projectId: "proj-1",
			meta: {
				backendId: "byteplus-seedance",
				vendor: "BytePlus",
				aspect: "landscape",
				durationSec: 6,
				mode: "text-to-video",
				cameraPreset: "slow-dolly-in",
				safetyTier: "partner",
				seedLocked: true,
				reason: "prefers the warmer, handheld take",
			},
		});
	});

	it("falls back to spec.model as backendId when the take has no provenance yet (still queued)", async () => {
		const take: Take = {
			id: "t1",
			status: "queued",
			spec: baseSpec({ model: "cheap-y" }),
			createdAt: Date.now(),
		};
		const { editor } = makeEditor([
			{ id: "s1", generation: baseSpec(), takes: [take] },
		]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		await director.chooseTake({ slotId: "s1", takeId: "t1" });

		expect(events).toHaveLength(1);
		expect(events[0].meta.backendId).toBe("cheap-y");
		// No rationale given ⇒ no invented reason.
		expect(events[0].meta.reason).toBeUndefined();
	});

	it("does NOT log on a failure path (unresolved slot)", async () => {
		const { editor } = makeEditor([]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		const res = await director.chooseTake({ slotId: "missing", takeId: "t1" });

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});

	it("does NOT log on a failure path (unresolved takeId)", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		const res = await director.chooseTake({ slotId: "s1", takeId: "nope" });

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});
});

// ── reroll ───────────────────────────────────────────────────────────────

describe("reroll preference capture", () => {
	it("logs a reroll event carrying the caller's backendId pin on success", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			preferenceLearning: { logEvent },
		});

		const res = await director.reroll({ slotId: "s1", backendId: "premium-x" });

		expect(res.ok).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "reroll",
			projectId: "proj-1",
			meta: { backendId: "premium-x" },
		});
	});

	it("logs a reroll event with empty meta when no backendId pin was given (log what exists)", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			preferenceLearning: { logEvent },
		});

		await director.reroll({ slotId: "s1" });

		expect(events).toHaveLength(1);
		expect(events[0].meta).toEqual({});
	});

	it("does NOT log on a failure path (missing slot)", async () => {
		const { editor } = makeEditor([]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		const res = await director.reroll({ slotId: "missing" });

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});

	it("does NOT log on a failure path (slot has no prompt)", async () => {
		const { editor } = makeEditor([
			{ id: "s1", generation: baseSpec({ prompt: "" }) },
		]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		const res = await director.reroll({ slotId: "s1" });

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});
});

// ── compareTake ──────────────────────────────────────────────────────────

describe("compareTake preference capture", () => {
	it("resolves winner (a TAKE id) to wonBackendId via the internal pairing, on critic auto-pick", async () => {
		const { editor, elements } = makeEditor([
			{ id: "s1", generation: baseSpec() },
		]);
		// Critic always prefers the SECOND ready take — produced in `ids` order,
		// so takes[1] was rendered with the second backendId ("backend-b").
		const critic: TakeCritic = {
			pickBest: async ({ takes }) => ({
				takeId: takes[1].takeId,
				reason: "sharper focus",
			}),
		};
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			critic,
			preferenceLearning: { logEvent },
		});

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(true);
		const winnerTakeId = res.data?.winner;
		expect(winnerTakeId).toBeDefined();
		// The subtlety: `winner` is a TAKE id, never one of the backend ids.
		expect(winnerTakeId).not.toBe("backend-a");
		expect(winnerTakeId).not.toBe("backend-b");
		expect(elements[0].activeTakeId).toBe(winnerTakeId);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("compareOutcome");
		expect(events[0].meta.competingBackendIds?.slice().sort()).toEqual([
			"backend-a",
			"backend-b",
		]);
		// Resolved through `produced`'s {takeId, backendId} pairing, NOT the
		// raw (takeId) winner value.
		expect(events[0].meta.wonBackendId).toBe("backend-b");
	});

	it("logs an unresolved compareOutcome (no wonBackendId) when no critic is wired", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			preferenceLearning: { logEvent },
		});

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.data?.autoPicked).toBe(false);
		expect(events).toHaveLength(1);
		expect(events[0].meta.wonBackendId).toBeUndefined();
		expect(events[0].meta.competingBackendIds?.slice().sort()).toEqual([
			"backend-a",
			"backend-b",
		]);
	});

	it("logs an unresolved compareOutcome when queued with no executor configured", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		}); // no executor

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.ok).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0].meta.wonBackendId).toBeUndefined();
	});

	it("does NOT log on a failure path (fewer than two distinct backends)", async () => {
		const { editor } = makeEditor([{ id: "s1", generation: baseSpec() }]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			executor: readyExecutor(),
			preferenceLearning: { logEvent },
		});

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-a"],
		});

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});

	it("does NOT log on a failure path (missing slot)", async () => {
		const { editor } = makeEditor([]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		const res = await director.compareTake({
			slotId: "missing",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});
});

// ── discardBoardItem ─────────────────────────────────────────────────────

describe("discardBoardItem preference capture", () => {
	it("logs a discard event (empty meta — no take data at this call site) on success", async () => {
		const { editor } = makeEditor([]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			board: { discard: async () => ({ ok: true }) },
			preferenceLearning: { logEvent },
		});

		const res = await director.discardBoardItem({ itemId: "b1" });

		expect(res.ok).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "discard",
			projectId: "proj-1",
			meta: {},
		});
	});

	it("does NOT log when the injected discard fn resolves a failure", async () => {
		const { editor } = makeEditor([]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			board: { discard: async () => ({ ok: false, error: "not found" }) },
			preferenceLearning: { logEvent },
		});

		const res = await director.discardBoardItem({ itemId: "missing" });

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});

	it("does NOT log when board.discard is not wired at all", async () => {
		const { editor } = makeEditor([]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		});

		const res = await director.discardBoardItem({ itemId: "b1" });

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});

	it("does NOT log when the injected discard fn throws", async () => {
		const { editor } = makeEditor([]);
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			board: {
				discard: async () => {
					throw new Error("network down");
				},
			},
			preferenceLearning: { logEvent },
		});

		const res = await director.discardBoardItem({ itemId: "b1" });

		expect(res.ok).toBe(false);
		expect(events).toHaveLength(0);
	});
});

// ── graceful no-op: capture must never affect the verb ──────────────────

describe("preference capture degrades silently without a resolvable project", () => {
	it("discardBoardItem still succeeds (no event) when getActiveOrNull resolves null", async () => {
		const { editor } = makeEditor([]);
		// No project currently open — a legitimate real-world state.
		(
			editor.project as unknown as { getActiveOrNull: () => null }
		).getActiveOrNull = () => null;
		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			board: { discard: async () => ({ ok: true }) },
			preferenceLearning: { logEvent },
		});

		const res = await director.discardBoardItem({ itemId: "b1" });

		expect(res.ok).toBe(true);
		expect(events).toHaveLength(0);
	});

	it("compareTake still succeeds when editor.project is entirely absent (minimal test stub)", async () => {
		// Mirrors `director-routing.test.ts`'s own minimal editor stub, which
		// has no `project` field at all — the hook must swallow the resulting
		// TypeError rather than let it surface.
		const elements: StubElement[] = [
			{
				id: "s1",
				type: "video",
				generation: baseSpec(),
				takes: [],
				activeTakeId: undefined,
				startTime: 0,
				duration: 6,
				trimStart: 0,
				trimEnd: 0,
			},
		];
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
				updateTake: () => {},
				selectTake: () => {},
			},
			command: new CommandManager(),
		} as unknown as EditorCore;

		const { events, logEvent } = spyEvents();
		const director = createDirectorApi(editor, {
			preferenceLearning: { logEvent },
		}); // no executor ⇒ the queued/no-critic branch

		const res = await director.compareTake({
			slotId: "s1",
			backendIds: ["backend-a", "backend-b"],
		});

		expect(res.ok).toBe(true);
		expect(events).toHaveLength(0);
	});
});
