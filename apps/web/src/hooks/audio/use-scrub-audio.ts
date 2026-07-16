"use client";

import { useCallback, useMemo, useRef } from "react";
import type { EditorCore } from "@/core";
import { useEditor } from "@/hooks/use-editor";
import { ScrubPlayer } from "@/lib/audio/scrub-player";
import {
	directionFromDelta,
	type ScrubDirection,
} from "@/lib/audio/scrub-grain-math";

/**
 * One ScrubPlayer per EditorCore instance, shared across every consumer of
 * this hook (the playhead-drag path and the arrow-key frame-step path both
 * want the same decoded window/session, not a fresh decode each). Matches
 * how AudioManager itself is scoped: constructed once, lives for the
 * editor's session — there is no per-component teardown here, the same way
 * `editor.audio` is never disposed mid-session (see core/index.ts).
 */
const playersByEditor = new WeakMap<EditorCore, ScrubPlayer>();

function getOrCreateScrubPlayer(editor: EditorCore): ScrubPlayer {
	const existing = playersByEditor.get(editor);
	if (existing) return existing;
	const player = new ScrubPlayer(editor);
	playersByEditor.set(editor, player);
	return player;
}

/**
 * Thin binding between the ScrubPlayer (pure runtime class, off the React
 * render path — see lib/audio/scrub-player.ts) and the timeline's
 * drag/arrow-key call sites. Nothing here calls setState or a store mutator
 * at tick rate; `onDragTick`/`onFrameStep` are meant to be invoked directly
 * from existing mouse-move/keydown handlers.
 */
export function useScrubAudio() {
	const editor = useEditor();
	const player = useMemo(() => getOrCreateScrubPlayer(editor), [editor]);
	const lastTimeRef = useRef<number | null>(null);

	const onDragStart = useCallback(
		(time: number): void => {
			lastTimeRef.current = time;
			void player.beginDrag(time);
		},
		[player],
	);

	const onDragTick = useCallback(
		(time: number): void => {
			const previous = lastTimeRef.current ?? time;
			const direction: ScrubDirection = directionFromDelta(time - previous);
			lastTimeRef.current = time;
			player.tick({ time, direction });
		},
		[player],
	);

	const onDragEnd = useCallback((): void => {
		lastTimeRef.current = null;
		player.endDrag();
	}, [player]);

	const onFrameStep = useCallback(
		(time: number, direction: ScrubDirection): void => {
			void player.stepFrame({ time, direction });
		},
		[player],
	);

	return useMemo(
		() => ({ player, onDragStart, onDragTick, onDragEnd, onFrameStep }),
		[player, onDragStart, onDragTick, onDragEnd, onFrameStep],
	);
}
