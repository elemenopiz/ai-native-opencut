import type { MediaAsset } from "@/types/assets";

/**
 * Export-time cross-browser decode fallback (HEVC/VP9/AV1 "passthrough"
 * assets — see `PassthroughCodec` in `services/storage/types.ts`).
 *
 * `decideNormalization()` (`lib/media/normalize-media.ts`) lets the INGESTING
 * browser skip transcoding a non-H.264 upload whenever that browser can
 * decode it. That decision is baked into the stored asset forever — a later
 * export on a DIFFERENT browser (no hardware HEVC decode, say) can't decode
 * the original at all. Part 1 of this fix (`fix/hevc-fallback-p1-always-proxy`)
 * guarantees every passthrough asset always gets a portable H.264 proxy at
 * ingest. This module is the export-time consumer: it re-checks decodability
 * independently, via the persisted codec string, with zero dependency on any
 * load-time probe/cache (that's Part 2's concern, in media-manager.ts /
 * video-cache/service.ts — deliberately not touched here).
 */

export interface ExportDecodabilityCheck {
	/**
	 * Ids of media assets whose original this browser can't decode but that
	 * have a portable H.264 proxy ready — `scene-builder.ts` should substitute
	 * the proxy for these during export.
	 */
	fallbackAssetIds: Set<string>;
	/**
	 * Assets whose original this browser can't decode AND that have no proxy
	 * yet (still generating, or generation failed) — export cannot proceed for
	 * these; the caller should fail the export with a clear message instead of
	 * silently producing a broken file.
	 */
	blockingAssets: MediaAsset[];
	/**
	 * One human-readable warning per asset in `fallbackAssetIds`, naming the
	 * clip — ready to surface as a single non-blocking `toast.warning` on
	 * export completion (see `export-button.tsx`).
	 */
	warnings: string[];
}

function emptyCheck(): ExportDecodabilityCheck {
	return {
		fallbackAssetIds: new Set(),
		blockingAssets: [],
		warnings: [],
	};
}

/**
 * Re-checks decodability of every passthrough video asset in `mediaAssets`
 * against the CURRENT browser, independent of whatever the ingesting browser
 * decided. Never throws — a codec string `VideoDecoder.isConfigSupported`
 * can't parse is treated the same as an explicit "unsupported" result, since
 * we can't safely assume the original will play.
 *
 * Guard: when `VideoDecoder` isn't available at all (extremely old/unusual
 * environment), decodability is unknown — treat as decodable and do nothing,
 * matching the pre-existing behavior (always resolve the original for
 * export) rather than guessing.
 */
export async function resolveExportProxyFallback({
	mediaAssets,
}: {
	mediaAssets: MediaAsset[];
}): Promise<ExportDecodabilityCheck> {
	if (typeof VideoDecoder === "undefined") {
		return emptyCheck();
	}

	const fallbackAssetIds = new Set<string>();
	const blockingAssets: MediaAsset[] = [];
	const warnings: string[] = [];

	for (const asset of mediaAssets) {
		if (asset.type !== "video" || !asset.passthrough) continue;

		let supported: boolean;
		try {
			const result = await VideoDecoder.isConfigSupported({
				codec: asset.passthrough.codec,
			});
			supported = !!result.supported;
		} catch {
			supported = false;
		}

		if (supported) continue;

		if (asset.proxyFile && asset.proxyUrl) {
			fallbackAssetIds.add(asset.id);
			warnings.push(
				`"${asset.name}" was exported from a lower-quality proxy because your browser can't decode its original video codec.`,
			);
		} else {
			blockingAssets.push(asset);
		}
	}

	return { fallbackAssetIds, blockingAssets, warnings };
}
