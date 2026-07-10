/**
 * The ASSET MANIFEST — a faceted, role-aware digest of the media library that
 * rides in the Director's once-per-turn system prompt as TIER-0 grounding.
 *
 * WHY: the Director used to be grounded on only the LAST FEW assets by recency
 * (`getProjectInfo`'s `recentAssets`). With a large library most assets were
 * invisible to the brain unless it happened to call `searchMedia`. This module
 * gives the brain STANDING AWARENESS of the whole library — counts by role, a
 * few named heroes with captions, named face-anchors (personas), and a tail
 * pointer to the searchable residual — in ~40 tokens, cheap to rebuild each turn.
 *
 * DEPENDENCY + GRACEFUL DEGRADATION:
 * Role/caption/face data comes from a sibling "Understanding Pass" agent, read
 * here through an INJECTED per-asset lookup ({@link AssetUnderstandingLookup}).
 * This module defines its OWN minimal mirror of that agent's export
 * ({@link AssetUnderstanding}) so it ships and is testable independently. When
 * no understanding data is available the digest DEGRADES to counts-by-media-type
 * plus the most-recent asset names — never worse than the prior grounding.
 *
 * PURE LOGIC: no React, no editor, no network. Callers pass in plain
 * {@link ManifestAsset}s + personas; `director-api.ts` adapts editor state.
 */

import type { MediaType } from "@/types/assets";

/**
 * The roles the Understanding Pass may assign an asset. Also the DISPLAY ORDER
 * of the digest's role-count line (hero → product → logo → face-anchor → b-roll).
 */
export const ASSET_ROLES = [
	"hero",
	"product",
	"logo",
	"face-anchor",
	"b-roll",
] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

/**
 * A face the Understanding Pass detected inside an asset. `personaMatch` is the
 * id (or name) of an existing persona this face resembles; `isNew` flags a face
 * with no persona match (a candidate for a new persona). All fields optional so
 * a partial understanding row still parses.
 */
export interface UnderstoodFace {
	/** Persona id or name this face matched, if any. */
	personaMatch?: string;
	/** Match confidence in [0, 1]. */
	score?: number;
	/** True ⇒ a detected face with no existing persona match. */
	isNew?: boolean;
}

/**
 * MINIMAL LOCAL MIRROR of the sibling "Understanding Pass" agent's per-asset
 * export. We consume ONLY these fields; the real interface is being built in
 * parallel and may carry more. Keeping our own copy (rather than importing) is
 * deliberate: this feature must compile, ship, and be tested with or without the
 * Understanding Pass wired. When the sibling lands, reconcile the two shapes.
 */
export interface AssetUnderstanding {
	mediaId: string;
	caption?: string;
	role?: AssetRole;
	/** Model confidence in the assigned role, [0, 1]. */
	roleConfidence?: number;
	/** True ⇒ a human confirmed the role (reserved for future weighting). */
	roleConfirmed?: boolean;
	tags?: string[];
	faces?: UnderstoodFace[];
}

/**
 * Injected read-through to per-asset understanding. Returns the row for a media
 * id, or `undefined` when the asset has none. ABSENT (the whole lookup) ⇒ the
 * manifest falls back to media-type counts + recent names.
 */
export type AssetUnderstandingLookup = (
	mediaId: string,
) => AssetUnderstanding | undefined;

/** A library asset as the manifest sees it — id/name/type only. */
export interface ManifestAsset {
	id: string;
	name: string;
	type: MediaType;
}

/** A persona (id + name) so a face's `personaMatch` id resolves to a name. */
export interface ManifestPersona {
	id: string;
	name: string;
}

/** One named hero surfaced in the digest. */
export interface ManifestHero {
	/** Compact `#N` position label (1-based library index) for the digest string. */
	ref: string;
	/** FULL media id, so a consumer can act on the hero (e.g. addClip). */
	mediaId: string;
	/** The understanding caption shown next to the ref. */
	caption: string;
}

/** A named face-anchor (a persona) and how many assets matched it. */
export interface ManifestFaceAnchor {
	name: string;
	count: number;
}

/**
 * The faceted library digest. `digest` is the ~40-token one-line string injected
 * into the prompt; the structured fields back a re-queryable `getLibraryManifest`
 * verb (so an agent can read exact ids/captions on demand).
 */
export interface LibraryManifest {
	/** Total assets in the library. */
	total: number;
	/** True ⇒ built from understanding data; false ⇒ media-type fallback. */
	grounded: boolean;
	/** Per-role counts (grounded only; roles with 0 are omitted). */
	roleCounts: Partial<Record<AssetRole, number>>;
	/** Per-media-type counts (always computed; the fallback digest's basis). */
	typeCounts: Partial<Record<MediaType, number>>;
	/** A few named heroes with captions (capped for prompt size). */
	heroes: ManifestHero[];
	/** Named face-anchors (persona matches), most-frequent first (capped). */
	faceAnchors: ManifestFaceAnchor[];
	/** The searchable residual pointer — the b-roll bucket — if any. */
	tail?: { count: number; role?: AssetRole };
	/** The compact one-line digest string for the system prompt. */
	digest: string;
}

// ── caps (keep the digest byte-small and byte-stable regardless of library size) ──

/** Max named heroes surfaced in the digest. */
const HERO_NAME_CAP = 3;
/** Max named face-anchor personas surfaced in the role line. */
const FACE_ANCHOR_CAP = 2;
/** Max recent asset names in the fallback digest. */
const RECENT_FALLBACK_CAP = 3;

/** Digest role-line order; `ASSET_ROLES` is authored in this exact order. */
const DISPLAY_ORDER: readonly AssetRole[] = ASSET_ROLES;
/** Media-type order for the fallback digest. */
const TYPE_ORDER: readonly MediaType[] = ["video", "image", "audio"];

/**
 * Build the faceted library manifest from library assets + an optional
 * understanding lookup + the persona roster (for face-anchor names).
 *
 * GROUNDED path (understanding data present): counts assets by role (an
 * understood-but-unroled asset, or one with no understanding row, defaults to
 * `b-roll` so role counts always sum to `total`), names up to {@link HERO_NAME_CAP}
 * heroes with captions, tallies face-anchor persona matches, and points the tail
 * at the b-roll residual.
 *
 * FALLBACK path (no lookup, or a lookup that yields nothing useful): counts by
 * media type and lists the most-recent asset names — never worse than the prior
 * "recent 5" grounding.
 */
export function buildLibraryManifest(input: {
	assets: ManifestAsset[];
	understanding?: AssetUnderstandingLookup;
	personas?: ManifestPersona[];
}): LibraryManifest {
	const { assets, understanding, personas } = input;
	const total = assets.length;

	// Media-type counts: always cheap, and the fallback digest's basis.
	const typeCounts: Partial<Record<MediaType, number>> = {};
	for (const a of assets) typeCounts[a.type] = (typeCounts[a.type] ?? 0) + 1;

	// Resolve understanding rows in library order (index → `#N` ref).
	const rows = understanding
		? assets.map((asset, index) => ({
				asset,
				index,
				u: understanding(asset.id),
			}))
		: [];
	// "Grounded" iff at least one asset carries a real signal — otherwise a
	// wired-but-empty Understanding Pass would produce an all-b-roll digest worse
	// than the recency fallback.
	const grounded = rows.some(
		(r) =>
			r.u != null &&
			(r.u.role != null ||
				(r.u.caption != null && r.u.caption !== "") ||
				(r.u.faces?.length ?? 0) > 0),
	);

	if (!grounded) {
		return {
			total,
			grounded: false,
			roleCounts: {},
			typeCounts,
			heroes: [],
			faceAnchors: [],
			digest: formatFallbackDigest(assets, total, typeCounts),
		};
	}

	const personaNameById = new Map(
		(personas ?? []).map((p) => [p.id, p.name] as const),
	);
	const roleCounts: Partial<Record<AssetRole, number>> = {};
	const heroes: ManifestHero[] = [];
	const faceCounts = new Map<string, number>();

	for (const { asset, index, u } of rows) {
		// Unclassified assets fall into the generic b-roll bucket so counts sum to
		// total and the searchable tail is meaningful.
		const role: AssetRole = u?.role ?? "b-roll";
		roleCounts[role] = (roleCounts[role] ?? 0) + 1;

		if (role === "hero" && u?.caption && heroes.length < HERO_NAME_CAP) {
			heroes.push({
				ref: `#${index + 1}`,
				mediaId: asset.id,
				caption: u.caption,
			});
		}

		if (role === "face-anchor" && u?.faces?.length) {
			// One asset counts once per DISTINCT persona it shows (a photo with two
			// shots of the same persona shouldn't inflate that persona's tally).
			const names = new Set<string>();
			for (const face of u.faces) {
				if (!face.personaMatch) continue;
				names.add(personaNameById.get(face.personaMatch) ?? face.personaMatch);
			}
			for (const name of names)
				faceCounts.set(name, (faceCounts.get(name) ?? 0) + 1);
		}
	}

	const faceAnchors: ManifestFaceAnchor[] = [...faceCounts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		.slice(0, FACE_ANCHOR_CAP);

	const brollCount = roleCounts["b-roll"] ?? 0;
	const tail =
		brollCount > 0
			? { count: brollCount, role: "b-roll" as AssetRole }
			: undefined;

	return {
		total,
		grounded: true,
		roleCounts,
		typeCounts,
		heroes,
		faceAnchors,
		tail,
		digest: formatGroundedDigest({
			total,
			roleCounts,
			heroes,
			faceAnchors,
			tail,
		}),
	};
}

// ── formatting ────────────────────────────────────────────────────────────────

/** "1 asset" / "N assets". */
function pluralAssets(n: number): string {
	return `${n} asset${n === 1 ? "" : "s"}`;
}

/** Render the role-count line, annotating face-anchor with its top personas. */
function formatRoleSegments(
	roleCounts: Partial<Record<AssetRole, number>>,
	faceAnchors: ManifestFaceAnchor[],
): string {
	const segments: string[] = [];
	for (const role of DISPLAY_ORDER) {
		const count = roleCounts[role];
		if (!count) continue;
		let segment = `${count} ${role}`;
		if (role === "face-anchor" && faceAnchors.length) {
			const annotation = faceAnchors
				.map((f) => `${f.name} ×${f.count}`)
				.join(", ");
			segment += ` (${annotation})`;
		}
		segments.push(segment);
	}
	return segments.join(" · ");
}

/**
 * The grounded digest, e.g.:
 * `LIBRARY (31 assets): 4 hero · 1 logo · 3 face-anchor (Mara ×2) · 23 b-roll.
 *  Heroes: #4 "product on marble, backlit", #7 "founder to-camera". 23 more
 *  b-roll — searchable via searchMedia.`
 */
function formatGroundedDigest(m: {
	total: number;
	roleCounts: Partial<Record<AssetRole, number>>;
	heroes: ManifestHero[];
	faceAnchors: ManifestFaceAnchor[];
	tail?: { count: number; role?: AssetRole };
}): string {
	const roleLine = formatRoleSegments(m.roleCounts, m.faceAnchors);
	const parts: string[] = [`LIBRARY (${pluralAssets(m.total)}): ${roleLine}.`];

	if (m.heroes.length) {
		const named = m.heroes
			.map((h) => `${h.ref} ${JSON.stringify(h.caption)}`)
			.join(", ");
		parts.push(`Heroes: ${named}.`);
	}

	if (m.tail && m.tail.count > 0) {
		const label = m.tail.role ? ` ${m.tail.role}` : "";
		parts.push(`${m.tail.count} more${label} — searchable via searchMedia.`);
	} else {
		parts.push("searchMedia finds any shot semantically.");
	}

	return parts.join(" ");
}

/**
 * The fallback digest (no understanding data): counts by media type + the
 * most-recent asset names. Preserves the language of the prior grounding so the
 * degraded mode is never worse than what shipped before.
 */
function formatFallbackDigest(
	assets: ManifestAsset[],
	total: number,
	typeCounts: Partial<Record<MediaType, number>>,
): string {
	if (total === 0) return "LIBRARY: empty (no assets yet).";

	const typeLine = TYPE_ORDER.filter((t) => typeCounts[t])
		.map((t) => `${typeCounts[t]} ${t}`)
		.join(" · ");
	// Assets are stored in insertion order, so the tail is the most recent.
	const recentNames = assets
		.slice(-RECENT_FALLBACK_CAP)
		.map((a) => a.name)
		.join(", ");
	const recentPart = recentNames ? ` Recent: ${recentNames}.` : "";

	return `LIBRARY (${pluralAssets(total)}): ${typeLine}. searchMedia finds footage semantically; addClip places a hit.${recentPart}`;
}
