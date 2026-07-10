import { describe, expect, it } from "bun:test";
import {
	extractPersistentNote,
	isUserBibleDefaultsEmpty,
	MAX_USER_DEFAULT_LIST,
	promoteBibleToUserDefaults,
	SEED_DECISION_NOTE,
	seedBibleFromUserDefaults,
} from "./cross-project-memory";
import type { ProjectBible } from "@/types/project";
import type { UserBibleDefaults } from "@/types/user-memory";

// A full-featured bible: durable prefs mixed with project-specific facts.
function sampleBible(): ProjectBible {
	return {
		version: 4,
		updatedAt: 1000,
		styleBible: {
			palette: "warm amber highlights, teal shadows",
			lensMood: "anamorphic, shallow DoF, dreamy",
			setting: "sunlit kitchen",
			characters: [{ name: "Barista", descriptor: "background extra" }],
		},
		brief: {
			goal: "drive signups for the app", // project-specific — must NOT promote
			audience: "Gen-Z skateboarders", // project-specific — must NOT promote
			tone: "warm, playful, handheld",
			styleBible: "warm tones, quick cuts",
			dos: ["keep it handheld", "warm grade"],
			donts: ["no stock footage"],
			notes: [
				"remember: user loves warm tones", // persistent
				"[remember] always end on the logo", // persistent
				"this reel's CTA is 'sign up now'", // project-local — must NOT promote
			],
		},
		consistencyContext: { style: "x", characters: [], setting: "y" },
		plan: { shots: [] } as unknown as ProjectBible["plan"],
		personaRosterSummary: [{ id: "p1", name: "Ana", descriptor: "lead" }],
		decisions: [{ at: 1, note: "Storyboarded 3 shots" }],
	};
}

describe("promoteBibleToUserDefaults — distillation, not blind copy", () => {
	it("carries durable look + tone + reusable rules, drops project-specific facts", () => {
		const defaults = promoteBibleToUserDefaults(undefined, sampleBible(), 2000);
		expect(defaults).toBeDefined();
		const d = defaults as UserBibleDefaults;

		// Look promoted, but the project-specific `characters` cast dropped.
		expect(d.styleBible?.palette).toBe("warm amber highlights, teal shadows");
		expect(d.styleBible?.setting).toBe("sunlit kitchen");
		expect(
			(d.styleBible as { characters?: unknown }).characters,
		).toBeUndefined();

		// Durable brief slice promoted.
		expect(d.brief?.tone).toBe("warm, playful, handheld");
		expect(d.brief?.styleBible).toBe("warm tones, quick cuts");
		expect(d.brief?.dos).toContain("keep it handheld");
		expect(d.brief?.donts).toContain("no stock footage");

		// Project-specific facts NEVER promoted.
		expect(d.brief?.goal).toBeUndefined();
		expect(d.brief?.audience).toBeUndefined();
	});

	it("promotes ONLY marker-tagged notes, with the marker stripped", () => {
		const d = promoteBibleToUserDefaults(undefined, sampleBible(), 2000);
		const notes = d?.brief?.notes ?? [];
		expect(notes).toContain("user loves warm tones");
		expect(notes).toContain("always end on the logo");
		// The unmarked, reel-specific note must not flow up.
		expect(notes.some((n) => n.includes("CTA"))).toBe(false);
	});

	it("accumulates dos/donts across projects and newest-wins on scalars", () => {
		const first = promoteBibleToUserDefaults(undefined, sampleBible(), 1000);
		const second: ProjectBible = {
			version: 1,
			updatedAt: 3000,
			styleBible: { palette: "cool blue grade" },
			brief: { tone: "crisp, corporate", dos: ["brand-safe framing"] },
		};
		const merged = promoteBibleToUserDefaults(first, second, 3000);
		// Newest look/tone win field-by-field.
		expect(merged?.styleBible?.palette).toBe("cool blue grade");
		expect(merged?.styleBible?.setting).toBe("sunlit kitchen"); // retained from first
		expect(merged?.brief?.tone).toBe("crisp, corporate");
		// dos accumulate (union), not replace.
		expect(merged?.brief?.dos).toContain("keep it handheld");
		expect(merged?.brief?.dos).toContain("brand-safe framing");
	});

	it("is a no-op for an empty/absent bible (returns prior defaults unchanged)", () => {
		const prev: UserBibleDefaults = {
			styleBible: { palette: "warm" },
			updatedAt: 1,
		};
		expect(promoteBibleToUserDefaults(prev, undefined, 5)).toBe(prev);
		expect(
			promoteBibleToUserDefaults(prev, { version: 0, updatedAt: 0 }, 5),
		).toBe(prev);
		// From scratch, an empty bible distills to nothing.
		expect(
			promoteBibleToUserDefaults(undefined, { version: 0, updatedAt: 0 }),
		).toBeUndefined();
	});

	it("bounds the promoted lists", () => {
		const many = Array.from({ length: 50 }, (_, i) => `do ${i}`);
		const d = promoteBibleToUserDefaults(
			undefined,
			{ version: 1, updatedAt: 0, brief: { dos: many } },
			1,
		);
		expect(d?.brief?.dos?.length).toBeLessThanOrEqual(MAX_USER_DEFAULT_LIST);
	});
});

describe("extractPersistentNote", () => {
	it("recognizes markers and strips them", () => {
		expect(extractPersistentNote("remember: warm tones")).toBe("warm tones");
		expect(extractPersistentNote("[remember] end on logo")).toBe("end on logo");
		expect(extractPersistentNote("★ always 9:16")).toBe("always 9:16");
		expect(extractPersistentNote("REMEMBER: caps work")).toBe("caps work");
	});
	it("returns null for unmarked or empty notes", () => {
		expect(extractPersistentNote("just a normal note")).toBeNull();
		expect(extractPersistentNote("   ")).toBeNull();
		expect(extractPersistentNote("remember:")).toBeNull(); // marker only
	});
});

describe("seedBibleFromUserDefaults + round-trip", () => {
	it("returns undefined when defaults are empty/absent (migration-safe)", () => {
		expect(seedBibleFromUserDefaults(undefined)).toBeUndefined();
		expect(seedBibleFromUserDefaults({ updatedAt: 1 })).toBeUndefined();
		expect(isUserBibleDefaultsEmpty(undefined)).toBe(true);
		expect(isUserBibleDefaultsEmpty({ updatedAt: 1 })).toBe(true);
	});

	it("seeds a fresh, overridable bible carrying the durable look + brief", () => {
		const defaults: UserBibleDefaults = {
			styleBible: { palette: "warm amber", setting: "kitchen" },
			brief: { tone: "warm", dos: ["handheld"], updatedAt: 1 },
			updatedAt: 1,
		};
		const seed = seedBibleFromUserDefaults(defaults, 42);
		expect(seed).toBeDefined();
		expect(seed?.version).toBe(0); // fresh baseline — first Director write bumps it
		expect(seed?.styleBible?.palette).toBe("warm amber");
		expect(seed?.brief?.tone).toBe("warm");
		expect(seed?.brief?.dos).toEqual(["handheld"]);
		// The seeding is VISIBLE + flagged overridable.
		expect(seed?.decisions?.[0]?.note).toBe(SEED_DECISION_NOTE);
	});

	it("round-trips: project A durable prefs → user defaults → project B pre-seed", () => {
		// Project A finishes with a full bible.
		const projectA = sampleBible();
		const userDefaults = promoteBibleToUserDefaults(undefined, projectA, 2000);

		// New project B is seeded from the user layer.
		const projectBSeed = seedBibleFromUserDefaults(userDefaults, 3000);
		expect(projectBSeed).toBeDefined();

		// B inherits A's recurring look + tone + reusable rules...
		expect(projectBSeed?.styleBible?.palette).toBe(
			"warm amber highlights, teal shadows",
		);
		expect(projectBSeed?.brief?.tone).toBe("warm, playful, handheld");
		expect(projectBSeed?.brief?.dos).toContain("keep it handheld");
		expect(projectBSeed?.brief?.notes).toContain("user loves warm tones");

		// ...but NOT A's project-specific goal/audience or its plan/cast/history.
		expect(projectBSeed?.brief?.goal).toBeUndefined();
		expect(projectBSeed?.brief?.audience).toBeUndefined();
		expect(projectBSeed?.plan).toBeUndefined();
		expect(projectBSeed?.consistencyContext).toBeUndefined();
		expect(projectBSeed?.personaRosterSummary).toBeUndefined();
		expect(projectBSeed?.history).toBeUndefined();
	});
});
