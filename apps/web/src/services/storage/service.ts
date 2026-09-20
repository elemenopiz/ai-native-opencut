import type { TProject, TProjectMetadata } from "@/types/project";
import { getProjectDurationFromScenes } from "@/lib/scenes";
import type { MediaAsset } from "@/types/assets";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import type {
	MediaAssetData,
	SavedLutData,
	StorageConfig,
	SerializedProject,
	SerializedScene,
} from "./types";
import type { SavedSoundsData, SavedSound, SoundEffect } from "@/types/sounds";
import {
	migrations,
	runStorageMigrations,
} from "@/services/storage/migrations";
import type {
	Bookmark,
	TimelineElement,
	TimelineTrack,
	TrackType,
	TScene,
} from "@/types/timeline";
import {
	ensureVisualElementDefaults,
	isPlausibleTimelineElement,
	requiresMediaIdButMissing,
} from "@/lib/timeline/element-normalize";

const MIME_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".avi": "video/x-msvideo",
	".mkv": "video/x-matroska",
	".flv": "video/x-flv",
	".wmv": "video/x-ms-wmv",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".m4a": "audio/mp4",
	".wma": "audio/x-ms-wma",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
};

function getMimeType(filename: string): string {
	const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
	return MIME_TYPES[ext] ?? "";
}

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") return { time: item };
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: obj.time,
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && { duration: obj.duration }),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

const KNOWN_TRACK_TYPES: ReadonlySet<TrackType> = new Set([
	"video",
	"text",
	"audio",
	"sticker",
	"shape",
	"effect",
]);

/**
 * Structural gate for a persisted track. BUG129 — sibling corruption class to
 * the transform-brick heal: a `null`/non-object track, or one missing a
 * string `id` or a recognized `type`, reaches `.type`/`.elements` reads in
 * `deserializeProject` and throws, bricking the *whole scene's* load (every
 * other track in the scene goes down with it). Dropped by the caller rather
 * than healed — there's no default id/type safe to fabricate for a track.
 */
function isPlausibleTrack(track: unknown): track is TimelineTrack {
	if (track === null || typeof track !== "object") return false;
	const candidate = track as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.type === "string" &&
		KNOWN_TRACK_TYPES.has(candidate.type as TrackType)
	);
}

/**
 * Heal one track's persisted `elements` array (BUG129, extending the
 * transform-brick heal to sibling corruption classes):
 *  - drop shapes that can't be trusted as elements at all (null, non-object,
 *    missing `id`, non-string/unrecognized `type` — see
 *    `isPlausibleTimelineElement`);
 *  - drop duplicate `id`s, keeping the first — the timeline store and
 *    command layer address elements by `id` alone, so a dup silently steals
 *    selection/edits from the first element sharing it. `seenElementIds` is
 *    threaded across every track in the scene (not reset per-track) because
 *    ids are meant to be unique scene-wide, not just within one track;
 *  - drop video/image/upload-audio elements with a missing `mediaId` — they
 *    can never resolve a source, so they'd render as permanently-invisible,
 *    still-selectable timeline debris (see `requiresMediaIdButMissing`);
 *  - then run the existing `ensureVisualElementDefaults` transform/opacity/
 *    blendMode heal on whatever survives.
 */
function healTrackElements({
	rawElements,
	seenElementIds,
}: {
	rawElements: unknown[];
	seenElementIds: Set<string>;
}): TimelineElement[] {
	const healed: TimelineElement[] = [];
	for (const raw of rawElements) {
		if (!isPlausibleTimelineElement(raw)) continue;
		if (seenElementIds.has(raw.id)) continue;
		if (requiresMediaIdButMissing(raw)) continue;
		seenElementIds.add(raw.id);
		healed.push(ensureVisualElementDefaults({ element: raw }));
	}
	return healed;
}

/** Drop the decoded audio `buffer` from audio elements — re-derived on load, not persisted. */
function stripAudioBuffers({
	tracks,
}: {
	tracks: TimelineTrack[];
}): TimelineTrack[] {
	return tracks.map((track) => {
		if (track.type !== "audio") return track;
		return {
			...track,
			elements: track.elements.map((element) => {
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}),
		};
	});
}

/**
 * Pure `TProject` → `SerializedProject` mapping (the durable on-disk shape):
 * Dates → ISO strings, audio buffers stripped. The persistent `directorBrief`
 * rides through here alongside `settings` — a plain, already-serializable object
 * needing no transform (mirrors `timelineViewState`). Extracted from
 * `saveProject` so the round-trip is unit-testable without a browser IndexedDB.
 */
export function serializeProject({
	project,
}: {
	project: TProject;
}): SerializedProject {
	const duration =
		project.metadata.duration ??
		getProjectDurationFromScenes({ scenes: project.scenes });
	const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks: stripAudioBuffers({ tracks: scene.tracks }),
		bookmarks: scene.bookmarks,
		markers: scene.markers,
		createdAt: scene.createdAt.toISOString(),
		updatedAt: scene.updatedAt.toISOString(),
	}));

	return {
		metadata: {
			id: project.metadata.id,
			name: project.metadata.name,
			thumbnail: project.metadata.thumbnail,
			duration,
			createdAt: project.metadata.createdAt.toISOString(),
			updatedAt: project.metadata.updatedAt.toISOString(),
		},
		scenes: serializedScenes,
		currentSceneId: project.currentSceneId,
		settings: project.settings,
		version: project.version,
		timelineViewState: project.timelineViewState,
		directorBrief: project.directorBrief,
		// Rides through alongside `directorBrief` — a plain, already-serializable
		// object (the Director's durable, versioned Project Bible).
		projectBible: project.projectBible,
		// Assets-panel folder list (campaign C33) — same "plain object, no
		// transform needed" idiom as `directorBrief`/`projectBible`.
		mediaFolders: project.mediaFolders,
	};
}

/**
 * Pure `SerializedProject` → `TProject` mapping: ISO strings → Dates, and the
 * persistent `directorBrief` restored (absent on projects saved before the
 * field existed ⇒ left `undefined`, so old projects load unchanged). Extracted
 * from `loadProject`; the async orchestration (migrations, media, fonts) that
 * wraps it stays in the method.
 */
export function deserializeProject({
	serializedProject,
}: {
	serializedProject: SerializedProject;
}): TProject {
	const scenes =
		serializedProject.scenes?.map((scene) => {
			// Scene-wide (not per-track) — element ids are addressed by id alone
			// downstream, so dedup must span every track in the scene. See
			// `healTrackElements`.
			const seenElementIds = new Set<string>();
			// `scene.tracks` is typed as an array, but this is untyped persisted
			// data cast to that type — guard against it being corrupted into
			// something non-array (would otherwise throw on `.filter`/`.map`
			// below and brick the whole project's load).
			const rawTracks = Array.isArray(scene.tracks) ? scene.tracks : [];

			return {
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				// Heal persisted tracks/elements (BUG129): drop track/element shapes
				// that can't be trusted (null, non-object, missing id/type — see
				// `isPlausibleTrack`/`isPlausibleTimelineElement`), drop duplicate
				// element ids and media elements with no resolvable `mediaId`, then
				// apply the existing transform/opacity/blendMode heal
				// (`ensureVisualElementDefaults`) to what survives. A malformed
				// track or element used to crash the project on every load,
				// permanently bricking it — healing here makes existing broken
				// projects loadable again instead of silently producing invisible
				// garbage.
				tracks: rawTracks.filter(isPlausibleTrack).map((track) => {
					const normalizedTrack =
						track.type === "video"
							? { ...track, isMain: track.isMain ?? false }
							: track;
					const rawElements = Array.isArray(normalizedTrack.elements)
						? normalizedTrack.elements
						: [];
					return {
						...normalizedTrack,
						elements: healTrackElements({ rawElements, seenElementIds }),
					} as TimelineTrack;
				}),
				bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
				markers: scene.markers ?? [],
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			};
		}) ?? [];

	return {
		metadata: {
			id: serializedProject.metadata.id,
			name: serializedProject.metadata.name,
			thumbnail: serializedProject.metadata.thumbnail,
			duration:
				serializedProject.metadata.duration ??
				getProjectDurationFromScenes({ scenes }),
			createdAt: new Date(serializedProject.metadata.createdAt),
			updatedAt: new Date(serializedProject.metadata.updatedAt),
		},
		scenes,
		currentSceneId: serializedProject.currentSceneId || "",
		settings: serializedProject.settings,
		version: serializedProject.version,
		timelineViewState: serializedProject.timelineViewState,
		directorBrief: serializedProject.directorBrief,
		// Restored verbatim (absent on projects saved before it existed ⇒ left
		// `undefined`, so old projects load unchanged).
		projectBible: serializedProject.projectBible,
		// Same "restored verbatim, absent ⇒ undefined" idiom.
		mediaFolders: serializedProject.mediaFolders,
	};
}

class StorageService {
	private projectsAdapter: IndexedDBAdapter<SerializedProject>;
	private savedSoundsAdapter: IndexedDBAdapter<SavedSoundsData>;
	private userLutsAdapter: IndexedDBAdapter<SavedLutData>;
	private config: StorageConfig;
	private migrationsPromise: Promise<void> | null = null;

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			savedSoundsDb: "video-editor-saved-sounds",
			userLutsDb: "video-editor-user-luts",
			version: 1,
		};

		this.projectsAdapter = new IndexedDBAdapter<SerializedProject>(
			this.config.projectsDb,
			"projects",
			this.config.version,
		);

		this.savedSoundsAdapter = new IndexedDBAdapter<SavedSoundsData>(
			this.config.savedSoundsDb,
			"saved-sounds",
			this.config.version,
		);

		this.userLutsAdapter = new IndexedDBAdapter<SavedLutData>(
			this.config.userLutsDb,
			"user-luts",
			this.config.version,
		);
	}

	private async ensureMigrations(): Promise<void> {
		if (this.migrationsPromise) {
			await this.migrationsPromise;
			return;
		}

		this.migrationsPromise = runStorageMigrations({ migrations }).then(
			() => undefined,
		);
		await this.migrationsPromise;
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>(
			`${this.config.mediaDb}-${projectId}`,
			"media-metadata",
			this.config.version,
		);

		const mediaAssetsAdapter = new OPFSAdapter(`media-files-${projectId}`);

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const serializedProject = serializeProject({ project });
		await this.projectsAdapter.set(project.metadata.id, serializedProject);
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureMigrations();
		const serializedProject = await this.projectsAdapter.get(id);

		if (!serializedProject) return null;

		return { project: deserializeProject({ serializedProject }) };
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureMigrations();
		const serializedProjects = await this.projectsAdapter.getAll();

		const metadata = serializedProjects.map((serializedProject) => ({
			id: serializedProject.metadata.id,
			name: serializedProject.metadata.name,
			thumbnail: serializedProject.metadata.thumbnail,
			duration:
				serializedProject.metadata.duration ??
				getProjectDurationFromScenes({
					scenes: (serializedProject.scenes ?? []) as unknown as TScene[],
				}),
			createdAt: new Date(serializedProject.metadata.createdAt),
			updatedAt: new Date(serializedProject.metadata.updatedAt),
		}));

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await mediaAssetsAdapter.set(mediaAsset.id, mediaAsset.file);

		const metadata: MediaAssetData = {
			id: mediaAsset.id,
			name: mediaAsset.name,
			type: mediaAsset.type,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
			width: mediaAsset.width,
			height: mediaAsset.height,
			duration: mediaAsset.duration,
			thumbnailUrl: mediaAsset.thumbnailUrl,
			ephemeral: mediaAsset.ephemeral,
			label: mediaAsset.label,
			source: mediaAsset.source,
			derivedFrom: mediaAsset.derivedFrom,
			normalized: mediaAsset.normalized,
			passthrough: mediaAsset.passthrough,
			proxy: mediaAsset.proxy,
			needsProxy: mediaAsset.needsProxy,
			folderId: mediaAsset.folderId,
		};

		await mediaMetadataAdapter.set(mediaAsset.id, metadata);
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const [file, metadata] = await Promise.all([
			mediaAssetsAdapter.get(id),
			mediaMetadataAdapter.get(id),
		]);

		if (!file || !metadata) return null;

		// OPFS loses the original filename and MIME type — reconstruct from metadata
		const restoredFile =
			file.name === metadata.name && file.type
				? file
				: new File([file], metadata.name, {
						type: file.type || getMimeType(metadata.name),
						lastModified: file.lastModified,
					});

		let url: string;
		if (
			metadata.type === "image" &&
			(!restoredFile.type || restoredFile.type === "")
		) {
			try {
				const text = await restoredFile.text();
				if (text.trim().startsWith("<svg")) {
					const svgBlob = new Blob([text], { type: "image/svg+xml" });
					url = URL.createObjectURL(svgBlob);
				} else {
					url = URL.createObjectURL(restoredFile);
				}
			} catch {
				url = URL.createObjectURL(restoredFile);
			}
		} else {
			url = URL.createObjectURL(restoredFile);
		}

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			file: restoredFile,
			url,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			label: metadata.label,
			source: metadata.source,
			derivedFrom: metadata.derivedFrom,
			normalized: metadata.normalized,
			passthrough: metadata.passthrough,
			proxy: metadata.proxy,
			needsProxy: metadata.needsProxy,
			folderId: metadata.folderId,
		};
	}

	async saveProxyFile({
		projectId,
		assetId,
		proxyFile,
	}: {
		projectId: string;
		assetId: string;
		proxyFile: File;
	}): Promise<void> {
		const { mediaAssetsAdapter } = this.getProjectMediaAdapters({ projectId });
		await mediaAssetsAdapter.set(`${assetId}-proxy`, proxyFile);
	}

	async loadProxyFile({
		projectId,
		assetId,
	}: {
		projectId: string;
		assetId: string;
	}): Promise<File | null> {
		const { mediaAssetsAdapter } = this.getProjectMediaAdapters({ projectId });
		return mediaAssetsAdapter.get(`${assetId}-proxy`);
	}

	async deleteProxyFile({
		projectId,
		assetId,
	}: {
		projectId: string;
		assetId: string;
	}): Promise<void> {
		const { mediaAssetsAdapter } = this.getProjectMediaAdapters({ projectId });
		await mediaAssetsAdapter.remove(`${assetId}-proxy`);
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const mediaItems: MediaAsset[] = [];

		for (const id of mediaIds) {
			const item = await this.loadMediaAsset({ projectId, id });
			if (item) {
				mediaItems.push(item);
			}
		}

		return mediaItems;
	}

	/**
	 * Metadata only — skips the mediaAssetsAdapter blob reads that
	 * loadAllMediaAssets does, so it's cheap to call for projects that aren't
	 * the active editor project (e.g. the projects list falling back to an
	 * asset thumbnail when metadata.thumbnail is missing/broken).
	 */
	async loadMediaAssetsMetadata({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAssetData[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const items = await Promise.all(
			mediaIds.map((id) => mediaMetadataAdapter.get(id)),
		);

		return items.filter((item): item is MediaAssetData => item !== null);
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaAssetsAdapter.remove(id),
			mediaMetadataAdapter.remove(id),
		]);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaMetadataAdapter.clear(),
			mediaAssetsAdapter.clear(),
		]);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();

		return {
			mediaItems: mediaIds.length,
		};
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		try {
			const savedSoundsData = await this.savedSoundsAdapter.get("user-sounds");
			return (
				savedSoundsData || {
					sounds: [],
					lastModified: new Date().toISOString(),
				}
			);
		} catch (error) {
			console.error("Failed to load saved sounds:", error);
			return { sounds: [], lastModified: new Date().toISOString() };
		}
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) {
				return; // Already saved
			}

			const savedSound: SavedSound = {
				id: soundEffect.id,
				name: soundEffect.name,
				username: soundEffect.username,
				previewUrl: soundEffect.previewUrl,
				downloadUrl: soundEffect.downloadUrl,
				duration: soundEffect.duration,
				tags: soundEffect.tags,
				license: soundEffect.license,
				savedAt: new Date().toISOString(),
			};

			const updatedData: SavedSoundsData = {
				sounds: [...currentData.sounds, savedSound],
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set("user-sounds", updatedData);
		} catch (error) {
			console.error("Failed to save sound effect:", error);
			throw error;
		}
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			const updatedData: SavedSoundsData = {
				sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set("user-sounds", updatedData);
		} catch (error) {
			console.error("Failed to remove saved sound:", error);
			throw error;
		}
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		try {
			const currentData = await this.loadSavedSounds();
			return currentData.sounds.some((sound) => sound.id === soundId);
		} catch (error) {
			console.error("Failed to check if sound is saved:", error);
			return false;
		}
	}

	async clearSavedSounds(): Promise<void> {
		try {
			await this.savedSoundsAdapter.remove("user-sounds");
		} catch (error) {
			console.error("Failed to clear saved sounds:", error);
			throw error;
		}
	}

	async saveUserLut({ lut }: { lut: SavedLutData }): Promise<void> {
		await this.userLutsAdapter.set(lut.id, lut);
	}

	async loadUserLuts(): Promise<SavedLutData[]> {
		try {
			return await this.userLutsAdapter.getAll();
		} catch (error) {
			console.error("Failed to load saved LUTs:", error);
			return [];
		}
	}

	async removeUserLut({ id }: { id: string }): Promise<void> {
		await this.userLutsAdapter.remove(id);
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.isIndexedDBSupported() && this.isOPFSSupported();
	}
}

export const storageService = new StorageService();
export { StorageService };
