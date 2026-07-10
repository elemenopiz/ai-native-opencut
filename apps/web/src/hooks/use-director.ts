"use client";

import { useMemo } from "react";
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
	return useMemo(
		() =>
			createDirectorApi(editor, {
				executor: createStudioExecutor(editor),
				backends: fetchBackendCatalog,
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
