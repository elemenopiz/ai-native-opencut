import { describe, expect, it } from "bun:test";
import { ProjectManager } from "@/core/managers/project-manager";
import type { EditorCore } from "@/core";
import type { TProject } from "@/types/project";

/**
 * Reactivity contract the Bible panel depends on: writing the durable brief or
 * the versioned bible must NOTIFY `editor.project.subscribe` listeners (not just
 * `markDirty`), so the panel re-renders when either a human edit or a Director
 * verb touches the Bible. Regression guard for the one-line `notify()` added to
 * `setDirectorBrief` / `setProjectBible`.
 */
function makeManager(): { pm: ProjectManager } {
	const fakeEditor = {
		save: { markDirty: () => {} },
	} as unknown as EditorCore;
	const pm = new ProjectManager(fakeEditor);
	pm.setActiveProject({
		project: {
			metadata: {
				id: "p1",
				name: "Test",
				duration: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			scenes: [],
			currentSceneId: "s1",
			settings: {} as TProject["settings"],
			version: 1,
		} as TProject,
	});
	return { pm };
}

describe("project-manager — Bible write reactivity", () => {
	it("setDirectorBrief notifies subscribers", () => {
		const { pm } = makeManager();
		let calls = 0;
		pm.subscribe(() => {
			calls += 1;
		});
		pm.setDirectorBrief({ brief: { goal: "x" } });
		expect(calls).toBe(1);
		expect(pm.getDirectorBrief().goal).toBe("x");
	});

	it("setProjectBible notifies subscribers", () => {
		const { pm } = makeManager();
		let calls = 0;
		pm.subscribe(() => {
			calls += 1;
		});
		pm.setProjectBible({ bible: { version: 1, updatedAt: 1 } });
		expect(calls).toBe(1);
		expect(pm.getProjectBible()?.version).toBe(1);
	});

	it("no-ops (and does not notify) without an active project", () => {
		const fakeEditor = {
			save: { markDirty: () => {} },
		} as unknown as EditorCore;
		const pm = new ProjectManager(fakeEditor);
		let calls = 0;
		pm.subscribe(() => {
			calls += 1;
		});
		pm.setDirectorBrief({ brief: { goal: "x" } });
		pm.setProjectBible({ bible: { version: 1, updatedAt: 1 } });
		expect(calls).toBe(0);
	});
});
