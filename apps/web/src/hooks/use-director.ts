"use client";

import { useEffect, useMemo } from "react";
import { useEditor } from "@/hooks/use-editor";
import {
	createDirectorApi,
	type BackendCatalogEntry,
	type DirectorApi,
} from "@/lib/director/director-api";
import { createStudioExecutor } from "@/lib/director/studio-executor";
import { callVisionRelay } from "@/lib/director/agent";
import { createVisionTakeCritic } from "@/lib/director/take-critic-adapter";
import { extractTakeFrames } from "@/lib/media/last-frame";
import {
	clearUnderstandingCache,
	manifestUnderstandingLookup,
	primeUnderstandingCache,
	styleProbeLookup,
} from "@/lib/director/understanding-lookup";
import { selectUnderstandingCandidates } from "@/lib/search/understanding-batch";
import { understandAssetBatch } from "@/services/search/asset-understanding-service";
import { usePersonaStore } from "@/stores/persona-store";
import type { EditorCore } from "@/core";
import { toast } from "sonner";

/**
 * Read-through to the client-safe backend catalog (`GET /api/studio/backends`) —
 * the SAME endpoint `useBackends` renders in the UI. Handed to the Director so the
 * agent's `getBackends` verb sees the exact models the user does (availability +
 * capabilities + relative cost tier), never a provider key. Kept out of the
 * server registry deliberately: the Director is browser-side pure logic.
 */
async function fetchBackendCatalog(
	modality?: "video" | "image",
): Promise<BackendCatalogEntry[]> {
	const qs = modality ? `?modality=${modality}` : "";
	const res = await fetch(`/api/studio/backends${qs}`);
	if (!res.ok) throw new Error(`Failed to load backends (${res.status})`);
	const data = (await res.json()) as { backends?: BackendCatalogEntry[] };
	return data.backends ?? [];
}

/**
 * Demand-driven Understanding Pass — the PRIMARY trigger for the paid per-asset
 * VLM pass. Fires when the Director mounts (i.e. the user just asked for the
 * Director, which is exactly when the Asset Manifest needs real grounding
 * instead of its media-type-count fallback) and again whenever media is added
 * while the Director is up.
 *
 * Mechanics, in the order the safety properties depend on them:
 *  - single-flight per mount (`running`/`queued`): media-change bursts collapse
 *    into one follow-up run instead of overlapping batches.
 *  - selection excludes assets the primed sync cache already covers AND ids
 *    attempted this mount, so a failing asset can't hot-loop; the store-level
 *    de-dupe inside `understandAsset` is the billing backstop regardless.
 *  - `understandAssetBatch` runs sequentially, routes a 402 through the credit
 *    gate (out-of-credits modal, same as other paid verbs), and each success
 *    upserts the sync cache — so `getProjectInfo` sees results mid-session,
 *    no remount needed.
 *  - once gated, this mount stops triggering entirely (buying credits +
 *    re-engaging the Director starts fresh); editing is never blocked.
 *  - progress is a single sonner toast, updated in place and resolved on
 *    completion — visible but non-blocking, like the studio-handoff import.
 */
function createUnderstandingRunner(editor: EditorCore) {
	let cancelled = false;
	let running = false;
	let queued = false;
	let gated = false;
	const attempted = new Set<string>();

	const run = async () => {
		if (cancelled || gated) return;
		if (running) {
			queued = true;
			return;
		}
		// Skip assets the manifest can already see (primed/upserted sync cache)
		// plus everything attempted this mount.
		const assets = editor.media.getAssets();
		const exclude = new Set(attempted);
		for (const a of assets) {
			if (manifestUnderstandingLookup(a.id)) exclude.add(a.id);
		}
		const candidates = selectUnderstandingCandidates(assets, { exclude });
		if (candidates.length === 0) return;

		running = true;
		for (const a of candidates) attempted.add(a.id);
		// Persona roster snapshot, mirrored from the import-time hook — the VLM
		// reconciles detected faces against these.
		const personas = usePersonaStore.getState().personas.map((p) => ({
			id: p.id,
			name: p.name,
			descriptor: p.descriptor,
		}));

		const total = candidates.length;
		const toastId = toast.loading(
			`Understanding ${total} asset${total > 1 ? "s" : ""}…`,
		);
		let done = 0;
		try {
			const summary = await understandAssetBatch(candidates, {
				personas,
				shouldContinue: () => !cancelled,
				onAssetComplete: () => {
					done += 1;
					if (done < total) {
						toast.loading(`Understanding assets… (${done}/${total})`, {
							id: toastId,
						});
					}
				},
			});
			if (summary.gated) {
				// The gate already opened the out-of-credits modal; the toast just
				// explains why the run stopped. Stay gated for this mount.
				gated = true;
				toast.warning("Understanding paused — out of credits.", {
					id: toastId,
				});
			} else if (summary.understood > 0) {
				toast.success(
					`Understood ${summary.understood} of ${total} asset${total > 1 ? "s" : ""}.`,
					{ id: toastId },
				);
			} else {
				// Nothing usable (unmounted mid-run, or every asset failed softly) —
				// drop the toast; per-asset failures are already console-warned.
				toast.dismiss(toastId);
			}
		} catch {
			toast.error("Asset understanding failed.", { id: toastId });
		} finally {
			running = false;
			if (queued && !cancelled && !gated) {
				queued = false;
				setTimeout(() => void run(), 0);
			}
		}
	};

	return {
		run: () => void run(),
		cancel: () => {
			cancelled = true;
		},
	};
}

/**
 * The Director API wired to the real generation executor — the in-house,
 * MCP-style control layer over the reel. Optional (off by default); the UI
 * surfaces it only when the Director toggle is on.
 *
 * `backends` powers cost/quality-aware model routing (the `getBackends` verb and
 * the `backendId` pins on generate/reroll/compareTake). `critic` wires D1's vision
 * critic (via `createVisionTakeCritic`) to the real relay + frame extraction, so
 * `compareTake` AUTO-PICKS the winning A/B take; if the relay/vision call fails it
 * degrades to presenting both takes for the user to choose.
 */
export function useDirector(): DirectorApi {
	const editor = useEditor();
	// Populate the synchronous understanding cache the faceted library manifest
	// reads each turn (`getProjectInfo` → `buildLibraryManifest`). The store is
	// global (keyed by mediaId, not project-scoped), so priming once on mount
	// loads every understood asset; cleared on unmount. THEN run the
	// demand-driven Understanding Pass over whatever the prime didn't cover —
	// engaging the Director is the moment paying for grounding is worth it —
	// and re-run it for media imported while the Director stays mounted (the
	// media manager notifies on add; the runner and the store both de-dupe, so
	// re-runs are cheap and never re-bill).
	useEffect(() => {
		const runner = createUnderstandingRunner(editor);
		void primeUnderstandingCache().then(runner.run);
		const unsubscribe = editor.media.subscribe(() => {
			// Defer so we don't run during React's commit phase.
			setTimeout(runner.run, 0);
		});
		return () => {
			runner.cancel();
			unsubscribe();
			clearUnderstandingCache();
		};
	}, [editor]);
	return useMemo(
		() =>
			createDirectorApi(editor, {
				executor: createStudioExecutor(editor),
				backends: fetchBackendCatalog,
				understanding: manifestUnderstandingLookup,
				styleProbe: styleProbeLookup,
				critic: createVisionTakeCritic({
					relay: callVisionRelay,
					extractFrames: ({ takeId, mediaId }) =>
						mediaId
							? extractTakeFrames(editor.media.getAssetById(mediaId), {
									count: 3,
									name: takeId,
								})
							: Promise.resolve([]),
				}),
			}),
		[editor],
	);
}
