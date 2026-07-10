import { NextResponse } from "next/server";
import {
	availableBackends,
	ensureBackendsRegistered,
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
}

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

	const backends: BackendInfo[] = availableBackends(modality).map((b) => ({
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
	}));

	return NextResponse.json({ backends });
}
