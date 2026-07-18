import { describe, expect, it, mock } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/types/project";

/**
 * Reactivity contract the Bible panel depends on: writing the durable brief or
 * the versioned bible must NOTIFY `editor.project.subscribe` listeners (not just
 * `markDirty`), so the panel re-renders when either a human edit or a Director
 * verb touches the Bible. Regression guard for the one-line `notify()` added to
 * `setDirectorBrief` / `setProjectBible`.
 *
 * Order-dependence guard: `ProjectManager` (from
 * "@/core/managers/project-manager") imports `UpdateProjectSettingsCommand`
 * from "@/lib/commands/project", which imports `EditorCore` from "@/core" as
 * a VALUE — the same "@/core" that transitively imports
 * `@/core/managers/media-manager`, which statically imports the real
 * `@/services/proxy` barrel (chaining into proxy-encoder-controller.ts ->
 * proxy-generator.ts). A plain static import of ProjectManager here would
 * cache the real chain in bun test's shared module registry before
 * proxy-encoder-controller.test.ts's own `mock.module()` can take effect, if
 * that file runs later in the same `bun test` invocation. Mock the barrel
 * and import dynamically, AFTER the mock (mirrors
 * media-manager-decode-reprobe.test.ts's barrel mock + "Import AFTER the
 * mocks" convention). Proxy generation itself is never exercised here.
 */
mock.module("@/services/proxy", () => ({
	generateProxyOffThread: async () => ({
		file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
		width: 1280,
		height: 720,
	}),
	isProxyCancelledError: (error: unknown) =>
		error instanceof Error &&
		(error.message === "Proxy generation cancelled" ||
			error.name === "AbortError"),
}));

const { ProjectManager } = await import("@/core/managers/project-manager");
function makeManager(): { pm: InstanceType<typeof ProjectManager> } {
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
