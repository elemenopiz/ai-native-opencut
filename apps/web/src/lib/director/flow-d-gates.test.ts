import { beforeEach, describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import { toolCatalog } from "./tool-catalog";
import { useVoiceConsentStore } from "@/stores/voice-consent-store";
import {
	recordBibleApproval,
	seedStyleBibleFromProbe,
	styleProbeToStyleBible,
} from "./project-bible";
import type { GenerateExecutor } from "./types";
import type { GenerationSpec } from "@/types/timeline";

const okExecutor: GenerateExecutor = {
	run: async () => ({ status: "ready", mediaId: "aud_1" }),
};
const fastRecovery = { sleep: async () => {} };

/** Minimal ready take spec for seeding a slot's take list directly. */
function readyTake(id: string) {
	const spec: GenerationSpec = {
		kind: "video",
		prompt: "hero shot",
		model: "m",
		mode: "text-to-video",
		resolution: "720p",
		orientation: "landscape",
		duration: 6,
	};
	return {
		id,
		status: "ready" as const,
		spec,
		mediaId: `media_${id}`,
		createdAt: 1,
	};
}

// ── hero-shot approval gate ─────────────────────────────────────────────────

describe("approveHeroShot gate", () => {
	it("selects the take AND writes the decision into the Bible (approvals + brief)", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, { recovery: fastRecovery });
		const slotId = d.reserveSlot({ prompt: "hero shot", duration: 6 }).data
			?.slotId as string;
		editor.timeline.addTakeToElement({
			elementId: slotId,
			take: readyTake("t0"),
		});
		editor.timeline.addTakeToElement({
			elementId: slotId,
			take: readyTake("t1"),
		});

		const res = d.approveHeroShot({
			slotId,
			takeId: "t1",
			rationale: "warmest grade, cleanest motion",
		});
		expect(res.ok).toBe(true);

		// The approved take is now active.
		expect(res.data?.activeTakeId).toBe("t1");
		expect(d.getSlot(slotId).data?.activeTakeId).toBe("t1");

		// The Bible carries a hero-shot approval referencing the take, plus a note.
		const bible = editor.project.getProjectBible();
		const approval = bible?.approvals?.find((a) => a.kind === "hero-shot");
		expect(approval).toBeDefined();
		expect(approval?.rationale).toBe("warmest grade, cleanest motion");
		expect(approval?.ref?.slotId).toBe(slotId);
		expect(approval?.ref?.takeId).toBe("t1");
		expect(approval?.ref?.mediaId).toBe("media_t1");

		// The rationale also lands as a durable brief note (prompt-facing memory).
		const notes = editor.project.getDirectorBrief().notes ?? [];
		expect(notes.some((n) => n.includes("warmest grade"))).toBe(true);
	});

	it("fails cleanly when the slot has no take to approve (nothing recorded)", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, { recovery: fastRecovery });
		const slotId = d.reserveSlot({ prompt: "x", duration: 6 }).data
			?.slotId as string;
		const res = d.approveHeroShot({ slotId });
		expect(res.ok).toBe(false);
		expect(editor.project.getProjectBible()?.approvals ?? []).toHaveLength(0);
	});
});

// ── final-cut approval gate ─────────────────────────────────────────────────

describe("approveFinalCut gate", () => {
	it("records the approval + summary into the Bible when there is a timeline", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, { recovery: fastRecovery });
		d.reserveSlot({ prompt: "shot 1", duration: 6, startTime: 0 });
		d.reserveSlot({ prompt: "shot 2", duration: 6, startTime: 6 });

		const res = d.approveFinalCut({ rationale: "client signed off" });
		expect(res.ok).toBe(true);

		const approval = editor.project
			.getProjectBible()
			?.approvals?.find((a) => a.kind === "final-cut");
		expect(approval).toBeDefined();
		expect(approval?.rationale).toBe("client signed off");
		expect(approval?.summary).toMatch(/2 shots/);
	});

	it("refuses to approve an empty timeline", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, { recovery: fastRecovery });
		expect(d.approveFinalCut().ok).toBe(false);
	});
});

// ── voice-clone consent enforcement in the Director path ────────────────────

describe("addVoiceover consent enforcement (server-route-equivalent)", () => {
	beforeEach(() => useVoiceConsentStore.setState({ profiles: {} }));

	it("REFUSES to speak an unconsented cloned voice", async () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});
		const clone = useVoiceConsentStore
			.getState()
			.registerClone({ name: "Mara", referencePath: "/ref/mara.wav" });
		expect(clone.consentStatus).toBe("pending");

		const res = await d.addVoiceover({
			script: "hello",
			voiceRef: "/ref/mara.wav",
		});
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/consent/i);
	});

	it("allows a cloned voice once consented", async () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});
		const clone = useVoiceConsentStore
			.getState()
			.registerClone({ name: "Mara", referencePath: "/ref/mara.wav" });
		useVoiceConsentStore
			.getState()
			.grantProfileConsent(clone.id, { phrase: "x" });

		const res = await d.addVoiceover({
			script: "hello",
			voiceRef: "/ref/mara.wav",
		});
		expect(res.ok).toBe(true);
	});

	it("getVoiceProfiles reports status; revokeVoiceConsent disables", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, { recovery: fastRecovery });
		const clone = useVoiceConsentStore
			.getState()
			.registerClone({ name: "Mara", referencePath: "/ref/mara.wav" });
		useVoiceConsentStore
			.getState()
			.grantProfileConsent(clone.id, { phrase: "x" });

		const listed = d.getVoiceProfiles().data?.profiles ?? [];
		expect(listed).toHaveLength(1);

		const rev = d.revokeVoiceConsent({ profileId: clone.id });
		expect(rev.ok).toBe(true);
		expect(
			useVoiceConsentStore.getState().isReferenceUsable("/ref/mara.wav"),
		).toBe(false);
	});
});

// ── follow-up B: styleProbe → styleBible seam (no-clobber) ───────────────────

describe("styleProbe → styleBible seam", () => {
	it("styleProbeToStyleBible maps palette/lens-mood/setting; undefined when empty", () => {
		expect(
			styleProbeToStyleBible({ palette: "warm amber", lensMood: "anamorphic" }),
		).toEqual({ palette: "warm amber", lensMood: "anamorphic" });
		expect(styleProbeToStyleBible(undefined)).toBeUndefined();
		expect(styleProbeToStyleBible({})).toBeUndefined();
	});

	it("SEEDS the Bible's styleBible when none is set", () => {
		const { editor } = makeFakeEditor();
		const r = seedStyleBibleFromProbe(editor, {
			palette: "warm amber",
			setting: "sunlit kitchen",
		});
		expect(r.seeded).toBe(true);
		expect(editor.project.getProjectBible()?.styleBible).toEqual({
			palette: "warm amber",
			setting: "sunlit kitchen",
		});
	});

	it("does NOT clobber a human-set styleBible — logs a note instead", () => {
		const { editor } = makeFakeEditor();
		// Human/existing look.
		seedStyleBibleFromProbe(editor, { palette: "human teal" });
		const r = seedStyleBibleFromProbe(editor, { palette: "probe amber" });
		expect(r.seeded).toBe(false);
		expect(r.noted).toBe(true);
		// The human look is preserved.
		expect(editor.project.getProjectBible()?.styleBible?.palette).toBe(
			"human teal",
		);
		// The observation is logged as a decision note.
		const decisions = editor.project.getProjectBible()?.decisions ?? [];
		expect(decisions.some((dn) => dn.note.includes("not applied"))).toBe(true);
	});

	it("force overwrites an existing styleBible", () => {
		const { editor } = makeFakeEditor();
		seedStyleBibleFromProbe(editor, { palette: "human teal" });
		const r = seedStyleBibleFromProbe(
			editor,
			{ palette: "probe amber" },
			{ force: true },
		);
		expect(r.seeded).toBe(true);
		expect(editor.project.getProjectBible()?.styleBible?.palette).toBe(
			"probe amber",
		);
	});

	it("the seedStyleFromUnderstanding verb routes an injected probe into the Bible", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			recovery: fastRecovery,
			styleProbe: (mediaId) =>
				mediaId === "media_1"
					? { palette: "cold teal", lensMood: "handheld" }
					: undefined,
		});
		const res = d.seedStyleFromUnderstanding({ mediaId: "media_1" });
		expect(res.ok).toBe(true);
		expect(editor.project.getProjectBible()?.styleBible?.palette).toBe(
			"cold teal",
		);

		// No probe for this asset ⇒ nothing to seed.
		expect(d.seedStyleFromUnderstanding({ mediaId: "nope" }).ok).toBe(false);
	});
});

// ── approvals ledger is checkpoint-durable ──────────────────────────────────

describe("bible approvals ledger", () => {
	it("recordBibleApproval survives a later creative-state checkpoint", () => {
		const { editor } = makeFakeEditor();
		recordBibleApproval(
			editor,
			{ kind: "final-cut", at: 1, summary: "3 shots" },
			{ label: "approveFinalCut", note: "approved" },
		);
		// A later unrelated bible write must NOT drop the approval.
		seedStyleBibleFromProbe(editor, { palette: "amber" });
		const approvals = editor.project.getProjectBible()?.approvals ?? [];
		expect(approvals).toHaveLength(1);
		expect(approvals[0].kind).toBe("final-cut");
	});
});

// ── the new verbs are registered in the shared tool catalog ─────────────────

describe("tool catalog registration", () => {
	it("exposes the Flow-D verbs to the agent + MCP surface", () => {
		const names = new Set(toolCatalog().map((t) => t.name));
		for (const n of [
			"approveHeroShot",
			"approveFinalCut",
			"getVoiceProfiles",
			"revokeVoiceConsent",
			"seedStyleFromUnderstanding",
		]) {
			expect(names.has(n)).toBe(true);
		}
	});
});
