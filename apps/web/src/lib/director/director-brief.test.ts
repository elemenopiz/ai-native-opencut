import { describe, expect, it } from "bun:test";
import {
	appendBriefNote,
	applyBriefPatch,
	emptyBrief,
	isBriefEmpty,
	MAX_BRIEF_NOTES,
	migrateLegacyBrief,
	summarizeBrief,
} from "./director-brief";
import type { DirectorBrief, TProject } from "@/types/project";
import {
	deserializeProject,
	serializeProject,
} from "@/services/storage/service";

// ── pure brief helpers ────────────────────────────────────────────────────────

describe("director brief helpers", () => {
	it("replaces scalars and appends dos/donts/notes (deduped, trimmed)", () => {
		const b1 = applyBriefPatch(emptyBrief(), {
			goal: "  sell shoes ",
			tone: "warm, handheld",
			dos: ["natural light", "natural light"],
			notes: ["prefers warm tones"],
		});
		expect(b1.goal).toBe("sell shoes"); // trimmed
		expect(b1.tone).toBe("warm, handheld");
		expect(b1.dos).toEqual(["natural light"]); // deduped
		expect(b1.notes).toEqual(["prefers warm tones"]);
		expect(b1.updatedAt).toBeGreaterThan(0);

		const b2 = applyBriefPatch(b1, {
			tone: "cool, static",
			dos: ["natural light", "wide shots"],
			donts: ["no on-screen text"],
		});
		expect(b2.tone).toBe("cool, static"); // scalar REPLACED
		expect(b2.dos).toEqual(["natural light", "wide shots"]); // APPENDED + deduped
		expect(b2.donts).toEqual(["no on-screen text"]);
		expect(b2.notes).toEqual(["prefers warm tones"]); // untouched
	});

	it("clears a scalar when handed an empty string (lets a preference be retracted)", () => {
		const b = applyBriefPatch({ goal: "x", tone: "warm" }, { goal: "" });
		expect(b.goal).toBeUndefined();
		expect("goal" in b).toBe(false); // key dropped, stays compact
		expect(b.tone).toBe("warm");
	});

	it("sets a target duration and lets a later patch replace it", () => {
		const b1 = applyBriefPatch(emptyBrief(), { durationSec: 60 });
		expect(b1.durationSec).toBe(60);

		const b2 = applyBriefPatch(b1, { durationSec: 90 });
		expect(b2.durationSec).toBe(90); // REPLACED, not appended

		// A patch that doesn't mention durationSec leaves it untouched.
		const b3 = applyBriefPatch(b2, { tone: "warm" });
		expect(b3.durationSec).toBe(90);
	});

	it("clears the target duration when patched with 0 or a negative value", () => {
		const withTarget = applyBriefPatch(emptyBrief(), { durationSec: 60 });

		const clearedByZero = applyBriefPatch(withTarget, { durationSec: 0 });
		expect(clearedByZero.durationSec).toBeUndefined();
		expect("durationSec" in clearedByZero).toBe(false); // key dropped, stays compact

		const clearedByNegative = applyBriefPatch(withTarget, {
			durationSec: -5,
		});
		expect(clearedByNegative.durationSec).toBeUndefined();
	});

	it("a brief with no target duration is unaffected by the durationSec logic", () => {
		const b = applyBriefPatch(emptyBrief(), { goal: "sell shoes" });
		expect(b.durationSec).toBeUndefined();
		expect("durationSec" in b).toBe(false);
	});

	it("caps learned notes at MAX_BRIEF_NOTES, dropping the oldest", () => {
		let b: DirectorBrief = {};
		for (let i = 0; i < MAX_BRIEF_NOTES + 5; i++) {
			b = appendBriefNote(b, `note ${i}`);
		}
		expect(b.notes).toHaveLength(MAX_BRIEF_NOTES);
		expect(b.notes?.[0]).toBe("note 5"); // oldest 5 dropped
		expect(b.notes?.at(-1)).toBe(`note ${MAX_BRIEF_NOTES + 4}`); // newest kept
	});

	it("summarizes only the set fields and nudges when empty", () => {
		expect(isBriefEmpty({})).toBe(true);
		expect(isBriefEmpty(undefined)).toBe(true);
		expect(summarizeBrief({})).toMatch(/empty/i);

		const s = summarizeBrief({
			goal: "drive signups",
			tone: "warm, handheld",
			dos: ["natural light"],
			notes: ["user prefers warm tones, handheld feel"],
		});
		expect(s).toContain("DIRECTOR BRIEF");
		expect(s).toContain("GOAL: drive signups");
		expect(s).toContain("TONE: warm, handheld");
		expect(s).toContain("DO: natural light");
		expect(s).toContain("user prefers warm tones, handheld feel");
		expect(s).not.toContain("AUDIENCE"); // unset field omitted
		expect(s).not.toContain("TARGET DURATION"); // no target set ⇒ omitted
	});

	it("a target duration alone makes the brief non-empty and shows up in the summary", () => {
		expect(isBriefEmpty({ durationSec: 60 })).toBe(false);

		const s = summarizeBrief({ durationSec: 60 });
		expect(s).toContain("TARGET DURATION: 60s");
		expect(s).not.toContain("(empty");
	});
});

// ── durable persistence: survives a save → reload cycle ───────────────────────

function makeProject(overrides: Partial<TProject> = {}): TProject {
	const now = new Date("2026-07-10T00:00:00.000Z");
	return {
		metadata: {
			id: "proj_brief",
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

describe("director brief persistence (serialize → reload round-trip)", () => {
	it("carries the brief through the durable project shape and back", () => {
		const brief = applyBriefPatch(
			{},
			{
				goal: "drive app signups",
				audience: "Gen-Z creators",
				tone: "warm, handheld",
				styleNote: "golden-hour grade, quick cuts",
				durationSec: 60,
				dos: ["natural light"],
				donts: ["no stock-footage look"],
				notes: ["user prefers warm tones, handheld feel"],
			},
		);
		const project = makeProject({ directorBrief: brief });

		const serialized = serializeProject({ project });
		// The brief rides in the on-disk shape alongside settings.
		expect(serialized.directorBrief).toEqual(brief);

		// Reload: IndexedDB persists a structured clone; a JSON round-trip models
		// that boundary, then deserializeProject rebuilds the live TProject.
		const reloaded = deserializeProject({
			serializedProject: JSON.parse(JSON.stringify(serialized)),
		});
		expect(reloaded.directorBrief).toEqual(brief);
	});

	it("loads a legacy project saved before the field existed as undefined", () => {
		const serialized = serializeProject({ project: makeProject() });
		// Simulate an older record with no directorBrief key at all.
		const legacy = JSON.parse(JSON.stringify(serialized));
		delete legacy.directorBrief;

		const reloaded = deserializeProject({ serializedProject: legacy });
		expect(reloaded.directorBrief).toBeUndefined();
	});
});

// ── legacy styleBible → styleNote migration (one-way, on read) ────────────────

describe("migrateLegacyBrief", () => {
	it("moves a legacy `styleBible` string into `styleNote` and drops the old key", () => {
		const stored = {
			tone: "warm",
			styleBible: "golden-hour grade, quick cuts",
		} as DirectorBrief;
		const migrated = migrateLegacyBrief(stored);
		expect(migrated?.styleNote).toBe("golden-hour grade, quick cuts");
		expect(migrated && "styleBible" in migrated).toBe(false);
		expect(migrated?.tone).toBe("warm"); // other fields untouched
	});

	it("keeps an already-set `styleNote` when both keys are present (styleNote wins)", () => {
		const stored = {
			styleNote: "cool grade",
			styleBible: "old value",
		} as DirectorBrief;
		const migrated = migrateLegacyBrief(stored);
		expect(migrated?.styleNote).toBe("cool grade");
		expect(migrated && "styleBible" in migrated).toBe(false);
	});

	it("drops an empty legacy key without inventing a styleNote", () => {
		const stored = { tone: "warm", styleBible: "  " } as DirectorBrief;
		const migrated = migrateLegacyBrief(stored);
		expect(migrated?.styleNote).toBeUndefined();
		expect(migrated && "styleBible" in migrated).toBe(false);
	});

	it("passes through briefs with no legacy key (same reference) and undefined", () => {
		const brief: DirectorBrief = { tone: "warm", styleNote: "x" };
		expect(migrateLegacyBrief(brief)).toBe(brief);
		expect(migrateLegacyBrief(undefined)).toBeUndefined();
	});
});
