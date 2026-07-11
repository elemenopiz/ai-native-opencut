"use client";

// Adapted from OpenCut-app/OpenCut's `timeline/components/graph-editor/custom-presets-store.ts`
// (pre-rewrite tag, MIT). See THIRD_PARTY_NOTICES.md. Same `useSyncExternalStore` +
// localStorage shape, renamed to match our `CubicBezierControlPoints` type and
// avoid colliding with the pre-rewrite storage key.

import { useSyncExternalStore } from "react";
import { generateUUID } from "@/utils/id";
import type { CubicBezierControlPoints } from "@/types/animation";

const STORAGE_KEY = "byorn-easing-graph-presets";

export interface EasingCustomPreset {
	id: string;
	label: string;
	value: CubicBezierControlPoints;
}

let cachedPresets: EasingCustomPreset[] | null = null;
const listeners = new Set<() => void>();

function isValidPresetArray(value: unknown): value is EasingCustomPreset[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as EasingCustomPreset).id === "string" &&
				typeof (item as EasingCustomPreset).label === "string" &&
				Array.isArray((item as EasingCustomPreset).value) &&
				(item as EasingCustomPreset).value.length === 4 &&
				(item as EasingCustomPreset).value.every(
					(component: unknown) => typeof component === "number",
				),
		)
	);
}

function readFromStorage(): EasingCustomPreset[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return isValidPresetArray(parsed) ? parsed : [];
	} catch {
		// Silently recover — corrupted localStorage shouldn't crash the editor.
		return [];
	}
}

function writeToStorage({ presets }: { presets: EasingCustomPreset[] }): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
	} catch {
		// Storage may be unavailable (private mode, quota) — degrade silently.
	}
}

function getSnapshot(): EasingCustomPreset[] {
	cachedPresets ??= readFromStorage();
	return cachedPresets;
}

function getServerSnapshot(): EasingCustomPreset[] {
	return [];
}

function notify(): void {
	cachedPresets = null;
	for (const listener of listeners) {
		listener();
	}
}

function onStorageChange(event: StorageEvent): void {
	if (event.key === STORAGE_KEY) notify();
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0 && typeof window !== "undefined") {
		window.addEventListener("storage", onStorageChange);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && typeof window !== "undefined") {
			window.removeEventListener("storage", onStorageChange);
		}
	};
}

export function useCustomEasingPresets(): EasingCustomPreset[] {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function saveEasingPreset({
	value,
}: {
	value: CubicBezierControlPoints;
}): void {
	const current = getSnapshot();
	writeToStorage({
		presets: [
			...current,
			{
				id: generateUUID(),
				label: `Custom ${current.length + 1}`,
				value,
			},
		],
	});
	notify();
}

export function removeEasingPreset({ id }: { id: string }): void {
	writeToStorage({
		presets: getSnapshot().filter((preset) => preset.id !== id),
	});
	notify();
}
