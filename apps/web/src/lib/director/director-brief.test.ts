import { describe, expect, it } from "bun:test";
import {
	appendBriefNote,
	applyBriefPatch,
	briefDigest,
	emptyBrief,
	isBriefEmpty,
	MAX_BRIEF_NOTES,
	migrateLegacyBrief,
	preferenceHintClause,
	summarizeBrief,
} from "./director-brief";
import type { UserPreferenceModel } from "./preference-learning";
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

	// ── P1: platform + mustInclude (north-star P1 widening) ─────────────────

	it("replaces platform like the other scalars and appends mustInclude (deduped)", () => {
		const b1 = applyBriefPatch(emptyBrief(), {
			platform: "TikTok",
			mustInclude: ["show the logo", "show the logo"],
		});
		expect(b1.platform).toBe("TikTok");
		expect(b1.mustInclude).toEqual(["show the logo"]); // deduped

		const b2 = applyBriefPatch(b1, {
			platform: "YouTube Shorts",
			mustInclude: ["show the logo", "end on a CTA"],
		});
		expect(b2.platform).toBe("YouTube Shorts"); // REPLACED
		expect(b2.mustInclude).toEqual(["show the logo", "end on a CTA"]); // APPENDED
	});

	it("clears platform when handed an empty string", () => {
		const b = applyBriefPatch({ platform: "TikTok" }, { platform: "" });
		expect(b.platform).toBeUndefined();
		expect("platform" in b).toBe(false);
	});

	it("platform/mustInclude alone make the brief non-empty and show up in the summary", () => {
		expect(isBriefEmpty({ platform: "TikTok" })).toBe(false);
		expect(isBriefEmpty({ mustInclude: ["show the logo"] })).toBe(false);

		const s = summarizeBrief({
			platform: "TikTok",
			mustInclude: ["show the logo", "end on a CTA"],
		});
		expect(s).toContain("PLATFORM: TikTok");
		expect(s).toContain("MUST INCLUDE: show the logo; end on a CTA");
	});

	it("an updateBrief-shaped patch never clobbers unset fields (strip-undefined-before-spread)", () => {
		// Mirrors `asBriefPatch`'s BUG31 idiom: a patch that only names ONE field
		// must leave every other already-set field untouched.
		const base = applyBriefPatch(emptyBrief(), {
			goal: "drive signups",
			audience: "Gen-Z",
			platform: "TikTok",
			tone: "playful",
			durationSec: 30,
			mustInclude: ["show the logo"],
		});
		const patched = applyBriefPatch(base, { tone: "moody" });
		expect(patched.goal).toBe("drive signups");
		expect(patched.audience).toBe("Gen-Z");
		expect(patched.platform).toBe("TikTok");
		expect(patched.durationSec).toBe(30);
		expect(patched.mustInclude).toEqual(["show the logo"]);
		expect(patched.tone).toBe("moody"); // only this one changed
	});
});

// ── P1: BRIEF digest (buildContextBlock's one-line standing-awareness fold) ──

describe("briefDigest", () => {
	it("is absent (empty string) for an empty brief with no learned preferences", () => {
		expect(briefDigest(undefined)).toBe("");
		expect(briefDigest({})).toBe("");
	});

	it("is absent for a brief that carries only unreadable content (just notes)", () => {
		expect(briefDigest({ notes: ["user prefers warm tones"] })).toBe("");
	});

	it("renders a compact line from goal/audience/platform/tone/duration", () => {
		const digest = briefDigest({
			goal: "drive app signups",
			audience: "Gen-Z creators",
			platform: "TikTok",
			tone: "playful",
			durationSec: 30,
		});
		expect(digest).toBe(
			"BRIEF: drive app signups · for Gen-Z creators · TikTok · playful · 30s target.",
		);
	});

	it("appends a must-include clause, capped to 2 items", () => {
		const digest = briefDigest({
			goal: "product launch",
			mustInclude: ["show the logo", "end on a CTA", "mention the price"],
		});
		expect(digest).toContain("must: show the logo; end on a CTA");
		expect(digest).not.toContain("mention the price");
	});

	it("truncates a long goal so the line stays a short digest, not the full brief", () => {
		const longGoal =
			"a very long, rambling description of exactly what this reel should accomplish for the launch campaign";
		const digest = briefDigest({ goal: longGoal });
		expect(digest.length).toBeLessThan(longGoal.length + 10);
		expect(digest).toContain("…");
	});

	it("appends a learned-defaults hint only when no target duration is stated", () => {
		const model: UserPreferenceModel = {
			sampleSize: 5,
			preferredAspects: [{ tag: "9:16", count: 4 }],
			avgKeptDurationSec: 24.4,
			updatedAt: 1,
		};

		const withoutDuration = briefDigest({ goal: "launch reel" }, model);
		expect(withoutDuration).toContain("learned: 9:16, ~24s avg");

		const withDuration = briefDigest(
			{ goal: "launch reel", durationSec: 45 },
			model,
		);
		expect(withDuration).toContain("45s target");
		expect(withDuration).not.toContain("learned:"); // stated preference wins
	});

	it("stays absent when only a preference model exists and the brief itself is empty", () => {
		// A learned default alone is not a stated brief — the digest is strictly
		// gated on the brief having something set (getBrief's message is the
		// seam for surfacing learned defaults on an otherwise-empty brief).
		const model: UserPreferenceModel = {
			sampleSize: 5,
			preferredAspects: [{ tag: "9:16", count: 4 }],
			updatedAt: 1,
		};
		expect(briefDigest({}, model)).toBe("");
	});
});

describe("preferenceHintClause", () => {
	it("is empty for an absent or sample-free model", () => {
		expect(preferenceHintClause(undefined)).toBe("");
		expect(preferenceHintClause({ sampleSize: 0, updatedAt: 1 })).toBe("");
	});

	it("renders the top preferred aspect and rounded mean kept duration", () => {
		const model: UserPreferenceModel = {
			sampleSize: 5,
			preferredAspects: [
				{ tag: "9:16", count: 4 },
				{ tag: "1:1", count: 1 },
			],
			avgKeptDurationSec: 23.6,
			updatedAt: 1,
		};
		expect(preferenceHintClause(model)).toBe("learned: 9:16, ~24s avg");
	});

	it("degrades gracefully when only one signal is present", () => {
		expect(
			preferenceHintClause({
				sampleSize: 2,
				avgKeptDurationSec: 12,
				updatedAt: 1,
			}),
		).toBe("learned: ~12s avg");
		expect(
			preferenceHintClause({
				sampleSize: 2,
				preferredAspects: [{ tag: "16:9", count: 2 }],
				updatedAt: 1,
			}),
		).toBe("learned: 16:9");
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
