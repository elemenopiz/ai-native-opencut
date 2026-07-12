import type { MediaType } from "@/types/assets";
import type {
	TProject,
	TProjectMetadata,
	TTimelineViewState,
} from "@/types/project";
import type { TScene } from "@/types/timeline";

export interface StorageAdapter<T> {
	get(key: string): Promise<T | null>;
	set(key: string, value: T): Promise<void>;
	remove(key: string): Promise<void>;
	list(): Promise<string[]>;
	clear(): Promise<void>;
}

export type ProxyResolution = "480p" | "720p" | "1080p";

export interface ProxyInfo {
	resolution: ProxyResolution;
	width: number;
	height: number;
	generatedAt: number;
	fileSize: number;
}

export const PROXY_PRESETS: Record<
	ProxyResolution,
	{ maxWidth: number; maxHeight: number }
> = {
	"480p": { maxWidth: 854, maxHeight: 480 },
	"720p": { maxWidth: 1280, maxHeight: 720 },
	"1080p": { maxWidth: 1920, maxHeight: 1080 },
};

export const PROXY_THRESHOLD_WIDTH = 1920;
export const PROXY_THRESHOLD_HEIGHT = 1080;

/** Which visible frame of the source clip an extracted still came from. */
export type DerivedFrameLabel = "first frame" | "last frame" | "frame";

/**
 * Provenance for a still IMAGE asset extracted from a video clip. Ties the frame
 * back to its source video (by media-asset id) and records exactly which
 * SOURCE-media time was decoded, so the chain "last frame of clip N → first
 * frame of clip N+1" stays auditable. Additive/optional — pre-existing assets
 * (and any asset that wasn't extracted from a clip) simply lack it, so old
 * projects load unchanged.
 */
export interface DerivedFrom {
	/** `MediaAsset.id` of the source video this frame was decoded from. */
	assetId: string;
	/** SOURCE-media timestamp (seconds) that was decoded. */
	sourceTimeSec: number;
	/** Which visible frame this represents (drives the badge/name). */
	label: DerivedFrameLabel;
}

export interface MediaAssetData {
	id: string;
	name: string;
	type: MediaType;
	size: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	ephemeral?: boolean;
	thumbnailUrl?: string;
	/** User-defined label for organising assets (e.g. "Drone shot", "Person A cam") */
	label?: string;
	/** Where the asset came from. "ai" marks Studio-generated images/videos so
	 *  they can be filtered in the Assets panel. Undefined ⇒ uploaded/imported. */
	source?: "ai";
	/** Present ⇒ this asset is a still frame extracted from a source video clip. */
	derivedFrom?: DerivedFrom;
	proxy?: ProxyInfo;
	needsProxy?: boolean;
}

export type SerializedScene = Omit<TScene, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProjectMetadata = Omit<
	TProjectMetadata,
	"createdAt" | "updatedAt"
> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProject = Omit<TProject, "metadata" | "scenes"> & {
	metadata: SerializedProjectMetadata;
	scenes: SerializedScene[];
	timelineViewState?: TTimelineViewState;
};

export interface StorageConfig {
	projectsDb: string;
	mediaDb: string;
	savedSoundsDb: string;
	userLutsDb: string;
	version: number;
}

/**
 * A user-uploaded `.cube` LUT preset, persisted app-wide (not per-project,
 * mirroring saved sounds). The raw file text is stored and re-parsed into the
 * in-memory LUT registry on editor boot — see `lib/effects/lut-upload.ts`.
 */
export interface SavedLutData {
	id: string;
	label: string;
	/** Raw `.cube` file text. */
	cubeText: string;
	savedAt: string;
}

// TypeScript type augmentation to add async iterator methods to FileSystemDirectoryHandle
// These methods are part of the File System Access API spec but may not be in all type definitions
declare global {
	interface FileSystemDirectoryHandle {
		keys(): AsyncIterableIterator<string>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
	}
}
