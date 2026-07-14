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
 */

import { useEffect } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useSlotGeneration } from "@/hooks/use-slot-generation";
import type { EditorCore } from "@/core";
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

	useEffect(() => {
		if (!E2E_ENABLED || typeof window === "undefined") return;

		const exportCalls: Array<{ options: ExportOptions }> = [];
		let releaseExport = () => {};

		// Swap the real (canvas + ffmpeg) encoder for a deterministic stub so the
		// export flow is CI-runnable. project.export() still runs for real: it
		// flips isExporting, calls this, and reports progress — that's the
		// "export kicks off a render" contract under test. The stub parks at
		// progress 0 until the test calls releaseExport(), so the transient
		// "Exporting" DOM/store state is deterministically observable.
		const renderer = editor.renderer as unknown as {
			exportProject: (args: {
				options: ExportOptions;
				onProgress?: (p: { progress: number }) => void;
				onCancel?: () => boolean;
			}) => Promise<ExportResult>;
		};
		const realExportProject = renderer.exportProject.bind(editor.renderer);
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

		window.__BYORN_E2E__ = {
			ready: true,
			editor,
			generateIntoSlot,
			exportCalls,
			releaseExport: () => releaseExport(),
			stretchAudioBufferSegment,
			perf: perfStats,
			projectScopedStores: {
				transcript: useTranscriptStore,
				beatGrid: useBeatGridStore,
				generationStatus: useGenerationStatusStore,
				frameChain: useFrameChainStore,
				backgroundTasks: useBackgroundTasksStore,
			},
		};
		window.__byornPerf = perfStats;

		return () => {
			renderer.exportProject =
				realExportProject as typeof renderer.exportProject;
			delete window.__BYORN_E2E__;
			delete window.__byornPerf;
		};
	}, [editor, generateIntoSlot]);

	return null;
}
