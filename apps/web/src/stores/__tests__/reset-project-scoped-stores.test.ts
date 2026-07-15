import { describe, expect, test } from "bun:test";
import { resetProjectScopedStores } from "@/stores/reset-project-scoped-stores";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import { useBeatGridStore } from "@/stores/beat-grid-store";
import { useEngagementStore } from "@/stores/engagement-store";
import { useFrameChainStore } from "@/stores/frame-chain-store";
import { useGenerationStatusStore } from "@/stores/generation-status-store";
import { useOmniReferenceChainStore } from "@/stores/omni-reference-chain-store";
import { usePenMaskStore } from "@/stores/pen-mask-store";
import { usePropertiesStore } from "@/stores/properties-store";
import { useSearchStore } from "@/stores/search-store";
import { useTimelineStore } from "@/stores/timeline-store";
import { useTranscriptStore } from "@/stores/transcript-store";
import { useArrangementHandoffStore } from "@/stores/arrangement-handoff-store";
import type { EngagementScoreResult } from "@/lib/ai-client";
import type { Arrangement } from "@/types/arrangement";
import type { ClipboardItem } from "@/types/timeline";

// Pins the project-switch store-bleed fix (2026-07-14 perf audit, axis 6 §2e):
// EditorCore is a reused singleton across client-side project switches, so
// every module-global store holding per-project state must be wiped by
// `resetProjectScopedStores()` — the generalization of the shipped
// transcript-store leak fix.

function seedProjectScopedState() {
	useTranscriptStore.getState().setSegments([
		{
			id: 0,
			text: "old project caption",
			start: 0,
			end: 1,
			words: [],
		},
	]);
	useBeatGridStore.getState().setGrid({
		elementId: "old-element",
		trackId: "old-track",
		mediaId: "old-media",
		beats: [0.5, 1.0],
		downbeats: [0.5],
		bpm: 120,
		energyClass: "high",
		analyzedAt: Date.now(),
	});
	useBeatGridStore.getState().setAnalyzing(true);
	useGenerationStatusStore.getState().setStatus("old-job", {
		status: "processing",
	});
	useFrameChainStore.getState().setPendingFirstFrame({
		url: "https://r2.example/frame.png",
		label: "clip — last frame",
	});
	useOmniReferenceChainStore.getState().setPendingReference({
		url: "https://r2.example/ref.mp4",
		kind: "video",
		label: "clip — trimmed",
	});
	useBackgroundTasksStore.getState().addTask({
		id: "task-1",
		type: "transcription",
		label: "Transcribing",
		progress: "50%",
	});
	useSearchStore.getState().requestFindSimilar("old-media");
	useEngagementStore
		.getState()
		.setScore({ score: 82 } as unknown as EngagementScoreResult);
	usePenMaskStore.getState().startDrawing("old-element");
	useTimelineStore.getState().setClipboard({
		items: [
			{
				trackId: "old-track",
				trackType: "video",
				element: { mediaId: "old-media" },
			} as unknown as ClipboardItem,
		],
	});
	usePropertiesStore
		.getState()
		.openClipEffects({ elementId: "old-element", trackId: "old-track" });
	useAssetsPanelStore.getState().requestRevealMedia("old-media");
}

describe("resetProjectScopedStores", () => {
	test("wipes every project-scoped store", () => {
		seedProjectScopedState();

		resetProjectScopedStores();

		expect(useTranscriptStore.getState().segments).toHaveLength(0);
		expect(useBeatGridStore.getState().grid).toBeNull();
		expect(useBeatGridStore.getState().isAnalyzing).toBe(false);
		expect(useGenerationStatusStore.getState().statusMap).toEqual({});
		expect(useFrameChainStore.getState().pendingFirstFrame).toBeNull();
		expect(useOmniReferenceChainStore.getState().pendingReference).toBeNull();
		expect(useBackgroundTasksStore.getState().tasks).toHaveLength(0);
		expect(useSearchStore.getState().pendingFindSimilarMediaId).toBeNull();
		expect(useEngagementStore.getState().currentScore).toBeNull();
		expect(usePenMaskStore.getState().drawingElementId).toBeNull();
		expect(useTimelineStore.getState().clipboard).toBeNull();
		expect(usePropertiesStore.getState().clipEffectsTarget).toBeNull();
		expect(useAssetsPanelStore.getState().highlightMediaId).toBeNull();
	});

	test("clears the element clipboard so a paste after switching projects can't dangle-reference the old project's mediaId", () => {
		useTimelineStore.getState().setClipboard({
			items: [
				{
					trackId: "old-track",
					trackType: "video",
					element: { mediaId: "old-project-media-id" },
				} as unknown as ClipboardItem,
			],
		});
		expect(useTimelineStore.getState().clipboard).not.toBeNull();

		resetProjectScopedStores();

		expect(useTimelineStore.getState().clipboard).toBeNull();
	});

	test("keeps user preferences that live next to project state", () => {
		useBeatGridStore.getState().toggleBeatSnapping();
		const snapBefore = useBeatGridStore.getState().beatSnappingEnabled;
		useBackgroundTasksStore.getState().setMinimized(true);

		resetProjectScopedStores();

		expect(useBeatGridStore.getState().beatSnappingEnabled).toBe(snapBefore);
		expect(useBackgroundTasksStore.getState().isMinimized).toBe(true);
	});

	test("stops live generation poll intervals so the next project can re-poll the same job id", async () => {
		let polls = 0;
		const pollFn = async () => {
			polls += 1;
		};

		useGenerationStatusStore.getState().startPolling("job-x", pollFn);
		// startPolling invokes pollFn once immediately.
		await Promise.resolve();
		expect(polls).toBe(1);

		// A second start is deduped while the interval is live.
		useGenerationStatusStore.getState().startPolling("job-x", pollFn);
		await Promise.resolve();
		expect(polls).toBe(1);

		resetProjectScopedStores();

		// After reset the interval bookkeeping is gone: the same job id polls
		// fresh (no dedup hit, no stale terminal status).
		useGenerationStatusStore.getState().startPolling("job-x", pollFn);
		await Promise.resolve();
		expect(polls).toBe(2);

		useGenerationStatusStore.getState().stopPolling("job-x");
	});

	test("does NOT clear cross-route handoff queues (they must survive into the next project)", () => {
		const arrangement = { id: "arr-1" } as unknown as Arrangement;
		useArrangementHandoffStore.getState().setPending(arrangement);

		resetProjectScopedStores();

		expect(useArrangementHandoffStore.getState().pending).toEqual(arrangement);
		useArrangementHandoffStore.getState().clear();
	});
});
