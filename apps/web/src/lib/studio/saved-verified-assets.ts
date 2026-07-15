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

/** Append an asset, de-duplicated by URI (re-saving the same asset is a no-op). */
export function upsertSavedAsset(
	list: SavedVerifiedAsset[],
	asset: SavedVerifiedAsset,
): SavedVerifiedAsset[] {
	if (!isAssetRef(asset.uri)) return list;
	if (list.some((a) => a.uri === asset.uri)) return list;
	return [...list, asset];
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
