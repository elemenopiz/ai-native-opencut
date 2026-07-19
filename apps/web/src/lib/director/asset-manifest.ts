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
	"screen-rec",
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
 * MINIMAL LOCAL MIRROR of the sibling "Understanding Pass" agent's look probe
 * (`StyleProbe` in `@/lib/search/asset-understanding`) — same "own copy, not
 * import" discipline as {@link AssetUnderstanding} itself: only the subset of
 * fields the digest/heroes actually surface (palette / lens+mood / setting),
 * so this module keeps compiling independently of the sibling's real shape.
 */
export interface ManifestStyleProbe {
	/** Color grade / dominant palette. */
	palette?: string;
	/** Lens, depth of field, film stock, overall mood. */
	lensMood?: string;
	/** Environment, time of day, lighting, atmosphere. */
	setting?: string;
}

/**
 * Camera-motion energy class (mirrors `MotionClass` in
 * `@/lib/search/asset-understanding` — own-copy discipline, see
 * {@link AssetUnderstanding}).
 */
export type ManifestMotionClass = "static" | "pan" | "handheld" | "fast-cut";

/** Framing distance (mirrors `ShotType`). */
export type ManifestShotType =
	| "wide"
	| "medium"
	| "close-up"
	| "extreme-close-up"
	| "insert";

/** Compact per-shot-type label for the digest's bracket annotation (a few chars each). */
const SHOT_TYPE_LABEL: Record<ManifestShotType, string> = {
	wide: "wide",
	medium: "med",
	"close-up": "CU",
	"extreme-close-up": "ECU",
	insert: "insert",
};

/** MINIMAL LOCAL MIRROR of `CompositionNote`. */
export interface ManifestComposition {
	subjectPosition?: string;
	headroom?: string;
	ruleOfThirds?: boolean;
}

/** MINIMAL LOCAL MIRROR of `AudioProbe`. */
export interface ManifestAudioProbe {
	hasSpeech?: boolean;
	energy?: "low" | "medium" | "high";
}

/** MINIMAL LOCAL MIRROR of `ContinuityFingerprint`. */
export interface ManifestContinuityFingerprint {
	lighting?: string;
	whiteBalance?: string;
	wardrobe?: string;
	colorSignature?: string;
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
	/**
	 * Look probe (palette / lens+mood / setting), when the Understanding Pass
	 * produced one. Restored here (see {@link adaptUnderstandingForManifest} in
	 * `understanding-lookup.ts`) so the Director's grounding carries the same
	 * look facet the human-facing Insights panel already shows — it used to be
	 * stripped at the manifest boundary.
	 */
	styleProbe?: ManifestStyleProbe;
	/**
	 * DEEPENED perception facets (Bet 1 — director-intelligence architecture),
	 * mirroring `AssetUnderstanding`'s optional widening in
	 * `@/lib/search/asset-understanding`. A SHALLOW understanding row (predates
	 * the widening, or degraded) simply omits all of these — every consumer
	 * below degrades silently, same contract as `styleProbe`.
	 */
	motion?: ManifestMotionClass;
	shotType?: ManifestShotType;
	composition?: ManifestComposition;
	emotion?: string;
	audio?: ManifestAudioProbe;
	continuityFingerprint?: ManifestContinuityFingerprint;
}

/**
 * Injected read-through to per-asset understanding. Returns the row for a media
 * id, or `undefined` when the asset has none. ABSENT (the whole lookup) ⇒ the
 * manifest falls back to media-type counts + recent names.
 */
export type AssetUnderstandingLookup = (
	mediaId: string,
) => AssetUnderstanding | undefined;

/**
 * Injected read-through to the per-asset TRANSCRIPT pass (a sibling ingest
 * layer to understanding): `true` ⇒ transcribed with real speech, `false` ⇒
 * transcribed and silent, `undefined` ⇒ not transcribed (yet). ABSENT (the
 * whole lookup) ⇒ the digest simply omits its speech facet. Deliberately a
 * boolean facet, not the transcript itself — the digest names THAT footage has
 * speech; the `getTranscript` verb carries the actual segments.
 */
export type AssetSpeechLookup = (mediaId: string) => boolean | undefined;

/**
 * MINIMAL LOCAL MIRROR of `stores/beat-grid-store.ts`'s `BeatGrid` — same "own
 * copy, not import" discipline as {@link AssetUnderstanding}: only the facts
 * that ground a pacing decision (tempo, beat/downbeat density, energy), never
 * the full per-beat-timestamp array the UI's snap grid needs. That grid is
 * analyzed ON-DEMAND in the UI (not at ingest), so most projects/assets have
 * none — this facet is deliberately sparse.
 */
export interface AssetBeatGrid {
	/** Detected tempo in BPM, when the analyzer resolved one. */
	bpm?: number;
	/** Total analyzed beat count. */
	beatCount: number;
	/** Subset of beats flagged as downbeats. */
	downbeatCount: number;
	/** Coarse energy classification (e.g. "energetic", "calm"), when resolved. */
	energyClass?: string;
}

/**
 * Injected read-through to the (at most one, today) analyzed BEAT GRID: returns
 * the grid's facts for a media id, or `undefined` when that asset has no
 * analyzed grid. ABSENT (the whole lookup) ⇒ the digest simply omits the
 * beat-grid facet — same degrade-to-nothing contract as {@link AssetSpeechLookup}.
 */
export type AssetBeatGridLookup = (
	mediaId: string,
) => AssetBeatGrid | undefined;

/**
 * A library asset as the manifest sees it. `id`/`name`/`type` are always
 * present; the rest MIRROR fields that already exist on the real editor asset
 * (`MediaAssetData` in `@/services/storage/types`) but never used to reach the
 * Director — width/height/duration/fps come from that asset's probed
 * metadata, and `source` mirrors its `source` field ("ai" ⇒ Studio-generated;
 * absent/anything else ⇒ user-uploaded/imported, per that field's own
 * contract). All optional and additive: a caller that only has id/name/type
 * (tests, or an asset whose metadata hasn't been probed yet) still parses, and
 * every consumer of these fields must degrade gracefully when absent.
 */
export interface ManifestAsset {
	id: string;
	name: string;
	type: MediaType;
	/** Pixel width, when the asset's metadata has been probed. */
	width?: number;
	/** Pixel height, when the asset's metadata has been probed. */
	height?: number;
	/**
	 * Duration in SECONDS, when known. Named `durationSec` (not `duration`,
	 * `MediaAssetData`'s field name) to keep the unit unambiguous at every call
	 * site that reads a `ManifestAsset`.
	 */
	durationSec?: number;
	/** Frames per second, when known (video assets only). */
	fps?: number;
	/**
	 * Provenance: `"ai"` ⇒ Studio-generated (mirrors `MediaAssetData.source ===
	 * "ai"`); `"upload"` ⇒ user-uploaded/imported (mirrors `MediaAssetData.source`
	 * being absent — that field has no third state). Absent here only when the
	 * caller didn't resolve a real asset at all (e.g. a hand-built test fixture).
	 */
	source?: "upload" | "ai";
}

/**
 * Coarse orientation bucket derived from pixel dimensions — the vocabulary
 * {@link ProjectInfo}'s `orientation` field already uses for the canvas, reused
 * here so a library asset and the canvas can be compared directly (see the
 * ORIENTATION-MISMATCH facet on {@link buildLibraryManifest}).
 */
export type AssetOrientation = "portrait" | "landscape" | "square";

/**
 * Classify `width`×`height` into a coarse {@link AssetOrientation}. Returns
 * `undefined` when either dimension is missing or non-positive (unprobed
 * metadata) — callers must treat that as "unknown", never guess a bucket.
 */
export function orientationOf(
	width?: number,
	height?: number,
): AssetOrientation | undefined {
	if (!width || !height || width <= 0 || height <= 0) return undefined;
	if (width === height) return "square";
	return width > height ? "landscape" : "portrait";
}

/** Greatest common divisor (Euclidean), used to reduce a pixel ratio to its simplest form. */
function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y) {
		[x, y] = [y, x % y];
	}
	return x;
}

/**
 * Compact aspect-ratio label from pixel dimensions, e.g. `"16:9"`, `"9:16"`,
 * `"1:1"`, `"4:5"` — a GCD-reduced `width:height` fraction, which lands on
 * exactly these familiar labels for standard camera/export resolutions
 * (1920×1080, 1080×1920, 1080×1080, 1080×1350, …). Returns `undefined` when
 * either dimension is missing or non-positive.
 */
export function aspectRatioTag(
	width?: number,
	height?: number,
): string | undefined {
	if (!width || !height || width <= 0 || height <= 0) return undefined;
	const w = Math.round(width);
	const h = Math.round(height);
	const divisor = gcd(w, h) || 1;
	return `${w / divisor}:${h / divisor}`;
}

/** A persona (id + name) so a face's `personaMatch` id resolves to a name. */
export interface ManifestPersona {
	id: string;
	name: string;
}

/**
 * One named hero surfaced in the digest. Heroes are capped at
 * {@link HERO_NAME_CAP} (cheap regardless of library size), so unlike the
 * always-on `digest` string, it's cheap to carry each hero's dimensions,
 * duration, and provenance here — the fields that let a consumer catch an
 * orientation or duration mismatch BEFORE placing the clip, instead of
 * discovering it reactively deep inside `addClip`.
 */
export interface ManifestHero {
	/** Compact `#N` position label (1-based library index) for the digest string. */
	ref: string;
	/** FULL media id, so a consumer can act on the hero (e.g. addClip). */
	mediaId: string;
	/** The understanding caption shown next to the ref. */
	caption: string;
	/** Pixel width, when the source asset's metadata was probed. */
	width?: number;
	/** Pixel height, when the source asset's metadata was probed. */
	height?: number;
	/** Duration in seconds, when known. */
	durationSec?: number;
	/** Provenance ("ai" ⇒ Studio-generated; "upload" ⇒ user-uploaded/imported), when known. */
	source?: "upload" | "ai";
	/** Compact aspect-ratio label (see {@link aspectRatioTag}), when width/height are both known. */
	orientation?: string;
	/** Look probe (palette / lens+mood / setting), when the Understanding Pass produced one. */
	styleProbe?: ManifestStyleProbe;
	/**
	 * DEEPENED perception facets, when the Understanding Pass produced them
	 * (see {@link AssetUnderstanding}). `motion`/`shotType`/`emotion` additionally
	 * ride a compact bracket in the digest STRING itself (see
	 * {@link formatHeroFacets}) — a few tokens per hero; `composition`/`audio`/
	 * `continuityFingerprint` are carried here structurally only (same
	 * "structural, not in the flowing text" precedent as `styleProbe`), reachable
	 * via a deeper re-query without bloating the always-injected line.
	 */
	motion?: ManifestMotionClass;
	shotType?: ManifestShotType;
	composition?: ManifestComposition;
	emotion?: string;
	audio?: ManifestAudioProbe;
	continuityFingerprint?: ManifestContinuityFingerprint;
}

/** A named face-anchor (a persona) and how many assets matched it. */
export interface ManifestFaceAnchor {
	name: string;
	count: number;
}

/**
 * How many library assets conflict with the canvas's orientation — the
 * structured backing for the digest's ORIENTATION-MISMATCH warning clause
 * (see {@link buildLibraryManifest}'s `canvasOrientation` param). Only present
 * on the manifest when `canvasOrientation` was supplied AND at least one
 * dimensioned asset actually conflicts with it.
 */
export interface OrientationMismatch {
	/** The canvas orientation assets were compared against. */
	canvasOrientation: AssetOrientation;
	/** Conflicting-asset counts by their OWN orientation (never includes `canvasOrientation` itself). */
	counts: Partial<Record<AssetOrientation, number>>;
	/** Total conflicting assets across all categories. */
	total: number;
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
	/** Assets transcribed with real speech (0 when nothing is transcribed). */
	speechCount: number;
	/**
	 * Set ⇒ `canvasOrientation` was supplied AND at least one library asset
	 * conflicts with it (a landscape asset against a portrait canvas, etc.).
	 * Absent when no `canvasOrientation` was given, or nothing conflicts.
	 */
	orientationMismatch?: OrientationMismatch;
	/**
	 * Set ⇒ a `beatGrid` lookup was supplied AND it resolved facts for one
	 * library asset (today's store holds at most one analyzed grid). Names the
	 * matched asset (`mediaId`/`assetName`) alongside its {@link AssetBeatGrid}
	 * facts so a consumer can act on it without a re-query. Absent when no
	 * lookup was given, or nothing matched.
	 */
	beatGrid?: AssetBeatGrid & { mediaId: string; assetName: string };
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
 * heroes with captions (plus each hero's dims/duration/provenance/style probe,
 * when present — heroes are capped, so this is cheap), tallies face-anchor
 * persona matches, and points the tail at the b-roll residual.
 *
 * FALLBACK path (no lookup, or a lookup that yields nothing useful): counts by
 * media type and lists the most-recent asset names — never worse than the prior
 * "recent 5" grounding.
 *
 * ORIENTATION-MISMATCH facet (independent of grounded/fallback, like the speech
 * facet): when `canvasOrientation` is supplied, every asset with known
 * width/height is compared against it. A conflict adds a short `⚠ ...` clause
 * to `digest` (see {@link withOrientationFacet}); no conflict (or no
 * `canvasOrientation`) adds ZERO bytes — this module stays ~40 tokens for the
 * always-injected line, per the caps below.
 *
 * BEAT-GRID facet (independent of grounded/fallback, like speech/orientation):
 * when `beatGrid` is supplied and resolves facts for a library asset, a short
 * `♫ ...` clause naming that asset's tempo/beat density/energy is appended to
 * `digest` (see {@link withBeatGridFacet}) so pacing decisions (cut-on-beat,
 * matching shot length to bar length) are grounded on REAL analyzed data
 * instead of the brain guessing a tempo. No lookup (or no match) adds ZERO
 * bytes and NEVER triggers analysis itself — purely a read of whatever the UI
 * already analyzed.
 */
export function buildLibraryManifest(input: {
	assets: ManifestAsset[];
	understanding?: AssetUnderstandingLookup;
	personas?: ManifestPersona[];
	/** Optional speech facet from the transcript pass (see {@link AssetSpeechLookup}). */
	speech?: AssetSpeechLookup;
	/**
	 * Optional canvas orientation to check the library against (mirrors
	 * `ProjectInfo.orientation` in `types.ts`). A plain string, not an editor
	 * import — this module stays PURE LOGIC (no React, no editor, no network);
	 * `director-api.ts` resolves the real canvas size and passes the bucket in.
	 */
	canvasOrientation?: AssetOrientation;
	/**
	 * Optional beat-grid facet from the analyzed beat-snap grid (see
	 * {@link AssetBeatGridLookup}). A per-mediaId read-through, not an
	 * `useBeatGridStore` import — this module stays PURE LOGIC; the caller
	 * resolves the store and passes a lookup in, same pattern as `understanding`/
	 * `speech`.
	 */
	beatGrid?: AssetBeatGridLookup;
}): LibraryManifest {
	const {
		assets,
		understanding,
		personas,
		speech,
		canvasOrientation,
		beatGrid,
	} = input;
	const total = assets.length;

	// Media-type counts: always cheap, and the fallback digest's basis.
	const typeCounts: Partial<Record<MediaType, number>> = {};
	for (const a of assets) typeCounts[a.type] = (typeCounts[a.type] ?? 0) + 1;

	// Speech facet: independent of the (visual) understanding pass, so it rides
	// BOTH the grounded and the fallback digest.
	let speechCount = 0;
	if (speech) {
		for (const a of assets) if (speech(a.id) === true) speechCount += 1;
	}

	// Orientation-mismatch facet: same independence as speech — it only needs
	// each asset's own width/height, not the (visual) understanding pass.
	const orientationMismatch = computeOrientationMismatch(
		assets,
		canvasOrientation,
	);

	// Beat-grid facet: same independence as speech/orientation — a pure
	// per-mediaId read, no understanding pass required.
	const beatGridMatch = computeBeatGridMatch(assets, beatGrid);

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
			speechCount,
			orientationMismatch,
			beatGrid: beatGridMatch,
			digest: withBeatGridFacet(
				withOrientationFacet(
					withSpeechFacet(
						formatFallbackDigest(assets, total, typeCounts),
						speechCount,
					),
					orientationMismatch,
				),
				beatGridMatch,
			),
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
			const orientation = aspectRatioTag(asset.width, asset.height);
			heroes.push({
				ref: `#${index + 1}`,
				mediaId: asset.id,
				caption: u.caption,
				...(asset.width != null ? { width: asset.width } : {}),
				...(asset.height != null ? { height: asset.height } : {}),
				...(asset.durationSec != null
					? { durationSec: asset.durationSec }
					: {}),
				...(asset.source != null ? { source: asset.source } : {}),
				...(orientation != null ? { orientation } : {}),
				...(u.styleProbe != null ? { styleProbe: u.styleProbe } : {}),
				...(u.motion != null ? { motion: u.motion } : {}),
				...(u.shotType != null ? { shotType: u.shotType } : {}),
				...(u.composition != null ? { composition: u.composition } : {}),
				...(u.emotion != null ? { emotion: u.emotion } : {}),
				...(u.audio != null ? { audio: u.audio } : {}),
				...(u.continuityFingerprint != null
					? { continuityFingerprint: u.continuityFingerprint }
					: {}),
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
		speechCount,
		orientationMismatch,
		beatGrid: beatGridMatch,
		digest: withBeatGridFacet(
			withOrientationFacet(
				withSpeechFacet(
					formatGroundedDigest({
						total,
						roleCounts,
						heroes,
						faceAnchors,
						tail,
					}),
					speechCount,
				),
				orientationMismatch,
			),
			beatGridMatch,
		),
	};
}

// ── orientation-mismatch facet ──────────────────────────────────────────────

/** Stable digest ordering for the mismatch clause's per-orientation segments. */
const ORIENTATION_ORDER: readonly AssetOrientation[] = [
	"landscape",
	"portrait",
	"square",
];

/**
 * Tally every DIMENSIONED asset whose own {@link orientationOf} differs from
 * `canvasOrientation`. Assets with unknown width/height are silently skipped
 * (unknown, not a conflict). Returns `undefined` when no `canvasOrientation`
 * was given, or nothing conflicts — the caller treats that as "add zero bytes".
 */
function computeOrientationMismatch(
	assets: ManifestAsset[],
	canvasOrientation?: AssetOrientation,
): OrientationMismatch | undefined {
	if (!canvasOrientation) return undefined;

	const counts: Partial<Record<AssetOrientation, number>> = {};
	let total = 0;
	for (const a of assets) {
		const o = orientationOf(a.width, a.height);
		if (!o || o === canvasOrientation) continue;
		counts[o] = (counts[o] ?? 0) + 1;
		total += 1;
	}
	return total > 0 ? { canvasOrientation, counts, total } : undefined;
}

/**
 * Render the mismatch clause, e.g. `"⚠ 3 landscape assets, canvas is
 * portrait."` — or `"⚠ 2 landscape, 1 square assets, canvas is portrait."`
 * when more than one conflicting orientation is present.
 */
function formatOrientationWarning(mismatch: OrientationMismatch): string {
	const segments = ORIENTATION_ORDER.filter((o) => mismatch.counts[o]).map(
		(o) => `${mismatch.counts[o]} ${o}`,
	);
	return `⚠ ${segments.join(", ")} asset${mismatch.total === 1 ? "" : "s"}, canvas is ${mismatch.canvasOrientation}.`;
}

// ── beat-grid facet ──────────────────────────────────────────────────────────

/**
 * Resolve the (at most one, today) library asset with an analyzed beat grid,
 * via the injected `beatGrid` lookup. Checks every asset (cheap — same O(assets)
 * loop as the speech facet) so a future multi-grid store still finds its match
 * by mediaId without this module changing. Returns `undefined` when no lookup
 * was given, or nothing matched — the caller treats that as "add zero bytes".
 */
function computeBeatGridMatch(
	assets: ManifestAsset[],
	lookup?: AssetBeatGridLookup,
): (AssetBeatGrid & { mediaId: string; assetName: string }) | undefined {
	if (!lookup) return undefined;
	for (const a of assets) {
		const grid = lookup(a.id);
		if (grid) return { mediaId: a.id, assetName: a.name, ...grid };
	}
	return undefined;
}

/**
 * Render the beat-grid clause, e.g. `♫ "song.mp3" 128bpm, 64 beats/16
 * downbeats, energetic.` — bpm/energyClass are individually optional (the
 * analyzer may not resolve either), so each is only included when present.
 */
function formatBeatGridClause(
	grid: AssetBeatGrid & { mediaId: string; assetName: string },
): string {
	const bpmPart = grid.bpm != null ? `${grid.bpm}bpm, ` : "";
	const energyPart = grid.energyClass ? `, ${grid.energyClass}` : "";
	return `♫ ${JSON.stringify(grid.assetName)} ${bpmPart}${grid.beatCount} beats/${grid.downbeatCount} downbeats${energyPart}.`;
}

// ── formatting ────────────────────────────────────────────────────────────────

/**
 * Append the speech facet to a digest (grounded OR fallback): tells the brain
 * some footage has a transcript and names the verb that reads it. Zero
 * transcribed-with-speech assets ⇒ digest unchanged, zero bytes added.
 */
function withSpeechFacet(digest: string, speechCount: number): string {
	if (speechCount === 0) return digest;
	return `${digest} ${speechCount} with speech — getTranscript(mediaId) for sentence-aligned cut points.`;
}

/**
 * Append the BEAT-GRID facet to a digest (grounded OR fallback): a short
 * `♫ ...` clause naming the one library asset with an analyzed beat grid and
 * its tempo/beat-density/energy — grounds cut-on-beat pacing decisions on real
 * analyzed data. No `match` (no lookup was supplied, or nothing matched) ⇒
 * digest unchanged, zero bytes added.
 */
function withBeatGridFacet(
	digest: string,
	match: (AssetBeatGrid & { mediaId: string; assetName: string }) | undefined,
): string {
	if (!match) return digest;
	return `${digest} ${formatBeatGridClause(match)}`;
}

/**
 * Append the ORIENTATION-MISMATCH facet to a digest (grounded OR fallback): a
 * short `⚠ ...` warning naming which/how-many library assets conflict with
 * the canvas orientation. No `mismatch` (no `canvasOrientation` was supplied,
 * or nothing conflicts) ⇒ digest unchanged, zero bytes added — the caps
 * comment block's ~40-token target holds regardless of library size.
 */
function withOrientationFacet(
	digest: string,
	mismatch: OrientationMismatch | undefined,
): string {
	if (!mismatch) return digest;
	return `${digest} ${formatOrientationWarning(mismatch)}`;
}

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
 * Compact `[...]` bracket for a hero's DEEPENED perception facets — a few
 * tokens, appended straight after the caption in the digest STRING (unlike
 * `styleProbe`/`composition`/`audio`/`continuityFingerprint`, which ride the
 * structured {@link ManifestHero} only). Only `shotType`/`motion`/`emotion`
 * are cheap+legible enough for the always-injected prompt line; e.g.
 * `[CU·handheld·tense]`. Returns `""` (zero bytes) when the hero has none —
 * the silent-degrade contract every other facet in this module follows.
 */
function formatHeroFacets(h: ManifestHero): string {
	const bits: string[] = [];
	if (h.shotType) bits.push(SHOT_TYPE_LABEL[h.shotType]);
	if (h.motion) bits.push(h.motion);
	if (h.emotion) bits.push(h.emotion);
	return bits.length ? ` [${bits.join("·")}]` : "";
}

/**
 * The grounded digest, e.g.:
 * `LIBRARY (31 assets): 4 hero · 1 logo · 3 face-anchor (Mara ×2) · 23 b-roll.
 *  Heroes: #4 "product on marble, backlit" [CU·handheld·tense], #7 "founder
 *  to-camera". 23 more b-roll — searchable via searchMedia.`
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
			.map((h) => `${h.ref} ${JSON.stringify(h.caption)}${formatHeroFacets(h)}`)
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
