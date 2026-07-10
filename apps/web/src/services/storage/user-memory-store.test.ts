import { describe, expect, it } from "bun:test";
import {
	clearAllUserMemory,
	getUserBibleDefaults,
	getUserMediaMemory,
	getUserMemory,
	getUserMemorySummary,
	promoteBibleToUserMemory,
	seedProjectBibleFromUserMemory,
} from "./user-memory-store";
import type { ProjectBible } from "@/types/project";

// This suite runs in a bun environment with NO IndexedDB (mirroring SSR / a
// browser in private mode). Every read must fail soft to "nothing yet" and every
// write must no-op — the absence of the user layer is a valid state everywhere.
// (The pure promotion/seeding rules are exercised in cross-project-memory.test.ts.)

describe("user-memory-store — migration safety / absence handling", () => {
	it("reads resolve to empty when storage is unavailable, never throw", async () => {
		expect(await getUserMemory()).toBeUndefined();
		expect(await getUserBibleDefaults()).toBeUndefined();
		expect(await getUserMediaMemory("sha256:whatever")).toBeUndefined();
	});

	it("summary reports 'remembers nothing' with no storage", async () => {
		const summary = await getUserMemorySummary();
		expect(summary).toEqual({ hasBibleDefaults: false, mediaCount: 0 });
	});

	it("clearAllUserMemory is a safe no-op without storage", async () => {
		await expect(clearAllUserMemory()).resolves.toBeUndefined();
	});

	it("seeding a new project returns undefined when nothing is remembered", async () => {
		expect(await seedProjectBibleFromUserMemory()).toBeUndefined();
	});

	it("promotion applies the pure rule even when the persist write no-ops", async () => {
		const bible: ProjectBible = {
			version: 2,
			updatedAt: 100,
			styleBible: { palette: "warm amber" },
			brief: { tone: "handheld", goal: "signups" },
		};
		// getUserBibleDefaults() → undefined (no storage), so this promotes from
		// scratch; the save silently no-ops but the distilled result still returns.
		const promoted = await promoteBibleToUserMemory(bible, 200);
		expect(promoted?.styleBible?.palette).toBe("warm amber");
		expect(promoted?.brief?.tone).toBe("handheld");
		expect(promoted?.brief?.goal).toBeUndefined(); // project-specific, not promoted
	});
});
