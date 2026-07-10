import type { SoundEffect } from "@/types/sounds";

/**
 * ccMixter free-music source for the Songs tab.
 *
 * ccMixter's catalog is mixed-license (much of it Noncommercial / Sampling+), so
 * we keep ONLY tracks under commercially-usable licenses (CC-BY, CC-BY-SA, CC0,
 * public domain) — safe to use in an exported, potentially monetized video.
 * Attribution for BY/BY-SA is surfaced via the artist (`username`) + `license`
 * on each item. Files carry a direct `download_url` (no OAuth, unlike Freesound),
 * which we use for both preview playback and timeline import.
 */

// Keep ccMixter numeric upload ids from colliding with Freesound ids (which are
// far smaller) when both providers share the Songs feed.
const CCMIXTER_ID_OFFSET = 2_000_000_000;
const CCMIXTER_API = "https://ccmixter.org/api/query";

interface CcMixterFile {
	download_url?: string;
	file_nicname?: string;
	file_rawsize?: number;
	file_format_info?: {
		sr?: string; // sample rate, e.g. "44k"
		ch?: string; // "stereo" | "mono"
		ps?: string; // play time, e.g. "4:35"
		mime_type?: string;
	};
}

interface CcMixterUpload {
	upload_id?: number;
	upload_name?: string;
	user_name?: string;
	file_page_url?: string;
	license_name?: string;
	license_url?: string;
	files?: CcMixterFile[];
}

/** "4:35" / "1:02:03" → seconds. */
function parsePlaytimeToSeconds(ps?: string): number {
	if (!ps) return 0;
	const parts = ps.split(":").map((p) => Number.parseInt(p, 10));
	if (parts.some((n) => Number.isNaN(n))) return 0;
	return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** True only for licenses that permit commercial use (excludes NC / Sampling). */
function isCommerciallyUsable({
	license_url,
	license_name,
}: CcMixterUpload): boolean {
	const lic = `${license_url ?? ""} ${license_name ?? ""}`.toLowerCase();
	if (
		lic.includes("noncommercial") ||
		lic.includes("non-commercial") ||
		lic.includes("nc-") ||
		lic.includes("-nc") ||
		lic.includes("sampling")
	) {
		return false;
	}
	// Keep recognizable open licenses (CC-BY, CC-BY-SA, CC0, public domain).
	return (
		lic.includes("creativecommons.org") ||
		lic.includes("publicdomain") ||
		lic.includes("cc0") ||
		lic.includes("zero")
	);
}

function pickPlayableFile(files?: CcMixterFile[]): CcMixterFile | null {
	if (!files?.length) return null;
	const mp3 = files.find(
		(f) =>
			f.download_url &&
			(f.file_nicname === "mp3" ||
				f.file_format_info?.mime_type === "audio/mpeg"),
	);
	if (mp3) return mp3;
	return files.find((f) => f.download_url) ?? null;
}

function toSoundEffect(upload: CcMixterUpload): SoundEffect | null {
	if (!upload.upload_id || !isCommerciallyUsable(upload)) return null;
	const file = pickPlayableFile(upload.files);
	if (!file?.download_url) return null;

	const info = file.file_format_info ?? {};
	const channels = info.ch === "mono" ? 1 : 2;
	const samplerate = info.sr ? Number.parseInt(info.sr, 10) * 1000 || 0 : 0;

	return {
		id: CCMIXTER_ID_OFFSET + upload.upload_id,
		name: upload.upload_name || "Untitled",
		description: "",
		url: upload.file_page_url || "",
		previewUrl: file.download_url,
		downloadUrl: file.download_url,
		duration: parsePlaytimeToSeconds(info.ps),
		filesize: file.file_rawsize ?? 0,
		type: file.file_nicname || "mp3",
		channels,
		bitrate: 0,
		bitdepth: 0,
		samplerate,
		username: upload.user_name || "",
		tags: [],
		license: upload.license_name || "",
		created: "",
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	};
}

/**
 * Search ccMixter for commercially-usable music. Best-effort: any failure
 * resolves to an empty page rather than throwing, so it never breaks the
 * combined Songs feed.
 */
export async function searchCcMixter({
	query,
	page,
	pageSize,
}: {
	query?: string;
	page: number;
	pageSize: number;
}): Promise<{ results: SoundEffect[]; count: number; hasNext: boolean }> {
	try {
		const offset = (page - 1) * pageSize;
		const params = new URLSearchParams({
			f: "json",
			limit: String(pageSize),
			offset: String(offset),
		});
		if (query?.trim()) params.set("search", query.trim());
		else params.set("sort", "rank");

		const res = await fetch(`${CCMIXTER_API}?${params.toString()}`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return { results: [], count: 0, hasNext: false };

		const raw = (await res.json()) as unknown;
		const uploads = Array.isArray(raw) ? (raw as CcMixterUpload[]) : [];
		const results = uploads
			.map(toSoundEffect)
			.filter((s): s is SoundEffect => s !== null);

		// License filtering shrinks the usable count, so base "has more" on the
		// raw page length, not the filtered length.
		return {
			results,
			count: results.length,
			hasNext: uploads.length >= pageSize,
		};
	} catch {
		return { results: [], count: 0, hasNext: false };
	}
}
