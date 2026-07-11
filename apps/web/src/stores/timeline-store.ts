/**
 * UI state for the timeline
 * For core logic, use EditorCore instead.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { KeyframeClipboardItem } from "@/types/animation";
import type { ClipboardItem } from "@/types/timeline";

interface TimelineStore {
	snappingEnabled: boolean;
	toggleSnapping: () => void;
	rippleEditingEnabled: boolean;
	toggleRippleEditing: () => void;
	clipboard: {
		items: ClipboardItem[];
	} | null;
	setClipboard: (
		clipboard: {
			items: ClipboardItem[];
		} | null,
	) => void;
	keyframeClipboard: {
		items: KeyframeClipboardItem[];
	} | null;
	setKeyframeClipboard: (
		clipboard: {
			items: KeyframeClipboardItem[];
		} | null,
	) => void;
}

export const useTimelineStore = create<TimelineStore>()(
	persist(
		(set) => ({
			snappingEnabled: true,

			toggleSnapping: () => {
				set((state) => ({ snappingEnabled: !state.snappingEnabled }));
			},

			rippleEditingEnabled: false,

			toggleRippleEditing: () => {
				set((state) => ({
					rippleEditingEnabled: !state.rippleEditingEnabled,
				}));
			},

			clipboard: null,

			setClipboard: (clipboard) => {
				set({ clipboard });
			},

			keyframeClipboard: null,

			setKeyframeClipboard: (keyframeClipboard) => {
				set({ keyframeClipboard });
			},
		}),
		{
			name: "timeline-store",
			partialize: (state) => ({
				snappingEnabled: state.snappingEnabled,
				rippleEditingEnabled: state.rippleEditingEnabled,
			}),
		},
	),
);
