"use client";

/**
 * E2E test bridge — a zero-UI seam that exposes the *real* editor singleton and
 * the *real* slot-generation orchestrator on `window` so a Playwright happy-path
 * smoke test can drive the critical path deterministically and assert genuine
 * store + DOM state at each stage.
 *
 * This renders `null` and is a hard no-op unless `NEXT_PUBLIC_E2E === "1"`, so it
 * ships nothing to production users. The only behaviour it changes under the flag
 * is replacing `renderer.exportProject` with a fast, deterministic stub — the
 * heavy canvas/ffmpeg encode is out of scope for a smoke test, which only needs
 * to prove that export *kicks off* a render (delegates to the renderer and flips
 * the project's export state). Everything else it exposes is the untouched
 * production code path.
 *
 * The export stub itself is opt-OUT via `NEXT_PUBLIC_E2E_STUB_EXPORT=0`: a perf
 * bench that wants the E2E build's scripted setup surface (window-exposed
 * `editor`) and the optional-auth middleware bypass (proxy.ts's E2E_BUILD
 * early-return — there's no access code to bypass anymore, just the
 * `/account` session redirect), but needs the *real* canvas/mediabunny/
 * WebCodecs export path for genuine timing, can build with
 * `NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_E2E_STUB_EXPORT=0` instead of maintaining a
 * separate throwaway build (both flags are inlined at build time, like every
 * NEXT_PUBLIC_* var). Defaults to stubbed (matching prior behavior) so every
 * existing Playwright spec keeps passing unchanged.
 */

import { useEffect } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useSlotGeneration } from "@/hooks/use-slot-generation";
import { useScrubAudio } from "@/hooks/audio/use-scrub-audio";
import type { EditorCore } from "@/core";
import type { ScrubPlayer } from "@/lib/audio/scrub-player";
import { stretchAudioBufferSegment } from "@/lib/media/pitch-preserving-stretch";
import { perfStats } from "@/services/renderer/perf-stats";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import { useBeatGridStore } from "@/stores/beat-grid-store";
import { useFrameChainStore } from "@/stores/frame-chain-store";
import { useGenerationStatusStore } from "@/stores/generation-status-store";
import { useTranscriptStore } from "@/stores/transcript-store";
import type { ExportOptions, ExportResult } from "@/types/export";
import type { GenerationSpec } from "@/types/timeline";

const E2E_ENABLED = process.env.NEXT_PUBLIC_E2E === "1";
/** Opt-out flag: set NEXT_PUBLIC_E2E_STUB_EXPORT=0 to run the real exporter
 *  under an E2E build. Unset/anything else ⇒ stub (prior behavior). */
const E2E_STUB_EXPORT = process.env.NEXT_PUBLIC_E2E_STUB_EXPORT !== "0";

export interface E2EBridge {
	/** True once the bridge has wired everything up. */
	ready: boolean;
	editor: EditorCore;
	/** The genuine `useSlotGeneration().generateIntoSlot` — real take bookkeeping
	 *  + the shared provider engine (hits the mocked `/api/studio/*` routes). */
	generateIntoSlot: (params: {
		elementId: string;
		spec: GenerationSpec;
		alternatives?: number;
	}) => Promise<{ ok: number; failed: number }>;
	/** Records every export the (stubbed) renderer received, for assertions. */
	exportCalls: Array<{ options: ExportOptions }>;
	/** Unblocks the in-flight stubbed render. Lets the test observe the
	 *  "export kicked off / isExporting" window before letting it complete. */
	releaseExport: () => void;
	/** True when `renderer.exportProject` is still swapped for the
	 *  deterministic stub (i.e. `NEXT_PUBLIC_E2E_STUB_EXPORT` was NOT set to
	 *  `"0"` at build time). A real-export spec must read this first and
	 *  self-skip when it's true — driving the stub through the real-export
	 *  flow would just hang on `releaseExport()` never being called. */
	stubExport: boolean;
	/** Only meaningful when `stubExport` is false. The export button's own
	 *  success handler clears `editor.project.getExportState().result`
	 *  synchronously right after a successful export (see
	 *  `export-button.tsx`'s `handleExport`), so that store field is too
	 *  racy for a test to read. This returns the most recently completed
	 *  *real* `exportProject` call's result (buffer included) instead —
	 *  captured directly at the renderer seam, before the UI gets a chance
	 *  to consume and clear it. Null before any real export has completed. */
	getLastExportResult: () => ExportResult | null;
	/** The REAL pitch-preserving stretch seam (shared by preview + export), so
	 *  the audible-correctness e2e can render through the genuine WASM worklet
	 *  and assert dominant frequency is preserved across a speed change. */
	stretchAudioBufferSegment: typeof stretchAudioBufferSegment;
	/** Preview compositor frame telemetry — the same singleton the perf HUD
	 *  reads, so a headless run can enable collection and assert on fps /
	 *  frame-time breakdowns without any UI interaction. */
	perf: typeof perfStats;
	/** Module-global zustand stores holding PER-PROJECT state, exposed so a
	 *  project-switch test can seed one project's state and assert it does not
	 *  bleed into the next (see `stores/reset-project-scoped-stores.ts`). These
	 *  are the untouched production store singletons, not copies. */
	projectScopedStores: {
		transcript: typeof useTranscriptStore;
		beatGrid: typeof useBeatGridStore;
		generationStatus: typeof useGenerationStatusStore;
		frameChain: typeof useFrameChainStore;
		backgroundTasks: typeof useBackgroundTasksStore;
	};
	/** The real ScrubPlayer singleton driving grain-based audible scrub
	 *  (§4.2 palmier-delta-refresh-2026-07-14.md) — same instance the
	 *  playhead-drag and arrow-key paths use (shared via the WeakMap in
	 *  hooks/audio/use-scrub-audio.ts). Exposes grainStartCount/lastDirection
	 *  so a headless run can assert grains were scheduled + which direction,
	 *  without needing to actually hear audio. */
	scrubPlayer: ScrubPlayer;
}

declare global {
	interface Window {
		__BYORN_E2E__?: E2EBridge;
		/** Shorthand alias for `__BYORN_E2E__.perf` (same flag-gated seam). */
		__byornPerf?: typeof perfStats;
	}
}

export function E2EBridge() {
	// Hooks must run unconditionally; the flag gates only the side effects.
	const editor = useEditor();
	const { generateIntoSlot } = useSlotGeneration();
	const scrubAudio = useScrubAudio();

	useEffect(() => {
		if (!E2E_ENABLED || typeof window === "undefined") return;

		const exportCalls: Array<{ options: ExportOptions }> = [];
		let releaseExport = () => {};
		let lastExportResult: ExportResult | null = null;

		// Swap the real (canvas + ffmpeg) encoder for a deterministic stub so the
		// export flow is CI-runnable. project.export() still runs for real: it
		// flips isExporting, calls this, and reports progress — that's the
		// "export kicks off a render" contract under test. The stub parks at
		// progress 0 until the test calls releaseExport(), so the transient
		// "Exporting" DOM/store state is deterministically observable.
		//
		// Gated by E2E_STUB_EXPORT so a perf bench can flip it off and exercise
		// the genuine export path under the same E2E build (see file header).
		const renderer = editor.renderer as unknown as {
			exportProject: (args: {
				options: ExportOptions;
				onProgress?: (p: { progress: number }) => void;
				onCancel?: () => boolean;
			}) => Promise<ExportResult>;
		};
		const realExportProject = renderer.exportProject.bind(editor.renderer);
		if (E2E_STUB_EXPORT) {
			renderer.exportProject = async ({ options, onProgress }) => {
				exportCalls.push({ options });
				onProgress?.({ progress: 0 });
				await new Promise<void>((resolve) => {
					releaseExport = () => {
						onProgress?.({ progress: 1 });
						resolve();
					};
				});
				return { success: true, buffer: new ArrayBuffer(1024) };
			};
		} else {
			// Real-export builds: don't touch behavior, just tap the resolved
			// result so a test can read it after the UI's own success handler
			// has already cleared `project.getExportState().result` (see
			// `getLastExportResult` doc above).
			renderer.exportProject = async (args) => {
				const result = await realExportProject(args);
				lastExportResult = result;
				return result;
			};
		}

		window.__BYORN_E2E__ = {
			ready: true,
			editor,
			generateIntoSlot,
			exportCalls,
			releaseExport: () => releaseExport(),
			stubExport: E2E_STUB_EXPORT,
			getLastExportResult: () => lastExportResult,
			stretchAudioBufferSegment,
			perf: perfStats,
			projectScopedStores: {
				transcript: useTranscriptStore,
				beatGrid: useBeatGridStore,
				generationStatus: useGenerationStatusStore,
				frameChain: useFrameChainStore,
				backgroundTasks: useBackgroundTasksStore,
			},
			scrubPlayer: scrubAudio.player,
		};
		window.__byornPerf = perfStats;

		return () => {
			renderer.exportProject =
				realExportProject as typeof renderer.exportProject;
			delete window.__BYORN_E2E__;
			delete window.__byornPerf;
		};
	}, [editor, generateIntoSlot, scrubAudio.player]);

	return null;
}
