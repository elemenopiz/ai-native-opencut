import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { EditorCore } from "@/core";

/**
 * BUG125/BUG126 regression coverage: SaveManager must not lie about save
 * state. A failed `saveCurrentProject()` write must NOT advance
 * `getLastSavedAt()`, must keep the edit queued (`getIsDirty()` stays true),
 * and must be visible via `getSaveError()`. A QuotaExceededError specifically
 * must toast exactly once per failure episode — not once per (800ms) retry —
 * and must never touch/clear the in-memory active project.
 *
 * Mocks "sonner" so toast calls are inspectable without a real UI.
 */
const toastCalls: { error: string[] } = { error: [] };
mock.module("sonner", () => ({
	toast: {
		error: (msg: string) => {
			toastCalls.error.push(msg);
		},
		warning: () => {},
		success: () => {},
		info: () => {},
		loading: () => "toast-id",
	},
}));

const { SaveManager } = await import("@/core/managers/save-manager");

type SaveResult = { ok: true } | { ok: false; error: unknown };

function makeFakeEditor(project: object) {
	const scripted: SaveResult[] = [];
	const calls: { saveCurrentProject: number } = { saveCurrentProject: 0 };

	const fakeEditor = {
		scenes: { subscribe: () => () => {} },
		timeline: { subscribe: () => () => {} },
		project: {
			getActiveOrNull: () => project,
			getIsLoading: () => false,
			getMigrationState: () => ({
				isMigrating: false,
				fromVersion: null,
				toVersion: null,
				projectName: null,
			}),
			saveCurrentProject: async () => {
				calls.saveCurrentProject += 1;
				const next = scripted.shift();
				if (!next) throw new Error("no scripted result for saveCurrentProject");
				if (!next.ok) throw next.error;
			},
		},
	} as unknown as EditorCore;

	return {
		fakeEditor,
		calls,
		scriptSuccess: () => scripted.push({ ok: true }),
		scriptFailure: (error: unknown) => scripted.push({ ok: false, error }),
	};
}

beforeEach(() => {
	toastCalls.error.length = 0;
});

describe("SaveManager — BUG125 failure truthfulness", () => {
	it("does not advance lastSavedAt on a failed save, and keeps the save pending", async () => {
		const project = { id: "p1" };
		const { fakeEditor, scriptFailure } = makeFakeEditor(project);
		scriptFailure(new Error("write failed"));

		const manager = new SaveManager(fakeEditor);
		manager.markDirty();
		await manager.flush();

		expect(manager.getLastSavedAt()).toBeNull();
		// hasPendingSave was put back to true in the catch branch, so a retry
		// stays queued — the dirty flag must not have been cleared.
		expect(manager.getIsDirty()).toBe(true);
		expect(manager.getSaveError()).toBeInstanceOf(Error);
		expect(manager.getSaveError()?.message).toBe("write failed");

		manager.stop();
	});

	it("advances lastSavedAt and clears the error once a save actually succeeds", async () => {
		const project = { id: "p1" };
		const { fakeEditor, scriptSuccess } = makeFakeEditor(project);
		scriptSuccess();

		const manager = new SaveManager(fakeEditor);
		manager.markDirty();
		await manager.flush();

		expect(manager.getLastSavedAt()).not.toBeNull();
		expect(manager.getIsDirty()).toBe(false);
		expect(manager.getSaveError()).toBeNull();

		manager.stop();
	});

	it("recovers: a failing save followed by a successful one clears getSaveError()", async () => {
		const project = { id: "p1" };
		const { fakeEditor, scriptFailure, scriptSuccess } =
			makeFakeEditor(project);
		scriptFailure(new Error("first attempt failed"));
		scriptSuccess();

		const manager = new SaveManager(fakeEditor);
		manager.markDirty();
		await manager.flush();
		expect(manager.getSaveError()).not.toBeNull();

		manager.markDirty();
		await manager.flush();
		expect(manager.getSaveError()).toBeNull();
		expect(manager.getLastSavedAt()).not.toBeNull();

		manager.stop();
	});
});

describe("SaveManager — BUG126 quota exhaustion", () => {
	it("toasts exactly once across repeated QuotaExceededError retries, and never touches the active project", async () => {
		const project = { id: "p1", name: "untouched" };
		const { fakeEditor, scriptFailure } = makeFakeEditor(project);
		const quotaError = new DOMException("Storage full", "QuotaExceededError");
		scriptFailure(quotaError);
		scriptFailure(quotaError);
		scriptFailure(quotaError);

		const manager = new SaveManager(fakeEditor);

		manager.markDirty();
		await manager.flush();
		manager.markDirty();
		await manager.flush();
		manager.markDirty();
		await manager.flush();

		expect(toastCalls.error.length).toBe(1);
		expect(manager.getSaveError()).toBeInstanceOf(DOMException);
		// The fake editor's getActiveOrNull always returns the same object
		// reference — SaveManager/ProjectManager never reset/cleared it on
		// failure.
		const active =
			fakeEditor.project.getActiveOrNull() as unknown as typeof project;
		expect(active).toBe(project);
		expect(active.name).toBe("untouched");

		manager.stop();
	});

	it("toasts again on a fresh quota-failure episode after recovering", async () => {
		const project = { id: "p1" };
		const { fakeEditor, scriptFailure, scriptSuccess } =
			makeFakeEditor(project);
		const quotaError = new DOMException("Storage full", "QuotaExceededError");
		scriptFailure(quotaError);
		scriptSuccess();
		scriptFailure(quotaError);

		const manager = new SaveManager(fakeEditor);

		manager.markDirty();
		await manager.flush(); // fails — toast #1
		manager.markDirty();
		await manager.flush(); // recovers, clears toast dedupe state
		manager.markDirty();
		await manager.flush(); // fails again — new episode, toast #2

		expect(toastCalls.error.length).toBe(2);

		manager.stop();
	});

	it("does not toast for a non-quota failure", async () => {
		const project = { id: "p1" };
		const { fakeEditor, scriptFailure } = makeFakeEditor(project);
		scriptFailure(new Error("network hiccup"));

		const manager = new SaveManager(fakeEditor);
		manager.markDirty();
		await manager.flush();

		expect(toastCalls.error.length).toBe(0);
		expect(manager.getSaveError()?.message).toBe("network hiccup");

		manager.stop();
	});
});
