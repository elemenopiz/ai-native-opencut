"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { AiVideoIcon, VideoOffIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";

/**
 * Composer footer toggle, sibling to `EnhancePromptButton` — same size-6
 * button, size-3.5 icon, and idle/hover treatment, so the two read as one
 * button row rather than two designers' work. Where enhance-prompt is a
 * momentary action, this is a persistent on/off switch for the Director's
 * ONLY money-spending capability (generate/reroll/remix/compareTake — see
 * `GENERATION_VERB_NAMES` in `lib/director/agent.ts`): everything else the
 * Director does (trims, captions, effects, reads) stays free and unaffected
 * either way.
 *
 * The on/off affordance is the icon glyph itself (AiVideo vs. VideoOff), not
 * just a color/opacity shift — color alone is a weak signal next to a plain
 * enhance button that ALSO dims on disable, and a state this consequential
 * (it changes what the Director can and can't do) deserves an unambiguous
 * tell at a glance.
 */
export function GenerationToggleButton({ className }: { className?: string }) {
	const generationEnabled = useStudioSettingsStore((s) => s.generationEnabled);
	const setStudioSettings = useStudioSettingsStore((s) => s.set);

	const label = generationEnabled
		? "Generation is on — the Director can create new AI video and images. Click to turn off and edit only."
		: "Generation is off — the Director will only edit what's already in your project. Click to turn back on.";

	return (
		<button
			type="button"
			onClick={() =>
				setStudioSettings({ generationEnabled: !generationEnabled })
			}
			aria-pressed={generationEnabled}
			title={label}
			aria-label={label}
			className={cn(
				"inline-flex size-6 items-center justify-center rounded text-muted-foreground",
				"transition-colors hover:text-foreground hover:bg-accent",
				className,
			)}
		>
			<HugeiconsIcon
				icon={generationEnabled ? AiVideoIcon : VideoOffIcon}
				className="size-3.5"
			/>
		</button>
	);
}
