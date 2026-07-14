/**
 * Integration coverage for the whole-reel budget gate inside the REAL frontier
 * loop. We drive `runDirectorAgent` with a mocked relay (synthetic SSE, same as
 * `agent-streaming.test.ts`) over a real `DirectorApi` whose reel carries a
 * budget, and assert the loop either DOWN-ROUTES an overrunning generation to a
 * cheaper backend or PAUSES for approval — never silently overspends.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { runDirectorAgent, type DirectorEvent } from "./agent";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor, type FakeEditor } from "./fake-editor";
import type { BackendCatalogEntry, GenerateExecutor } from "./types";
import { usePersonaStore } from "@/stores/persona-store";

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: string[]): Response {
	const bytes = new TextEncoder().encode(frames.join(""));
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bytes);
			c.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

/** A turn that calls `generate` with no args (→ all slots). Fresh Response each
 *  call — a Response body is single-use, so factories avoid a locked-stream reuse. */
const generateTurn = () =>
	sseResponse([
		frame("final", {
			content: [
				{ type: "text", text: "Rendering the reel." },
				{ type: "tool_use", id: "g1", name: "generate", input: {} },
			],
			stop_reason: "tool_use",
			model: "test",
		}),
		frame("done", {}),
	]);
const closeTurn = () =>
	sseResponse([
		frame("final", {
			content: [{ type: "text", text: "Done." }],
			stop_reason: "end_turn",
			model: "test",
		}),
		frame("done", {}),
	]);

function catalog(): BackendCatalogEntry[] {
	return [
		{
			id: "cheap-draft",
			label: "Cheap Draft",
			vendor: "test",
			modality: "video",
			safetyTier: "experimental",
			intents: ["broll-video"],
			supportsSeedLock: false,
			supportsReferenceEdits: false,
			costTier: "cheap",
			relativeCost: 1,
		},
		{
			id: "premium-hero",
			label: "Premium Hero",
			vendor: "test",
			modality: "video",
			safetyTier: "partner",
			intents: ["character-video"],
			supportsSeedLock: true,
			supportsReferenceEdits: true,
			costTier: "premium",
			relativeCost: 3.4,
		},
	];
}

/** Executor that always succeeds — the budget math, not generation, is under test. */
const readyExecutor: GenerateExecutor = {
	run: async () => ({ status: "ready", mediaId: `m_${Math.random()}` }),
};

function budgetedReel(): {
	fake: FakeEditor;
	director: ReturnType<typeof createDirectorApi>;
} {
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: readyExecutor,
		backends: async () => catalog(),
	});
	// Three 4s shots at 480p → base $0.44 each (cheapest registered video
	// backend's post-markup sale rate); hero starts premium under a $5 cap.
	director.storyboard({
		shots: [
			{ prompt: "logo reveal hero shot", duration: 4, importance: "hero" },
			{ prompt: "product on a table", duration: 4, importance: "support" },
			{ prompt: "street b-roll", duration: 4, importance: "broll" },
		],
		budgetUsd: 5,
	});
	return { fake, director };
}

afterEach(() => {
	mock.restore();
	usePersonaStore.setState({ personas: [] });
});

describe("whole-reel budget gate (frontier loop)", () => {
	test("down-routes an overrunning generation to the cheaper backend and records the spend", async () => {
		const { fake, director } = budgetedReel();
		// Leave $1.50: the $1.32 all-cheap batch (3 × 0.44) fits, but standard
		// ($2.508 = 3 × 0.836) and premium ($4.224 = 3 × 1.408) do not → the loop
		// must down-route to cheap.
		director.recordSpend({ usd: 3.5 });

		let call = 0;
		global.fetch = mock(async () =>
			call++ === 0 ? generateTurn() : closeTurn(),
		) as unknown as typeof fetch;

		const events: DirectorEvent[] = [];
		const result = await runDirectorAgent({
			director,
			chat: async () => "",
			userMessage: "render all the shots",
			brain: "frontier",
			onEvent: (e) => events.push(e),
		});

		// It did NOT pause — it down-routed and proceeded.
		expect(result.awaitingApproval).toBeUndefined();
		const downStep = result.steps.find((s) =>
			s.message.includes("Down-routed"),
		);
		expect(downStep).toBeDefined();
		expect(downStep?.message).toContain("cheap-draft");

		// Every rendered take was pinned to the cheaper backend.
		const takeModels = fake.tracks
			.flatMap((t) => t.elements)
			.flatMap((e) => e.takes ?? [])
			.map((tk) => tk.spec?.model);
		expect(takeModels.length).toBeGreaterThan(0);
		expect(takeModels.every((m) => m === "cheap-draft")).toBe(true);

		// Spend advanced by the cheap-tier batch cost and was surfaced to the panel.
		const budgetEvent = events.find((e) => e.type === "budget_update") as
			| { type: "budget_update"; spentUsd: number; budgetUsd?: number }
			| undefined;
		expect(budgetEvent).toBeDefined();
		expect(budgetEvent?.budgetUsd).toBe(5);
		expect(budgetEvent?.spentUsd).toBeCloseTo(3.5 + 1.32, 5);
		// Never exceeded the cap.
		expect(director.getBudgetStatus().data?.spentUsd).toBeLessThanOrEqual(5);
	});

	test("pauses for approval when not even the cheapest tier fits the remaining budget", async () => {
		const { fake, director } = budgetedReel();
		director.recordSpend({ usd: 4.85 }); // only $0.15 left; all-cheap needs $1.32

		global.fetch = mock(async () => generateTurn()) as unknown as typeof fetch;

		const result = await runDirectorAgent({
			director,
			chat: async () => "",
			userMessage: "render all the shots",
			brain: "frontier",
		});

		// The turn ended awaiting approval, over budget, before spending.
		expect(result.awaitingApproval).toBeDefined();
		expect(result.awaitingApproval?.action).toBe("generate");
		expect(result.finalMessage.toLowerCase()).toContain("budget");

		// Nothing was generated and the spend is unchanged.
		const takeCount = fake.tracks
			.flatMap((t) => t.elements)
			.reduce((n, e) => n + (e.takes?.length ?? 0), 0);
		expect(takeCount).toBe(0);
		expect(director.getBudgetStatus().data?.spentUsd).toBeCloseTo(4.85, 5);
	});

	// Regression: `remix` used to be absent from the gated-action set, the cost
	// estimator and budgetSpendInput, so it ran a paid backend with zero budget
	// enforcement and never advanced spend. It must gate exactly like `reroll`.
	test("gates a remix against the whole-reel budget instead of spending silently", async () => {
		const { fake, director } = budgetedReel();
		director.recordSpend({ usd: 4.85 }); // only $0.15 left — nothing fits

		const slotId = fake.tracks.flatMap((t) => t.elements)[0]?.id as string;
		expect(slotId).toBeDefined();

		const remixTurn = () =>
			sseResponse([
				frame("final", {
					content: [
						{ type: "text", text: "Reworking the hero." },
						{
							type: "tool_use",
							id: "r1",
							name: "remix",
							input: { slotId, remixPrompt: "make it moodier" },
						},
					],
					stop_reason: "tool_use",
					model: "test",
				}),
				frame("done", {}),
			]);
		global.fetch = mock(async () => remixTurn()) as unknown as typeof fetch;

		const result = await runDirectorAgent({
			director,
			chat: async () => "",
			userMessage: "make the hero moodier",
			brain: "frontier",
		});

		// The remix paused for approval before spending — it is no longer invisible
		// to the budget gate.
		expect(result.awaitingApproval).toBeDefined();
		expect(result.awaitingApproval?.action).toBe("remix");
		// Spend is unchanged — nothing ran.
		expect(director.getBudgetStatus().data?.spentUsd).toBeCloseTo(4.85, 5);
	});
});
