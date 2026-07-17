import { beforeEach, describe, expect, test } from "bun:test";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";

/**
 * BUG9 regression coverage: the background-tasks widget must default to
 * minimized so it never auto-expands over the timeline when a task starts
 * (`apps/web/src/components/editor/background-tasks.tsx`), and once the user
 * has expanded or collapsed it, that choice must persist across further
 * tasks starting for the rest of the session — addTask must not force
 * `isMinimized` either way.
 */

beforeEach(() => {
	// Reset to the store's actual defaults (not just `tasks`), since
	// `reset()` intentionally preserves `isMinimized` as a UI preference.
	useBackgroundTasksStore.setState({ tasks: [], isMinimized: true });
});

describe("background-tasks-store — isMinimized default/behavior", () => {
	test("defaults to minimized", () => {
		expect(useBackgroundTasksStore.getState().isMinimized).toBe(true);
	});

	test("addTask does not force the widget open", () => {
		useBackgroundTasksStore.getState().addTask({
			id: "task-1",
			type: "transcription",
			label: "Transcribing",
			progress: "",
		});

		expect(useBackgroundTasksStore.getState().isMinimized).toBe(true);
		expect(useBackgroundTasksStore.getState().tasks).toHaveLength(1);
	});

	test("once the user expands the widget, a new task does not re-minimize it", () => {
		useBackgroundTasksStore.getState().setMinimized(false);
		useBackgroundTasksStore.getState().addTask({
			id: "task-2",
			type: "voiceover",
			label: "Generating voiceover",
			progress: "",
		});

		expect(useBackgroundTasksStore.getState().isMinimized).toBe(false);
	});

	test("once the user collapses the widget, a new task does not re-expand it", () => {
		useBackgroundTasksStore.getState().setMinimized(false);
		useBackgroundTasksStore.getState().setMinimized(true);
		useBackgroundTasksStore.getState().addTask({
			id: "task-3",
			type: "dubbing",
			label: "Dubbing",
			progress: "",
		});

		expect(useBackgroundTasksStore.getState().isMinimized).toBe(true);
	});

	test("reset() drops tasks but preserves the isMinimized preference", () => {
		useBackgroundTasksStore.getState().setMinimized(false);
		useBackgroundTasksStore.getState().addTask({
			id: "task-4",
			type: "smart-cut",
			label: "Auto-cutting",
			progress: "",
		});

		useBackgroundTasksStore.getState().reset();

		expect(useBackgroundTasksStore.getState().tasks).toHaveLength(0);
		expect(useBackgroundTasksStore.getState().isMinimized).toBe(false);
	});
});
