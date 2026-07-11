import { storageService } from "@/services/storage/service";
import { apiFetch } from "@/lib/auth/unauthorized";
import type { MediaAsset, MediaType } from "@/types/assets";

/**
 * Media sync for shared projects. History syncs through the commit/branch
 * sync endpoint, but snapshots only reference media by id — the blobs live in
 * each user's browser. These helpers move them through the content-addressable
 * cloud store (R2) so a teammate's clone actually has the footage:
 *
 *   push: upload each local asset blob (server dedups by hash), then register
 *         commit↔media refs so the repo knows which mediaId maps to which hash.
 *   pull: read the repo's media manifest and download any asset the local
 *         project doesn't have yet.
 */

const API_BASE = "/api/version-control";

export interface MediaPushResult {
	uploaded: number;
	skipped: number;
	failed: number;
}

export interface MediaPullResult {
	downloaded: number;
	skipped: number;
	failed: number;
}

interface RepoMediaEntry {
	mediaId: string;
	name: string | null;
	hash: string;
	size: number;
	mimeType: string;
	width: number | null;
	height: number | null;
	duration: number | null;
}

function mediaTypeFromMime(mimeType: string): MediaType {
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	return "image";
}

/**
 * Upload every non-ephemeral media asset of a project and register the refs
 * against `commitId` (normally the branch head being pushed). Uploads are
 * sequential and best-effort: a failure (e.g. rate limit) counts and moves on —
 * the server dedups by content hash, so the next sync retries cheaply.
 */
export async function pushProjectMedia({
	projectId,
	repoId,
	commitId,
}: {
	projectId: string;
	repoId: string;
	commitId: string;
}): Promise<MediaPushResult> {
	const assets = await storageService.loadAllMediaAssets({ projectId });
	const result: MediaPushResult = { uploaded: 0, skipped: 0, failed: 0 };
	const refs: Array<{ mediaId: string; mediaHash: string; name: string }> = [];

	for (const asset of assets) {
		if (asset.ephemeral) {
			result.skipped++;
			continue;
		}
		try {
			const formData = new FormData();
			formData.append("file", asset.file);
			const response = await apiFetch(`${API_BASE}/media`, {
				method: "POST",
				body: formData,
			});
			if (!response.ok) {
				result.failed++;
				continue;
			}
			const { hash, deduplicated } = (await response.json()) as {
				hash: string;
				deduplicated: boolean;
			};
			refs.push({ mediaId: asset.id, mediaHash: hash, name: asset.name });
			if (deduplicated) result.skipped++;
			else result.uploaded++;
		} catch {
			result.failed++;
		}
	}

	if (refs.length > 0) {
		try {
			await apiFetch(`${API_BASE}/repos/${repoId}/media`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ commitId, refs }),
			});
		} catch {
			// Refs failed to register — uploads are still deduped server-side, so
			// the next sync re-registers them.
			result.failed += refs.length;
		}
	}

	return result;
}

/**
 * Download every asset in the repo's media manifest that the local project
 * doesn't already have, saving each into the project's media storage.
 */
export async function pullProjectMedia({
	projectId,
	repoId,
}: {
	projectId: string;
	repoId: string;
}): Promise<MediaPullResult> {
	const result: MediaPullResult = { downloaded: 0, skipped: 0, failed: 0 };

	const manifestResponse = await apiFetch(`${API_BASE}/repos/${repoId}/media`);
	if (!manifestResponse.ok) {
		throw new Error("Failed to load the project's media manifest");
	}
	const { media } = (await manifestResponse.json()) as {
		media: RepoMediaEntry[];
	};

	const existing = await storageService.loadAllMediaAssets({ projectId });
	const existingIds = new Set(existing.map((a) => a.id));

	for (const entry of media) {
		if (existingIds.has(entry.mediaId)) {
			result.skipped++;
			continue;
		}
		try {
			// The API 302-redirects to the R2 object; fetch follows it.
			const blobResponse = await apiFetch(`${API_BASE}/media/${entry.hash}`);
			if (!blobResponse.ok) {
				result.failed++;
				continue;
			}
			const blob = await blobResponse.blob();
			const file = new File([blob], entry.name ?? entry.mediaId, {
				type: entry.mimeType || blob.type,
			});

			const asset: MediaAsset = {
				id: entry.mediaId,
				name: entry.name ?? entry.mediaId,
				type: mediaTypeFromMime(entry.mimeType),
				file,
				width: entry.width ?? undefined,
				height: entry.height ?? undefined,
				duration: entry.duration ?? undefined,
			};
			await storageService.saveMediaAsset({ projectId, mediaAsset: asset });
			result.downloaded++;
		} catch {
			result.failed++;
		}
	}

	return result;
}
