"use client";

import { useCallback, useEffect, useState } from "react";
import { isAssetRef } from "@/lib/studio/asset-ref";

/**
 * The owner's personal shortlist of BytePlus verified real-human assets.
 *
 * BytePlus exposes no API to list your real-human assets — they're managed in
 * the ModelArk console and consumed by `asset://<id>` URI. So Byorn can't
 * auto-fetch them; instead the owner pastes an asset URI once and we remember
 * it here for one-click reuse. Owner-scoped (all assets live under the single
 * BytePlus account behind BYTEPLUS_API_KEY), persisted per-browser in
 * localStorage — no secrets, just labels + already-public asset ids.
 */
export interface SavedVerifiedAsset {
	id: string;
	/** `asset://asset-…` URI passed to Seedance. */
	uri: string;
	label: string;
	kind: "image" | "video";
}

const STORAGE_KEY = "byorn.verified-assets.v1";

/** Auto-generated label (no user input) — safe to regenerate on a kind change. */
const AUTO_LABEL = /^Verified (image|video)$/;

/**
 * Append an asset, de-duplicated by URI. Re-pasting a URI that's already saved
 * UPDATES the entry's kind (and label) in place instead of no-op'ing — the kind
 * can't be inferred from an opaque BytePlus asset id, so re-adding with the
 * correct type toggled is the only way to fix a mislabeled asset. An empty
 * incoming label keeps an existing custom label but regenerates an
 * auto-generated one so it never contradicts the corrected kind.
 */
export function upsertSavedAsset(
	list: SavedVerifiedAsset[],
	asset: SavedVerifiedAsset,
): SavedVerifiedAsset[] {
	if (!isAssetRef(asset.uri)) return list;
	const fallbackLabel = (existing: string) =>
		AUTO_LABEL.test(existing) ? `Verified ${asset.kind}` : existing;
	const existing = list.find((a) => a.uri === asset.uri);
	if (existing) {
		const label = asset.label.trim() || fallbackLabel(existing.label);
		if (existing.kind === asset.kind && existing.label === label) return list;
		return list.map((a) =>
			a.uri === asset.uri ? { ...a, kind: asset.kind, label } : a,
		);
	}
	return [
		...list,
		{ ...asset, label: asset.label.trim() || `Verified ${asset.kind}` },
	];
}

export function removeSavedAsset(
	list: SavedVerifiedAsset[],
	id: string,
): SavedVerifiedAsset[] {
	return list.filter((a) => a.id !== id);
}

/** Tolerant parse — a corrupt/foreign value yields an empty list, never throws. */
export function parseSavedAssets(raw: string | null): SavedVerifiedAsset[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(a): a is SavedVerifiedAsset =>
				a &&
				typeof a.id === "string" &&
				typeof a.uri === "string" &&
				isAssetRef(a.uri) &&
				(a.kind === "image" || a.kind === "video"),
		);
	} catch {
		return [];
	}
}

/**
 * localStorage-backed store of saved verified assets. SSR-safe (reads only in
 * an effect), and each mutation persists synchronously so a reload restores the
 * shortlist.
 */
export function useSavedVerifiedAssets() {
	const [assets, setAssets] = useState<SavedVerifiedAsset[]>([]);

	useEffect(() => {
		setAssets(parseSavedAssets(localStorage.getItem(STORAGE_KEY)));
	}, []);

	const persist = useCallback((next: SavedVerifiedAsset[]) => {
		setAssets(next);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// Quota/private-mode failures shouldn't break the picker; the
			// in-memory list still works for this session.
		}
	}, []);

	const add = useCallback((asset: Omit<SavedVerifiedAsset, "id">) => {
		setAssets((prev) => {
			const next = upsertSavedAsset(prev, {
				...asset,
				id: crypto.randomUUID(),
			});
			if (next !== prev) {
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
				} catch {}
			}
			return next;
		});
	}, []);

	const remove = useCallback((id: string) => {
		setAssets((prev) => {
			const next = removeSavedAsset(prev, id);
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {}
			return next;
		});
	}, []);

	return { assets, add, remove, persist };
}
