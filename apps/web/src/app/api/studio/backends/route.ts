import { NextResponse } from "next/server";
import {
	availableBackends,
	ensureBackendsRegistered,
	relativeCostTier,
	type BackendRequest,
	type GenerationModality,
} from "@/lib/studio/backends";
import type {
	VideoMode,
	VideoOrientation,
	VideoResolution,
} from "@/lib/studio/provider-adapter";

/**
 * Client-safe backend catalog. The registry + adapters are SERVER modules (they
 * read secret keys), so the browser can't introspect them directly. This route
 * exposes only availability + metadata — never keys — so the UI can offer N-way
 * "compare across models" and label the safety-tier filter. Only backends whose
 * provider keys are actually configured (`isAvailable()`) are returned.
 */

const MODALITIES: GenerationModality[] = ["video", "image"];

export interface BackendInfo {
	id: string;
	label: string;
	vendor: string;
	modality: GenerationModality;
	safetyTier: string;
	intents: string[];
	// Per-backend constraint surface — lets the UI offer only what THIS backend
	// supports (resolution/orientation/duration/mode) instead of a flat option
	// set. Optional because image backends carry sizes/qualities instead.
	resolutions?: VideoResolution[];
	orientations?: VideoOrientation[];
	durationRangeSec?: { min: number; max: number };
	modes?: VideoMode[];
	supportsSeedLock: boolean;
	supportsOmniReference: boolean;
	supportsLastFrame: boolean;
	supportsReferenceEdits: boolean;
	/** Normalized credits for a nominal generation — the honest, comparable
	 *  number the Director ranks on (Firefly refuses to publish this per model). */
	relativeCost: number;
	/** Relative cost bucket vs. the cheapest available backend of this modality —
	 *  the Director's draft/hero routing signal (cheap → draft, premium → hero). */
	costTier: "cheap" | "standard" | "premium";
}

/**
 * A nominal per-modality request used only to price backends against each other
 * for the RELATIVE cost tier. Not a real generation — just a fixed yardstick so
 * "cheap vs premium" compares like-for-like (a mid 720p/5s video, a default still).
 */
const NOMINAL_REQUEST: Record<GenerationModality, BackendRequest> = {
	video: {
		modality: "video",
		prompt: "",
		resolution: "720p",
		orientation: "landscape",
		duration: 5,
	},
	image: { modality: "image", prompt: "" },
};

export function GET(req: Request) {
	ensureBackendsRegistered();

	const url = new URL(req.url);
	const modalityParam = url.searchParams.get(
		"modality",
	) as GenerationModality | null;
	const modality =
		modalityParam && MODALITIES.includes(modalityParam)
			? modalityParam
			: undefined;

	// Price every available backend once against the nominal yardstick, then bucket
	// each into a cost tier relative to the cheapest of ITS modality (so a video and
	// an image model aren't tiered against each other).
	const priced = availableBackends(modality).map((b) => ({
		backend: b,
		credits: b.estimateCost(NOMINAL_REQUEST[b.modality]).credits,
	}));
	const minByModality = new Map<GenerationModality, number>();
	for (const { backend, credits } of priced) {
		const prev =
			minByModality.get(backend.modality) ?? Number.POSITIVE_INFINITY;
		if (credits < prev) minByModality.set(backend.modality, credits);
	}

	const backends: BackendInfo[] = priced.map(({ backend: b, credits }) => ({
		id: b.id,
		label: b.label,
		vendor: b.vendor,
		modality: b.modality,
		safetyTier: b.safetyTier,
		intents: b.capabilities.intents,
		resolutions: b.capabilities.resolutions,
		orientations: b.capabilities.orientations,
		durationRangeSec: b.capabilities.durationRangeSec,
		modes: b.capabilities.modes,
		supportsSeedLock: b.capabilities.supportsSeedLock,
		supportsOmniReference: b.capabilities.supportsOmniReference,
		supportsLastFrame: b.capabilities.supportsLastFrame,
		supportsReferenceEdits: b.capabilities.supportsReferenceEdits,
		relativeCost: credits,
		costTier: relativeCostTier(
			credits,
			minByModality.get(b.modality) ?? credits,
		),
	}));

	return NextResponse.json({ backends });
}
