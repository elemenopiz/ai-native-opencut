import { useCallback, useMemo, useSyncExternalStore } from "react";
import { EditorCore } from "@/core";

/**
 * Subscribe to the playhead time in isolation.
 *
 * Unlike useEditor(), this hook does NOT subscribe to the whole editor — only
 * to playback. It listens on both the discrete state channel (seeks, pause) and
 * the high-frequency time-tick channel (subscribeTime, fired every frame while
 * playing). Because only leaf components (a timecode readout) consume it, the
 * per-frame ticks re-render just those leaves instead of reconciling the entire
 * editor tree — which is what caused playback to drop frames and glitch audio.
 */
export function usePlaybackTime(): number {
	const editor = useMemo(() => EditorCore.getInstance(), []);

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			const unsubscribers = [
				editor.playback.subscribe(onStoreChange),
				editor.playback.subscribeTime(onStoreChange),
			];
			return () => {
				for (const unsubscribe of unsubscribers) {
					unsubscribe();
				}
			};
		},
		[editor],
	);

	return useSyncExternalStore(
		subscribe,
		() => editor.playback.getCurrentTime(),
		() => 0,
	);
}
