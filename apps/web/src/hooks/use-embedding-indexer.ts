/**
 * Auto-index new media assets for visual search.
 *
 * Watches the media manager and indexes any newly-added video/image assets
 * into the local CLIP embedding store. Audio assets are skipped (no visual
 * signal to embed). Indexing runs in the background — failures surface as
 * console warnings, never blocking the editor.
 *
 * Mount this hook once at the editor level (alongside other always-on hooks
 * like `use-keybindings`).
 */

import { useEffect, useRef } from "react";
import { useEditor } from "@/hooks/use-editor";
import { LOCAL_CLIP_MODEL_NAME } from "@/lib/local-ai/local-clip";
import { indexMedia } from "@/services/search/embedding-service";
import {
	isUnderstandingAutorunEnabled,
	understandAssetBatch,
} from "@/services/search/asset-understanding-service";
import {
	selectUnderstandingCandidates,
	UNDERSTANDING_AUTORUN_TICK_CAP,
} from "@/lib/search/understanding-batch";
import {
	listIndexedMediaIds,
	setStatus,
} from "@/services/search/embedding-store";
import type { EmbeddingStatus } from "@/lib/search/embedding-types";
import { usePersonaStore } from "@/stores/persona-store";

export function useEmbeddingIndexer() {
	const editor = useEditor();
	const knownIndexedRef = useRef<Set<string>>(new Set());
	const inflightRef = useRef<Set<string>>(new Set());
	// Understanding-autorun bookkeeping (only used when the opt-in flag is on):
	// ids already handed to a batch this session, whether a batch is running
	// (single-flight, so overlapping ticks can't double-submit), and whether a
	// run hit the credit gate (stop asking — the modal already told the user).
	const understandingSeenRef = useRef<Set<string>>(new Set());
	const understandingRunningRef = useRef(false);
	const understandingGatedRef = useRef(false);

	useEffect(() => {
		let cancelled = false;

		// On mount, hydrate the "already indexed" set so we don't re-index on
		// reload. Filtered to the current model: assets indexed by the retired
		// server backend must NOT count as indexed, so they flow through
		// indexMedia again and get re-embedded into the local vector space.
		listIndexedMediaIds(LOCAL_CLIP_MODEL_NAME)
			.then((ids) => {
				if (cancelled) return;
				knownIndexedRef.current = new Set(ids);
			})
			.catch(() => undefined);

		const tick = async () => {
			if (cancelled) return;
			const assets = editor.media.getAssets();
			const indexedSet = knownIndexedRef.current;
			const inflightSet = inflightRef.current;

			for (const asset of assets) {
				if (indexedSet.has(asset.id) || inflightSet.has(asset.id)) continue;
				if (asset.type !== "video" && asset.type !== "image") {
					// Mark audio/unknown as skipped so we don't keep re-evaluating them.
					indexedSet.add(asset.id);
					setStatus({
						mediaId: asset.id,
						state: "skipped",
						reason: "non-visual media type",
					} satisfies EmbeddingStatus).catch(() => undefined);
					continue;
				}
				if (!asset.url) {
					indexedSet.add(asset.id);
					continue;
				}

				inflightSet.add(asset.id);
				// Fire-and-forget — failures are recorded as EmbeddingStatus "error".
				// Model name is deliberately left to the service default
				// (LOCAL_CLIP_MODEL_NAME): overriding it here with the retired
				// backend's "ViT-B-32" would stamp local vectors with the wrong
				// space and block the automatic re-index of old embeddings.
				indexMedia(asset)
					.catch((err) => {
						console.warn(`[embedding-indexer] failed for ${asset.id}:`, err);
					})
					.finally(() => {
						inflightSet.delete(asset.id);
						indexedSet.add(asset.id);
					});
			}

			// Ingest-time Understanding Pass (role / caption / faces / style),
			// independent of the on-device CLIP embedding above. Gated OFF by
			// default because it bills the paid VLM relay per asset; enable with
			// NEXT_PUBLIC_UNDERSTANDING_AUTORUN=1. This is an opt-in PREFETCH —
			// the demand-driven Director path (`use-director`) is the primary
			// trigger and picks up anything skipped here. CAPPED per tick
			// (UNDERSTANDING_AUTORUN_TICK_CAP) so a bulk import can't burst the
			// paid relay with one call per asset, single-flight so overlapping
			// ticks can't double-submit, and routed through the same credit gate
			// as every paid verb (a 402 stops the autorun for the session).
			// `understandAsset` de-dupes against its own store, so re-submitting
			// an already-understood asset never re-bills.
			if (
				isUnderstandingAutorunEnabled() &&
				!understandingRunningRef.current &&
				!understandingGatedRef.current
			) {
				const seen = understandingSeenRef.current;
				const candidates = selectUnderstandingCandidates(assets, {
					exclude: seen,
					cap: UNDERSTANDING_AUTORUN_TICK_CAP,
				});
				if (candidates.length > 0) {
					for (const a of candidates) seen.add(a.id);
					const personas = usePersonaStore.getState().personas.map((p) => ({
						id: p.id,
						name: p.name,
						descriptor: p.descriptor,
					}));
					understandingRunningRef.current = true;
					understandAssetBatch(candidates, {
						personas,
						shouldContinue: () => !cancelled,
					})
						.then((summary) => {
							if (summary.gated) understandingGatedRef.current = true;
						})
						.catch((err) => {
							console.warn("[asset-understanding] batch failed:", err);
						})
						.finally(() => {
							understandingRunningRef.current = false;
							// Drain the over-cap remainder on a fresh tick (unless gated).
							if (!cancelled && !understandingGatedRef.current) {
								setTimeout(tick, 0);
							}
						});
				}
			}
		};

		// Run on every media change (the manager notifies on add/remove).
		const unsubscribe = editor.media.subscribe(() => {
			// Defer so we don't run during React's commit phase.
			setTimeout(tick, 0);
		});

		// Kick off immediately in case assets were loaded before subscription.
		setTimeout(tick, 500);

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [editor]);
}
