"use client";

import { useCallback, useState } from "react";
import type { EditorCore } from "@/core";
import { apiFetch } from "@/lib/auth/unauthorized";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import { waitForJobTerminal } from "@/stores/generation-status-store";

export interface BoardItem {
	id: string;
	kind: "take" | "image";
	takeId: string | null;
	imageStillId: string | null;
	notes: string | null;
	createdAt: string;
	take: {
		id: string;
		setId: string;
		seed: number | null;
		resolution: string;
		thumbnailUrl: string | null;
		videoUrl: string | null;
		status: string;
		errorMessage: string | null;
	} | null;
	set: { prompt: string; orientation: string } | null;
	image: {
		id: string;
		prompt: string;
		imageUrl: string | null;
		size: string;
	} | null;
}

/** Best-effort parse of a route's `{ error?: string }` failure body, for
 *  callers that want to surface the server's message rather than a generic
 *  one (mirrors the convention in `useStudioGeneration`). */
async function errorMessage(res: Response, fallback: string): Promise<string> {
	try {
		const data = (await res.json()) as { error?: string };
		return data.error ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * The Board's data source: everything currently parked in `boardItems`,
 * waiting for the user to star a winner into Assets or dismiss it. Deletes
 * items it currently holds are one-way — undoing a star means deleting the
 * asset normally afterward, not un-starring here (see the design doc).
 *
 * Mutating actions (`promoteToAssets`/`dismiss`/`promoteTo1080p`) throw on
 * failure instead of failing silently, matching `useStudioGeneration`'s
 * `promoteTo1080p` convention — callers are expected to catch and surface
 * the error (e.g. a toast) rather than have a draft silently vanish or get
 * corrupted.
 */
export function useBoardItems({
	editor,
	projectId,
}: {
	editor: EditorCore;
	projectId: string | null;
}) {
	const [items, setItems] = useState<BoardItem[]>([]);
	const [loading, setLoading] = useState(false);

	const refetch = useCallback(async () => {
		setLoading(true);
		try {
			const res = await apiFetch("/api/studio/board");
			if (!res.ok) return;
			const data = (await res.json()) as { items: BoardItem[] };
			setItems(data.items);
		} catch (err) {
			// Best-effort, like useStudioGeneration's loadHistory: a failed
			// refresh leaves the last-known items in place instead of throwing
			// out of a background/effect-driven call.
			console.error("Failed to load board items:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	// Promote a draft to Assets, then drop it from the pending queue.
	const promoteToAssets = useCallback(
		async (item: BoardItem) => {
			if (!projectId) throw new Error("No active project");
			const url =
				item.kind === "take" ? item.take?.videoUrl : item.image?.imageUrl;
			if (!url) throw new Error("Draft has no media to save");
			const name =
				(item.kind === "take" ? item.set?.prompt : item.image?.prompt) ||
				"Generated";

			const { added, failed } = await addItemsToProjectMedia({
				editor,
				projectId,
				items: [{ url, name, kind: item.kind === "take" ? "video" : "image" }],
				source: "ai",
			});
			// The board item is this draft's only pointer — only drop it once the
			// save has actually landed. Deleting it after a failed add would lose
			// the draft outright with nothing left pointing back to it.
			if (added === 0 || failed > 0) {
				throw new Error("Failed to add the draft to Assets");
			}

			const res = await apiFetch(`/api/studio/board?id=${item.id}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				throw new Error(
					await errorMessage(res, "Failed to remove the draft from Board"),
				);
			}
			await refetch();
		},
		[editor, projectId, refetch],
	);

	// Discard a draft without saving it anywhere.
	const dismiss = useCallback(
		async (item: BoardItem) => {
			const res = await apiFetch(`/api/studio/board?id=${item.id}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				throw new Error(await errorMessage(res, "Failed to dismiss draft"));
			}
			await refetch();
		},
		[refetch],
	);

	// Re-fire a video draft at 1080p, then swap the pin over to the new take
	// once it lands (the promote endpoint always creates a new take row under
	// the same generation set — it doesn't touch boardItems itself).
	const promoteTo1080p = useCallback(
		async (item: BoardItem) => {
			if (item.kind !== "take" || !item.takeId) return;
			try {
				const res = await apiFetch(`/api/studio/takes/${item.takeId}/promote`, {
					method: "POST",
				});
				if (!res.ok) {
					throw new Error(await errorMessage(res, "Promote failed"));
				}
				const data = (await res.json()) as {
					takeId: string;
					jobId: string;
					status: string;
				};

				if (data.status !== "completed") {
					const outcome = await waitForJobTerminal(data.jobId);
					if (outcome === "timeout") {
						throw new Error("1080p promotion timed out");
					}
					if (outcome.status === "failed") {
						throw new Error(outcome.error ?? "1080p promotion failed");
					}
				}

				// Pin the new 1080p take BEFORE unpinning the old one. The promote
				// endpoint has already reserved/settled real credits and persisted
				// this take row by this point — if the pin swap fails partway
				// through, the paid-for take must still be reachable somewhere.
				// POST-then-DELETE means the worst case is a harmless duplicate
				// board entry (cleanable via `dismiss`); DELETE-then-POST would
				// instead risk orphaning a paid take with zero UI pointing at it
				// (the Takes tab that used to be a fallback is going away too).
				const pinRes = await apiFetch("/api/studio/board", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ takeId: data.takeId }),
				});
				if (!pinRes.ok) {
					throw new Error(
						await errorMessage(pinRes, "Failed to pin the 1080p take to Board"),
					);
				}

				const deleteRes = await apiFetch(`/api/studio/board?id=${item.id}`, {
					method: "DELETE",
				});
				if (!deleteRes.ok) {
					throw new Error(
						await errorMessage(
							deleteRes,
							"Failed to remove the draft from Board",
						),
					);
				}
			} finally {
				// Refetch regardless of outcome: a throw here can land after a
				// state-changing call already succeeded server-side (e.g. the pin
				// landed but the delete failed), so leaving `items` stale would
				// show the user pre-failure state and set up a confusing retry.
				await refetch();
			}
		},
		[refetch],
	);

	return { items, loading, refetch, promoteToAssets, dismiss, promoteTo1080p };
}
