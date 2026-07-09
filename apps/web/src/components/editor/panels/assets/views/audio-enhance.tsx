"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { AutoDuckPanel } from "./auto-duck";
import { LoudnessPanel } from "./loudness-panel";

/**
 * Consolidates the audio-intelligence ops that already exist (auto-duck,
 * loudness normalization) but weren't reachable from any tab — see
 * capcut-poaches.md §6-A #11 / competitive-landscape-2026.md "half-orphaned"
 * audio compute finding.
 */
export function AudioEnhanceView() {
	return (
		<ScrollArea className="h-full">
			<AutoDuckPanel />
			<Separator />
			<LoudnessPanel />
		</ScrollArea>
	);
}
