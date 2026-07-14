"use client";

import { useEffect, useState } from "react";
import type { SafetyTier } from "@/types/timeline";
import type {
	VideoOrientation,
	VideoResolution,
} from "@/lib/studio/provider-adapter";
import type { ImageQuality, ImageSize } from "@/lib/studio/image-generator";

/**
 * Client-side view of an available generation backend, fetched from
 * `GET /api/studio/backends`. Defined locally (not imported from the route) so
 * no server module is pulled into the client bundle.
 */
export interface BackendInfo {
	id: string;
	label: string;
	vendor: string;
	modality: "video" | "image";
	safetyTier: SafetyTier;
	intents: string[];
	// Per-backend constraint surface (video backends). The generation form reads
	// these to offer only what the selected backend actually supports.
	resolutions?: VideoResolution[];
	orientations?: VideoOrientation[];
	durationRangeSec?: { min: number; max: number };
	// Per-backend constraint surface (image backends) — mirrors the video
	// fields above so the image panel can offer only real capabilities.
	sizes?: ImageSize[];
	qualities?: ImageQuality[];
	supportsSeedLock: boolean;
	supportsOmniReference: boolean;
	supportsLastFrame: boolean;
	supportsReferenceEdits: boolean;
	/** Accepts a silent-render request (e.g. Seedance). Omitted when the
	 *  backend's audio can't be toggled off (e.g. Veo's native audio). */
	supportsAudioToggle?: boolean;
	/** Normalized credits for a nominal generation (relative-cost ranking aid). */
	relativeCost: number;
	/** Cost bucket vs. the cheapest available backend of this modality. */
	costTier: "cheap" | "standard" | "premium";
}

/**
 * Fetch the backends whose provider keys are configured, for a modality. Powers
 * the N-way "compare across models" picker and the safety-tier filter labels.
 * Only returns backends the server reports as available, so unconfigured
 * providers never show up as options.
 */
export function useBackends(modality: "video" | "image" | null): {
	backends: BackendInfo[];
	loading: boolean;
	error: string | null;
} {
	const [backends, setBackends] = useState<BackendInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!modality) {
			setBackends([]);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		fetch(`/api/studio/backends?modality=${modality}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`Failed to load backends (${res.status})`);
				return res.json() as Promise<{ backends: BackendInfo[] }>;
			})
			.then((data) => {
				if (!cancelled) setBackends(data.backends ?? []);
			})
			.catch((err: unknown) => {
				if (!cancelled)
					setError(
						err instanceof Error ? err.message : "Failed to load backends",
					);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [modality]);

	return { backends, loading, error };
}
