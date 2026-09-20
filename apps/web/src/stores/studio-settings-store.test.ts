/**
 * Coverage for the `generationEnabled` kill switch on the Studio settings
 * store — the sticky flag the composer's GenerationToggleButton reads/writes
 * (see `components/editor/ai/generation-toggle-button.tsx` and
 * `lib/director/agent.ts`'s `GENERATION_VERB_NAMES`).
 *
 * `bun test` has no `localStorage`, so zustand's persist middleware logs a
 * "storage is currently unavailable" warning and falls back to in-memory —
 * that's the SAME degradation every other `persist`-backed store in this repo
 * accepts in tests (none polyfill localStorage; see preview-store.test.ts).
 * What's actually under test is the store's OWN state shape and default, not
 * zustand's storage adapter — the persistence mechanism itself is the
 * library's job, already covered by its own tests.
 */
import { afterEach, expect, test } from "bun:test";
import { useStudioSettingsStore } from "./studio-settings-store";

const initial = useStudioSettingsStore.getState();

afterEach(() => {
	// Reset to the store's own defaults between tests so one test's toggle
	// can't leak into the next (zustand stores are module-singletons, shared
	// across the whole test file / process).
	useStudioSettingsStore.setState(initial, true);
});

test("generationEnabled defaults to true — unchanged behavior for anyone who never touches the toggle", () => {
	expect(useStudioSettingsStore.getState().generationEnabled).toBe(true);
});

test("toggling off via set() persists across reads", () => {
	useStudioSettingsStore.getState().set({ generationEnabled: false });
	expect(useStudioSettingsStore.getState().generationEnabled).toBe(false);
	// A second, independent read sees the same value — not a snapshot that
	// reverts on next access.
	expect(useStudioSettingsStore.getState().generationEnabled).toBe(false);
});

test("toggling back on restores true and leaves sibling settings untouched", () => {
	const before = useStudioSettingsStore.getState();
	useStudioSettingsStore.getState().set({ generationEnabled: false });
	useStudioSettingsStore.getState().set({ generationEnabled: true });
	const after = useStudioSettingsStore.getState();

	expect(after.generationEnabled).toBe(true);
	// The `set` patch API merges — flipping this one flag must not disturb
	// unrelated sticky settings (the store's whole reason for existing).
	expect(after.approvalThresholdCredits).toBe(before.approvalThresholdCredits);
	expect(after.autoReviewEnabled).toBe(before.autoReviewEnabled);
	expect(after.mode).toBe(before.mode);
});
