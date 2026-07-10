import { describe, expect, it } from "bun:test";
import {
	captureBibleState,
	emptyProjectBible,
	extractBibleState,
	hydrateDirectorStateFromBible,
	isBibleStateEmpty,
	MAX_BIBLE_DECISIONS,
	MAX_BIBLE_HISTORY,
	pushCheckpoint,
	revertBible,
	syncProjectBible,
} from "./project-bible";
import type { ProjectBible, TProject } from "@/types/project";
import type { ConsistencyContext } from "./consistency-prompt";
import type { StoryboardPlan } from "./storyboard-plan";
import {
	getStoredConsistencyContext,
	storeConsistencyContext,
} from "./consistency-prompt";
import { getStoredPlan, storePlan } from "./storyboard-plan";
import { makeFakeEditor } from "./fake-editor";
import { createDirectorApi } from "./director-api";
import {
	deserializeProject,
	serializeProject,
} from "@/services/storage/service";

// ── sample creative state ─────────────────────────────────────────────────────

const ctxA: ConsistencyContext = {
	style: "warm amber grade",
	characters: [],
	setting: "sunlit kitchen",
};
const ctxB: ConsistencyContext = {
	style: "cool teal grade",
	characters: [],
	setting: "night rooftop",
};
const planB: StoryboardPlan = {
	shotCount: 1,
	shots: [{ index: 1, prompt: "a shot", duration: 6 }],
	bible: { palette: "amber", lensMood: "anamorphic" },
	totalDuration: 6,
	createdAt: 111,
};

// ── pure: checkpoint / version ────────────────────────────────────────────────

describe("project bible — pushCheckpoint (versioning)", () => {
	it("bumps version, stamps updatedAt, and does NOT checkpoint an empty prior state", () => {
		const b0 = emptyProjectBible(1000);
		expect(b0).toEqual({ version: 0, updatedAt: 1000 });

		const b1 = pushCheckpoint(
			b0,
			{ consistencyContext: ctxA },
			{ label: "setConsistencyContext", note: "Set context", now: 2000 },
		);
		expect(b1.version).toBe(1);
		expect(b1.updatedAt).toBe(2000);
		expect(b1.consistencyContext).toEqual(ctxA);
		// Prior state was empty ⇒ nothing to revert to ⇒ no history entry.
		expect(b1.history).toBeUndefined();
		expect(b1.decisions).toEqual([{ at: 2000, note: "Set context" }]);
	});

	it("pushes the PRIOR state onto history on the next write, newest-last", () => {
		const b1 = pushCheckpoint(
			emptyProjectBible(1000),
			{ consistencyContext: ctxA },
			{ label: "setConsistencyContext", note: "A", now: 2000 },
		);
		const b2 = pushCheckpoint(
			b1,
			{ consistencyContext: ctxB, plan: planB },
			{ label: "storyboard", note: "B", now: 3000 },
		);
		expect(b2.version).toBe(2);
		expect(b2.consistencyContext).toEqual(ctxB);
		expect(b2.plan).toEqual(planB);
		expect(b2.history).toHaveLength(1);
		// The checkpoint captures state A at version 1; its label names the write
		// that SUPERSEDED it (the op that produced the checkpoint) — here "storyboard".
		expect(b2.history?.[0]).toMatchObject({
			version: 1,
			label: "storyboard",
		});
		expect(b2.history?.[0].state.consistencyContext).toEqual(ctxA);
		expect(b2.decisions).toEqual([
			{ at: 2000, note: "A" },
			{ at: 3000, note: "B" },
		]);
	});

	it("passes the sibling-agent seams (assetManifest / understanding) through untouched", () => {
		const seeded: ProjectBible = {
			...pushCheckpoint(emptyProjectBible(1), { consistencyContext: ctxA }, {}),
			assetManifest: { assets: ["a1"] },
			understanding: { styleProbe: "grainy" },
		};
		const next = pushCheckpoint(seeded, { consistencyContext: ctxB }, {});
		expect(next.assetManifest).toEqual({ assets: ["a1"] });
		expect(next.understanding).toEqual({ styleProbe: "grainy" });
	});

	it("bounds the checkpoint history at MAX_BIBLE_HISTORY, dropping oldest", () => {
		let b = emptyProjectBible(0);
		for (let i = 0; i < MAX_BIBLE_HISTORY + 5; i++) {
			b = pushCheckpoint(
				b,
				{ consistencyContext: { ...ctxA, style: `s${i}` } },
				{
					now: i + 1,
				},
			);
		}
		expect(b.history?.length).toBe(MAX_BIBLE_HISTORY);
		// The very first captured state (style "s0") should have been evicted.
		expect(
			b.history?.some((h) => h.state.consistencyContext?.style === "s0"),
		).toBe(false);
	});

	it("bounds the decision log at MAX_BIBLE_DECISIONS", () => {
		let b = emptyProjectBible(0);
		for (let i = 0; i < MAX_BIBLE_DECISIONS + 5; i++) {
			b = pushCheckpoint(
				b,
				{ consistencyContext: ctxA },
				{
					note: `d${i}`,
					now: i + 1,
				},
			);
		}
		expect(b.decisions?.length).toBe(MAX_BIBLE_DECISIONS);
		expect(b.decisions?.at(-1)?.note).toBe(`d${MAX_BIBLE_DECISIONS + 4}`);
	});

	it("isBibleStateEmpty / extractBibleState behave", () => {
		expect(isBibleStateEmpty({})).toBe(true);
		expect(isBibleStateEmpty({ brief: {} })).toBe(true);
		expect(isBibleStateEmpty({ consistencyContext: ctxA })).toBe(false);
		const state = extractBibleState({
			version: 3,
			updatedAt: 1,
			consistencyContext: ctxA,
			plan: planB,
			history: [],
		});
		expect(state).toEqual({ consistencyContext: ctxA, plan: planB });
	});
});

// ── pure: revert (checkpoint restore) ─────────────────────────────────────────

describe("project bible — revertBible (turn-level rollback)", () => {
	it("restores the most recent checkpoint and keeps version monotonic", () => {
		const b1 = pushCheckpoint(
			emptyProjectBible(1000),
			{ consistencyContext: ctxA },
			{
				now: 2000,
			},
		);
		const b2 = pushCheckpoint(
			b1,
			{ consistencyContext: ctxB, plan: planB },
			{
				now: 3000,
			},
		);

		const r = revertBible(b2, { now: 4000 });
		expect(r.reverted).toBe(true);
		expect(r.toVersion).toBe(1);
		// State A restored; B's plan is gone.
		expect(r.bible.consistencyContext).toEqual(ctxA);
		expect(r.bible.plan).toBeUndefined();
		// Version keeps climbing (revert is itself a new revision, not an undo pop).
		expect(r.bible.version).toBe(3);
		// The pre-revert state (B) is retained so the revert is itself reversible.
		expect(r.bible.history?.at(-1)?.state.consistencyContext).toEqual(ctxB);
	});

	it("reverts to a specific checkpoint version when asked", () => {
		const b1 = pushCheckpoint(
			emptyProjectBible(0),
			{ consistencyContext: ctxA },
			{
				now: 1,
			},
		);
		const b2 = pushCheckpoint(b1, { consistencyContext: ctxB }, { now: 2 });
		const b3 = pushCheckpoint(
			b2,
			{ plan: planB, consistencyContext: ctxB },
			{
				now: 3,
			},
		);
		// history now holds v1 (A) and v2 (B). Revert straight to v1.
		const r = revertBible(b3, { toVersion: 1, now: 4 });
		expect(r.reverted).toBe(true);
		expect(r.toVersion).toBe(1);
		expect(r.bible.consistencyContext).toEqual(ctxA);
	});

	it("is a no-op when there is no history / an unknown version", () => {
		const b1 = pushCheckpoint(
			emptyProjectBible(0),
			{ consistencyContext: ctxA },
			{
				now: 1,
			},
		);
		expect(revertBible(b1).reverted).toBe(false); // b1 has no history
		expect(revertBible(emptyProjectBible(0)).reverted).toBe(false);

		const b2 = pushCheckpoint(b1, { consistencyContext: ctxB }, { now: 2 });
		expect(revertBible(b2, { toVersion: 99 }).reverted).toBe(false);
	});
});

// ── editor glue: capture / hydrate ────────────────────────────────────────────

describe("project bible — editor capture + hydration", () => {
	it("captureBibleState reads brief, consistency, plan, styleBible, and roster", () => {
		const fake = makeFakeEditor();
		fake.editor.project.setDirectorBrief({ brief: { goal: "sell shoes" } });
		storeConsistencyContext(fake.editor, ctxA);
		storePlan(fake.editor, planB);

		const state = captureBibleState(fake.editor, {
			personas: [{ id: "p1", name: "Mara", descriptor: "a barista" }],
		});
		expect(state.brief).toEqual({ goal: "sell shoes" });
		expect(state.consistencyContext).toEqual(ctxA);
		expect(state.plan).toEqual(planB);
		expect(state.styleBible).toEqual(planB.bible); // style bible == the plan's bible
		expect(state.personaRosterSummary).toEqual([
			{ id: "p1", name: "Mara", descriptor: "a barista" },
		]);
	});

	it("syncProjectBible persists a versioned bible readable back off the project", () => {
		const fake = makeFakeEditor();
		storeConsistencyContext(fake.editor, ctxA);
		const bible = syncProjectBible(fake.editor, {
			label: "setConsistencyContext",
			personas: [],
			now: 1000,
		});
		expect(bible.version).toBe(1);
		expect(fake.editor.project.getProjectBible()).toEqual(bible);
	});

	it("hydrates the WeakMap caches from a persisted bible (survives unmount)", () => {
		const fake = makeFakeEditor();
		fake.editor.project.setProjectBible({
			bible: {
				version: 2,
				updatedAt: 1,
				consistencyContext: ctxA,
				plan: planB,
			},
		});
		// Fresh editor / post-unmount: the WeakMaps are empty.
		expect(getStoredConsistencyContext(fake.editor)).toBeUndefined();
		expect(getStoredPlan(fake.editor)).toBeUndefined();

		hydrateDirectorStateFromBible(fake.editor);
		expect(getStoredConsistencyContext(fake.editor)).toEqual(ctxA);
		expect(getStoredPlan(fake.editor)).toEqual(planB);
	});

	it("hydration CLEARS stale state when switching projects on a reused editor", () => {
		const fake = makeFakeEditor();
		// Stale context from a previously-open project.
		storeConsistencyContext(fake.editor, ctxB);
		storePlan(fake.editor, planB);
		// Newly loaded project's bible has a context but no plan.
		fake.editor.project.setProjectBible({
			bible: { version: 1, updatedAt: 1, consistencyContext: ctxA },
		});

		hydrateDirectorStateFromBible(fake.editor);
		expect(getStoredConsistencyContext(fake.editor)).toEqual(ctxA); // replaced
		expect(getStoredPlan(fake.editor)).toBeUndefined(); // cleared
	});

	it("hydration is FAIL-SAFE on corrupt/legacy bible data (never throws → project still loads)", () => {
		// The hydration hook sits in the central project-load path
		// (editor-provider → after loadProject). If it could throw on a malformed
		// bible, a single corrupt record would break project load entirely. It must
		// not: hydration does zero parsing — it just moves references into WeakMaps.
		const fake = makeFakeEditor();

		// A bible with structurally wrong fields (string where an object is
		// expected, a garbage plan, junk extra keys) — the kind of thing a legacy
		// migration or a hand-edited IndexedDB record could produce.
		const corruptBible = {
			version: "not-a-number",
			consistencyContext: "should-be-an-object",
			plan: 42,
			garbage: { nested: [1, 2, 3] },
		} as unknown as ProjectBible;
		fake.editor.project.setProjectBible({ bible: corruptBible });

		// The whole point: this call is what runs on every project load.
		expect(() => hydrateDirectorStateFromBible(fake.editor)).not.toThrow();
		// The corrupt sub-objects are stored verbatim (they are truthy), never
		// parsed here — any real defect surfaces lazily at a consumer, not at load.
		expect(getStoredPlan(fake.editor)).toBe(42 as unknown as StoryboardPlan);

		// An entirely missing bible is likewise safe and clears the caches.
		fake.editor.project.setProjectBible({
			bible: undefined as unknown as ProjectBible,
		});
		expect(() => hydrateDirectorStateFromBible(fake.editor)).not.toThrow();
		expect(getStoredConsistencyContext(fake.editor)).toBeUndefined();
		expect(getStoredPlan(fake.editor)).toBeUndefined();
	});
});

// ── vertical slice: write-through via the Director API, then reload ───────────

describe("project bible — end-to-end via createDirectorApi", () => {
	it("setConsistencyContext write-through survives an unmount + reload cycle", () => {
		const fake = makeFakeEditor();
		const api = createDirectorApi(fake.editor);

		api.setConsistencyContext({
			style: "golden-hour, handheld",
			setting: "rooftop",
			includeAllPersonas: false,
		});

		// It persisted to the durable bible.
		const persisted = fake.editor.project.getProjectBible();
		expect(persisted?.version).toBe(1);
		expect(persisted?.consistencyContext?.style).toContain("golden-hour");

		// Simulate editor unmount: the WeakMaps are GC'd (cleared).
		storeConsistencyContext(fake.editor, undefined);
		storePlan(fake.editor, undefined);
		expect(getStoredConsistencyContext(fake.editor)).toBeUndefined();

		// Reload: hydrate from the persisted bible — the look is back.
		hydrateDirectorStateFromBible(fake.editor);
		expect(getStoredConsistencyContext(fake.editor)?.style).toContain(
			"golden-hour",
		);
	});

	it("storyboard write-through persists the plan into the bible", () => {
		const fake = makeFakeEditor();
		const api = createDirectorApi(fake.editor);
		api.storyboard({
			shots: [{ prompt: "cold open" }, { prompt: "hero shot" }],
			bible: { palette: "amber", lensMood: "anamorphic" },
		});
		const bible = fake.editor.project.getProjectBible();
		expect(bible?.plan?.shotCount).toBe(2);
		expect(bible?.styleBible).toEqual({
			palette: "amber",
			lensMood: "anamorphic",
		});
	});

	it("revertBibleCheckpoint rolls the look back and re-hydrates the WeakMaps", () => {
		const fake = makeFakeEditor();
		const api = createDirectorApi(fake.editor);
		api.setConsistencyContext({ style: "look A", includeAllPersonas: false });
		api.setConsistencyContext({ style: "look B", includeAllPersonas: false });
		expect(getStoredConsistencyContext(fake.editor)?.style).toContain("look B");

		const res = api.revertBibleCheckpoint();
		expect(res.ok).toBe(true);
		// Live WeakMap reverted...
		expect(getStoredConsistencyContext(fake.editor)?.style).toContain("look A");
		// ...and so did the persisted bible.
		expect(
			fake.editor.project.getProjectBible()?.consistencyContext?.style,
		).toContain("look A");
	});

	it("revertBibleCheckpoint reports a no-op when there's nothing to revert to", () => {
		const fake = makeFakeEditor();
		const api = createDirectorApi(fake.editor);
		expect(api.revertBibleCheckpoint().ok).toBe(false);
	});
});

// ── durable persistence: serialize → reload round-trip ────────────────────────

function makeProject(overrides: Partial<TProject> = {}): TProject {
	const now = new Date("2026-07-10T00:00:00.000Z");
	return {
		metadata: {
			id: "proj_bible",
			name: "Reel",
			duration: 6,
			createdAt: now,
			updatedAt: now,
		},
		scenes: [
			{
				id: "scene_main",
				name: "Main scene",
				isMain: true,
				tracks: [],
				bookmarks: [],
				markers: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene_main",
		settings: {
			fps: 30,
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: 1,
		...overrides,
	};
}

describe("project bible persistence (serialize → reload round-trip)", () => {
	it("carries the bible through the durable project shape and back", () => {
		const bible: ProjectBible = {
			version: 3,
			updatedAt: 123,
			consistencyContext: ctxA,
			plan: planB,
			styleBible: planB.bible,
			personaRosterSummary: [{ id: "p1", name: "Mara", descriptor: "barista" }],
			decisions: [{ at: 1, note: "Set context" }],
			history: [
				{
					version: 2,
					at: 1,
					label: "storyboard",
					state: { consistencyContext: ctxB },
				},
			],
		};
		const project = makeProject({ projectBible: bible });

		const serialized = serializeProject({ project });
		expect(serialized.projectBible).toEqual(bible);

		// IndexedDB persists a structured clone; a JSON round-trip models that boundary.
		const reloaded = deserializeProject({
			serializedProject: JSON.parse(JSON.stringify(serialized)),
		});
		expect(reloaded.projectBible).toEqual(bible);
	});

	it("loads a legacy project saved before the field existed as undefined", () => {
		const serialized = serializeProject({ project: makeProject() });
		const legacy = JSON.parse(JSON.stringify(serialized));
		delete legacy.projectBible;
		const reloaded = deserializeProject({ serializedProject: legacy });
		expect(reloaded.projectBible).toBeUndefined();
	});
});
