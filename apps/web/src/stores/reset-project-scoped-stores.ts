/**
 * Reset every module-global zustand store that holds PER-PROJECT state.
 *
 * EditorCore is a reused singleton across client-side project switches, and
 * these stores are module globals — nothing unmounts them when the route's
 * `[project_id]` changes. Without an explicit reset, the previous project's
 * state bleeds into the newly-opened one: a beat grid pinned to the old
 * project's element ids, live generation poll intervals for the old project's
 * jobs, a pending frame/omni-reference chain that would seed the NEW project's
 * next generation, stale background tasks / search requests,
 * or a copied clip on the element clipboard that still points at the old
 * project's mediaId (paste inserts it verbatim — see
 * lib/commands/timeline/clipboard/paste.ts — producing a dangling,
 * invisible element with no validation against the new project's assets).
 * Same bug class as the shipped transcript-store leak this generalizes
 * (2026-07-14 perf audit, axis 6 §2e).
 *
 * Called from `EditorProvider.loadProject` (components/providers/
 * editor-provider.tsx) right after `editor.project.loadProject` resolves —
 * the same seam that already reset the transcript store. Restore effects that
 * repopulate from the new project's own data (e.g. the editor page's
 * transcript-restore effect) run after this, against clean stores.
 *
 * Intentionally NOT reset:
 * - `useArrangementStore` — the user's persisted cross-project arrangement
 *   library (localStorage), not project state.
 * - `useArrangementHandoffStore` / `useStudioHandoffStore` — cross-route
 *   handoff queues whose whole purpose is to survive INTO the next project;
 *   clearing them here would break "open arrangement/generation in a new
 *   project". Their consumers drain them after project load.
 * - UI-preference stores (panels, keybindings, studio settings, playback
 *   prefs) — user-scoped, not project-scoped.
 *
 * Director-revamp Item 9 (F-local conversation persistence): `useAIStore`'s
 * `studioMessages` was the exact same bug class — a flat, un-scoped array —
 * before that pass wired `resetForProjectSwitch()` in here. The PERSISTED
 * conversations (IndexedDB, project-scoped by design) are untouched by this;
 * only the live in-memory chat view resets, same as everything else here.
 */

import { useAIStore } from "@/stores/ai-store";
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
import { useYouTubeReelsStore } from "@/stores/youtube-reels-store";

export function resetProjectScopedStores(): void {
	useTranscriptStore.getState().reset();
	useBeatGridStore.getState().reset();
	// Also clears the module-level poll-interval map, so no interval keeps
	// firing for the previous project's generation jobs.
	useGenerationStatusStore.getState().reset();
	useFrameChainStore.getState().clearPendingFirstFrame();
	useOmniReferenceChainStore.getState().clearPendingReference();
	useBackgroundTasksStore.getState().reset();
	useSearchStore.getState().reset();
	useEngagementStore.getState().clear();
	// Stops the YouTube-reels job poll timer too.
	useYouTubeReelsStore.getState().reset();
	usePenMaskStore.getState().reset();
	// The element clipboard holds full elements (incl. mediaId) copied from
	// whichever project was open at copy time; pasting after a project switch
	// would otherwise dangle-reference the old project's assets.
	useTimelineStore.getState().setClipboard(null);
	usePropertiesStore.getState().closeClipEffects();
	useAssetsPanelStore.getState().clearHighlight();
	// The live Director chat view (item 9, F-local) — resets so the previous
	// project's conversation never bleeds onto the newly-opened one; the
	// editor page's Director view then lazily attaches a (new or existing)
	// conversation for THIS project on its own next message.
	useAIStore.getState().resetForProjectSwitch();
}
