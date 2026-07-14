import type { MediaAssetData, ProxyInfo } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified"> {
	file: File;
	url?: string;
	proxyFile?: File;
	proxyUrl?: string;
	/**
	 * Runtime-only (never persisted — deliberately absent from
	 * `MediaAssetData`): set by `MediaManager.loadProjectMedia`'s proactive
	 * re-probe when this asset carries a `passthrough` marker (see
	 * `PassthroughCodec`) and a cheap `VideoDecoder.isConfigSupported()`
	 * capability check says THIS browser can't decode its codec. Decodability
	 * is browser-specific and can change build to build, so it's re-derived
	 * fresh on every load rather than cached to storage. UI reads this to
	 * surface "can't play this footage here" messaging instead of hitting the
	 * silent VideoCache decode crash the HEVC cross-browser decode design doc
	 * describes.
	 */
	decodeUnsupported?: boolean;
}
