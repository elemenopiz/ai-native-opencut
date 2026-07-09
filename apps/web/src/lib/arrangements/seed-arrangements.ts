import type { Arrangement, ArrangementSlot } from "@/types/arrangement";
import { ARRANGEMENT_VERSION } from "@/types/arrangement";

/**
 * Seed arrangements — a handful of ready-made templates so a new user can go
 * from zero to a storyboarded timeline in one click (template-first onboarding).
 *
 * These are MEDIA-FREE by construction: each slot carries only a recipe stub
 * (prompt + look), so opening one drops empty generative slots the user then
 * resolves via upload or generation. Ids are stable strings so the gallery and
 * the /t/[id] share route can address them without a database round-trip.
 */

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

/** Build a linear run of same-lane slots back-to-back with a shared look. */
function linearSlots(
	specs: { prompt: string; duration: number }[],
	orientation: "portrait" | "landscape" | "square",
): ArrangementSlot[] {
	let cursor = 0;
	return specs.map((s, i) => {
		const slot: ArrangementSlot = {
			id: `slot-${i}`,
			kind: "video",
			lane: 0,
			startTime: cursor,
			duration: s.duration,
			label: s.prompt.slice(0, 40),
			recipe: {
				prompt: s.prompt,
				mode: "text-to-video",
				resolution: "720p",
				orientation,
				duration: s.duration,
			},
			transitionOut: i < specs.length - 1 ? { type: "fade", duration: 0.4 } : undefined,
		};
		cursor += s.duration;
		return slot;
	});
}

function total(slots: ArrangementSlot[]): number {
	return slots.reduce((max, s) => Math.max(max, s.startTime + s.duration), 0);
}

const productLaunchSlots = linearSlots(
	[
		{ prompt: "Sleek product reveal on a rotating pedestal, studio lighting", duration: 3 },
		{ prompt: "Close-up detail shot of the product's texture and finish", duration: 3 },
		{ prompt: "Product in use, bright lifestyle setting, happy customer", duration: 4 },
		{ prompt: "Bold logo sting on a clean gradient background", duration: 2 },
	],
	"portrait",
);

const travelVlogSlots = linearSlots(
	[
		{ prompt: "Sweeping aerial drone shot over a coastline at golden hour", duration: 4 },
		{ prompt: "POV walking through a bustling local market", duration: 4 },
		{ prompt: "Slow-motion of waves crashing on rocks, cinematic", duration: 3 },
		{ prompt: "Timelapse of a city skyline transitioning day to night", duration: 4 },
	],
	"landscape",
);

const talkingHeadSlots = linearSlots(
	[
		{ prompt: "Confident presenter speaking to camera, soft studio background", duration: 5 },
		{ prompt: "B-roll illustrating the main point, matching color grade", duration: 4 },
		{ prompt: "Presenter delivering the call to action, energetic", duration: 4 },
	],
	"portrait",
);

export const SEED_ARRANGEMENTS: Arrangement[] = [
	{
		version: ARRANGEMENT_VERSION,
		id: "seed-product-launch",
		name: "Product launch",
		description: "A punchy 4-shot product reveal for vertical feeds.",
		canvas: PORTRAIT,
		fps: 30,
		totalDuration: total(productLaunchSlots),
		slots: productLaunchSlots,
		overlays: [],
	},
	{
		version: ARRANGEMENT_VERSION,
		id: "seed-travel-vlog",
		name: "Travel montage",
		description: "Cinematic landscape montage with fade cuts.",
		canvas: LANDSCAPE,
		fps: 30,
		totalDuration: total(travelVlogSlots),
		slots: travelVlogSlots,
		overlays: [],
	},
	{
		version: ARRANGEMENT_VERSION,
		id: "seed-talking-head",
		name: "Talking head + B-roll",
		description: "Presenter-led explainer with a B-roll cutaway.",
		canvas: PORTRAIT,
		fps: 30,
		totalDuration: total(talkingHeadSlots),
		slots: talkingHeadSlots,
		overlays: [],
	},
];

export function getSeedArrangementById(id: string): Arrangement | undefined {
	return SEED_ARRANGEMENTS.find((a) => a.id === id);
}
