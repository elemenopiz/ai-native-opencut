/**
 * Asset Understanding — the ingest-time "what IS this asset?" pass.
 *
 * THE GAP THIS CLOSES: today an imported clip gets on-device CLIP vectors plus a
 * weak tag set — a fixed 20-label vocabulary scored against ONLY the first
 * sampled frame (`embedding-service.ts`). The index knows how an asset LOOKS in
 * vector space, but has no notion of what it IS (its ROLE in a reel) or WHO is in
 * it (faces reconciled against the persona roster). This module supplies the pure
 * pieces of a richer, structured understanding record:
 *
 *  - a {@link AssetUnderstanding} — the stable contract sibling systems (the
 *    "Asset Manifest" and "Project Bible") code against: a one-line caption, a
 *    ROLE belief + confidence, open-vocab tags observed across MULTIPLE frames,
 *    faces reconciled to personas, and an optional style probe. It also carries
 *    an optional DEEPENED continuity-aware fingerprint — shot type, composition,
 *    emotion/tone, and a {@link ContinuityFingerprint} (lighting/white-balance/
 *    wardrobe/color) for match-cutting and identity. All additive/optional — see
 *    {@link isDeepUnderstanding} for detecting a record that predates this.
 *  - two MEASURED facets that are deliberately NOT part of the model call, because
 *    the call has no evidence for them: {@link estimateMotion} derives `motion`
 *    from the luma fingerprints the shot detector already computes, and
 *    {@link classifyAudioEnergy} turns a real per-chunk loudness curve into
 *    `audio.energy`. The frames the model sees are non-contiguous stills and
 *    carry no audio track at all, so asking it for either produced confident
 *    fabrication; both now come from signal or stay absent.
 *  - {@link buildUnderstandingUserBlocks} / {@link ASSET_UNDERSTANDING_SYSTEM_PROMPT}
 *    frame ONE tool-less "look at these frames and describe the asset" model call,
 *    the frames riding as Anthropic image blocks (real pixels, reusing
 *    `dataUrlToImageBlock` from the vision critic).
 *  - {@link parseAssetUnderstanding} coerces the model's reply into a structured
 *    record the ingest pipeline can trust deterministically — and, like the
 *    Director's `parseVerdict` / `parseReferenceDerivation`, it FAILS SAFE:
 *    unparseable output collapses to a DEGRADED record (`b-roll` @ confidence 0,
 *    empty tags/faces) and never fabricates a role, a face, or a look.
 *  - {@link applyRoleSignal} / {@link effectiveRole} make the role a BELIEF, not a
 *    static label: it is auto-inferred at ingest but can be strengthened by usage
 *    (a usage signal) and overridden outright by a cheap human confirmation.
 *  - {@link computeLumaGrid} / {@link segmentShots} are a shot-boundary detector
 *    (an 8×8 mean-luma fingerprint diff) so a multi-shot source video is tagged
 *    per-shot instead of flooding one asset's tags — reimplemented from the prose
 *    description in `docs/poach/palmier-search-compositing-poaches.md` §1 (NO code
 *    copied; that source is GPL-3.0, this app is MIT).
 *
 * PURE LOGIC by default: no React, no DOM, no IndexedDB, no `DirectorApi`. The
 * frame sampling + persistence live in `services/search/asset-understanding-*`;
 * everything here is unit-testable. The production seams that touch the network
 * are injected so headless tests swap in stubs:
 *
 *  - {@link relayUnderstandAsset} — the default: the same stateless
 *    `/api/llm/agent` relay the Director uses (Anthropic-shaped body).
 *  - {@link geminiUnderstandAsset} — the NATIVE Gemini path: a Gemini-shaped
 *    body (`contents` + `inlineData` parts + `generationConfig.responseSchema`)
 *    against the stateless `/api/llm/gemini` relay.
 *
 * WHICH seam runs is a build-time config ({@link configuredUnderstandingModel},
 * `NEXT_PUBLIC_UNDERSTANDING_MODEL`) resolved by {@link selectUnderstandAssetFn}:
 * unset ⇒ today's behavior (the Director relay, its default brain); a
 * `gemini-*` model (e.g. `gemini-3.5-flash`) ⇒ the native Gemini seam.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { dataUrlToImageBlock } from "@/lib/director/vision-critic";
import type { TranscriptSegmentLite } from "@/lib/search/asset-transcript";

// ── the record ───────────────────────────────────────────────────────────────

/**
 * The role an asset plays in a reel. A BELIEF (see {@link applyRoleSignal}), not
 * a fixed label:
 *  - `hero` — the featured subject / money shot of the reel.
 *  - `product` — a product beauty/detail shot.
 *  - `logo` — a brand mark / wordmark / bug.
 *  - `face-anchor` — a person's face clear enough to anchor identity/seed-lock
 *    (portrait, talking head, spokesperson) — the piece that feeds persona locks.
 *  - `b-roll` — generic supporting/background footage (also the neutral default).
 *  - `screen-rec` — a screen recording / screencast / UI capture.
 */
export type AssetRole =
	| "hero"
	| "product"
	| "logo"
	| "face-anchor"
	| "b-roll"
	| "screen-rec";

/** All roles, in a stable order (UI dropdowns, validation). */
export const ASSET_ROLES: readonly AssetRole[] = [
	"hero",
	"product",
	"logo",
	"face-anchor",
	"b-roll",
	"screen-rec",
] as const;

/**
 * One face the understanding pass found in an asset, reconciled against the
 * persona roster. When `personaMatch` is set the face IS a known cast member;
 * when it's absent and `isNew` is true the face is a recurring stranger the UI
 * can offer to lock as a new persona (seed-lock — our moat vs. face-blind
 * competitors).
 */
export interface AssetFace {
	/** Persona id when this face reconciles to the roster; absent otherwise. */
	personaMatch?: string;
	/** Detection / match confidence in [0, 1]. */
	score: number;
	/**
	 * True ⇒ a recurring face with NO roster match — the UI should suggest a
	 * persona lock. Always the inverse of "has a `personaMatch`".
	 */
	isNew: boolean;
	/**
	 * VLM-reported, identity-anchoring physical descriptor (age range, build,
	 * hair, face, wardrobe, distinguishing features). Reused verbatim as a
	 * `Persona.descriptor` when the user locks a new face.
	 */
	descriptor?: string;
	/**
	 * 0-based index into the sampled frames of the clearest, most front-on view
	 * of this face — the best anchor. Clamped into range by the parser.
	 */
	anchorFrame?: number;
}

/** A quick look probe — the asset's grade / mood / setting, cheaper than a full StyleBible. */
export interface StyleProbe {
	/** Color grade / dominant palette. */
	palette?: string;
	/** Lens, depth of field, film stock, overall mood. */
	lensMood?: string;
	/** Environment, time of day, lighting, atmosphere. */
	setting?: string;
}

// ── deepened perception (Bet 1 — director-intelligence architecture) ──────────
// The fields below are the "continuity-aware fingerprint" widening: ALL optional,
// additive, and versionless — the store is a schema-less keyPath-only IndexedDB
// (see `asset-understanding-store.ts`), so a record produced before this change
// simply lacks them. That's the "shallow" record {@link isDeepUnderstanding}
// detects; nothing here requires a migration or invalidates an old record.

/**
 * Camera-motion energy class, MEASURED by {@link estimateMotion} from the luma
 * fingerprints the shot detector already computes — never reported by the model.
 *
 * Only three classes, and that is deliberate. The old set split moving footage
 * into `pan` vs `handheld`, a distinction that needs dense-frame global-motion
 * estimation; the pass samples frames seconds apart, so that split could only
 * ever be guessed. What an 8×8 mean-luma fingerprint at this cadence DOES
 * support is exactly this ternary: the framing held still, the framing changed,
 * or the clip is cut-driven. Legacy `pan`/`handheld` records collapse to
 * `moving` on read via {@link normalizeMotion}.
 */
export type MotionClass = "static" | "moving" | "fast-cut";

/** All motion classes, in a stable order. */
export const MOTION_CLASSES: readonly MotionClass[] = [
	"static",
	"moving",
	"fast-cut",
] as const;

/** Framing distance the frames establish. */
export type ShotType =
	| "wide"
	| "medium"
	| "close-up"
	| "extreme-close-up"
	| "insert";

/** All shot types, in a stable order (wide → tightest). */
export const SHOT_TYPES: readonly ShotType[] = [
	"wide",
	"medium",
	"close-up",
	"extreme-close-up",
	"insert",
] as const;

/** A brief structured composition note — subject placement, not a full analysis. */
export interface CompositionNote {
	/** Where the subject sits in frame, e.g. "center", "left-third", "right-third". */
	subjectPosition?: string;
	/** Headroom above the subject, e.g. "tight", "normal", "excess". */
	headroom?: string;
	/** True ⇒ the frame roughly follows the rule of thirds. */
	ruleOfThirds?: boolean;
}

/** Coarse loudness band {@link AudioProbe.energy} reports. */
export type AudioEnergy = "low" | "medium" | "high";

/**
 * A coarse audio classification for the clip, MEASURED from the asset's real
 * audio — never reported by the model, which is sent only JPEG stills and
 * receives no audio bytes at any point in this pipeline.
 *
 * Both fields are sourced from passes that actually look at the audio:
 * `hasSpeech` from the stored transcript (`lib/search/asset-transcript`), which
 * answers it definitively, and `energy` from the same deterministic loudness
 * curve the silence detector runs (`lib/auto-cut`), banded by
 * {@link classifyAudioEnergy}. A field whose source hasn't run is ABSENT rather
 * than guessed — notably `hasSpeech: undefined` means "not transcribed yet",
 * which is a different claim from `hasSpeech: false` ("transcribed, silent").
 */
export interface AudioProbe {
	/** True ⇒ the transcript found real speech. Absent ⇒ not transcribed yet. */
	hasSpeech?: boolean;
	/** Coarse loudness/energy band. Absent ⇒ the audio could not be measured. */
	energy?: AudioEnergy;
}

/**
 * Short string descriptors that anchor CONTINUITY across shots — the piece
 * that fuses with persona/seed-lock for match-cutting and identity checks
 * (lighting/white-balance/wardrobe/color matching across cuts of "the same
 * scene"). Each field is a compact phrase, not a full description.
 */
export interface ContinuityFingerprint {
	/** Lighting setup/quality, e.g. "soft key, warm backlight". */
	lighting?: string;
	/** White-balance read, e.g. "warm/tungsten", "cool/daylight", "neutral". */
	whiteBalance?: string;
	/** Wardrobe descriptor, when a person is visible. */
	wardrobe?: string;
	/** Dominant color grade/signature phrase (distinct from {@link StyleProbe.palette} — this is the MATCH-CUTTING fingerprint, not the mood probe). */
	colorSignature?: string;
}

// ── frame provenance, shot structure, transcript cues ────────────────────────
// The pass used to hand the model a bag of anonymous JPEGs: the record said
// WHAT was seen but never WHEN. Two things fell through that gap.
// {@link AssetFace.anchorFrame} — "the frame where this face is clearest", the
// exact frame you would seed a persona lock from — is an index into a list
// nobody kept, so it addressed nothing. And the shot segmentation the sampler
// computes on every video was consumed to pick representatives and then thrown
// away, discarding the answer to "is this a raw take or an already-cut edit?".
//
// The third facet here is new capability rather than a recovered one: frames
// pinned at the moments a SPEAKER points at something, which purely visual
// selection cannot find (see {@link DeicticBeat}).
//
// All three are optional and additive. The store is schema-less and keyPath-only
// (`asset-understanding-store.ts`), so a record written before this simply lacks
// them; nothing here needs a migration.

/**
 * Why a frame was handed to the model.
 *  - `shot` — the representative frame of a detected shot (the default path).
 *  - `transcript-cue` — pinned at a moment the speaker points at something on
 *    screen; see {@link findTranscriptCues}.
 *  - `only-frame` — a still image, or a clip that yielded a single sample.
 */
export type FrameReason = "shot" | "transcript-cue" | "only-frame";

/** One frame the model was shown, and where it came from. */
export interface UnderstandingFrame {
	/**
	 * Frame time in ASSET-RELATIVE seconds — the same timebase as a clip's
	 * `trimStart`/`trimEnd` and as `AssetTranscript` segments, so a consumer can
	 * seek to it without converting.
	 */
	t: number;
	reason: FrameReason;
}

/**
 * The shot structure the sampler measured — REAL cuts only.
 *
 * Deliberately NOT read off {@link segmentShots}, whose segment index also
 * advances on the {@link SHOT_COVERAGE_FLOOR} so that a long static take still
 * gets re-sampled. That floor is correct for picking representatives and wrong
 * for counting cuts: it would report a 40 s locked-off interview as ten shots.
 * {@link summarizeShots} counts only fingerprint divergences past
 * {@link SHOT_DIFF_THRESHOLD}.
 */
export interface ShotSummary {
	/** Distinct shots (cuts + 1). 1 ⇒ one continuous take. */
	count: number;
	/** Asset-relative time of each detected CUT, time-ordered. Empty ⇒ a single take. */
	cutsAtSec: number[];
	/** Mean shot length in seconds across the sampled span. */
	meanShotSec: number;
	/**
	 * True ⇒ the sampling cadence was too sparse for the count to carry much
	 * weight (samples further apart than
	 * {@link MOTION_FAST_CUT_MAX_INTERVAL_SEC}, past which ordinary footage reads
	 * as a cut at nearly every pair — the same sparsity guard
	 * {@link estimateMotion} applies before it will say `fast-cut`). Read a
	 * sparse summary as "at least this many", never as an exact edit count.
	 */
	sparse: boolean;
}

/**
 * A moment where the speaker directs attention at something ON SCREEN — "look
 * at this", "as you can see", "watch what happens".
 *
 * WHY THIS EXISTS: frame selection is otherwise driven entirely by how much the
 * PICTURE changes, and a presenter gesturing at a slide is a LOW visual-change
 * event — precisely the signal the shot detector is built to suppress. So the
 * frames a viewer would call the most important ones are the frames the selector
 * is least likely to pick. Pinning a frame at the cue fixes that. (The technique
 * is poached from bradautomates/claude-video's `--timestamps`; no code copied.)
 *
 * Detected LEXICALLY ({@link findTranscriptCues}), not by a model: judging cues
 * per asset would mean a second paid pass at ingest. A lexical match is wrong
 * sometimes — "look, the point is…" is rhetorical, not deictic — and the cost of
 * being wrong is one extra frame sampled at that second. It never asserts
 * anything about the asset that the frames don't then have to back up.
 */
export interface DeicticBeat {
	/** Asset-relative seconds of the thing pointed at (just after the cue phrase). */
	t: number;
	/** The cue phrase that matched, lowercased. */
	phrase: string;
}

/**
 * The structured, per-asset understanding produced at ingest — the layer ABOVE
 * raw CLIP vectors. This is the STABLE contract the Asset Manifest and Project
 * Bible consume; keep field names and semantics stable.
 */
export interface AssetUnderstanding {
	/** Foreign key to `MediaAsset.id` (and this record's primary key in the store). */
	mediaId: string;
	/** One-line, human-readable description of what the asset shows. */
	caption: string;
	/**
	 * The inferred role BELIEF, auto-classified at ingest. NOT authoritative on
	 * its own — read {@link effectiveRole} so a human `roleConfirmed` override
	 * wins. Degraded records carry `b-roll` at `roleConfidence` 0.
	 */
	role: AssetRole;
	/** Confidence of the inferred {@link role} in [0, 1]. 0 ⇒ no real belief. */
	roleConfidence: number;
	/**
	 * A human (or high-trust usage-signal) override that WINS over the inferred
	 * {@link role}. When set, {@link effectiveRole} returns it and
	 * {@link applyRoleSignal} stops touching the belief. Absent ⇒ trust `role`.
	 */
	roleConfirmed?: AssetRole;
	/**
	 * Open-vocabulary tags observed across MULTIPLE sampled frames (deduped, order
	 * preserved) — not the old fixed 20-label, frame-0-only set.
	 */
	tags: string[];
	/** Faces detected across the frames, reconciled against the persona roster. */
	faces: AssetFace[];
	/** Optional look probe (palette / lens+mood / setting). Absent ⇒ nothing derived. */
	styleProbe?: StyleProbe;
	/**
	 * Camera-motion energy class, MEASURED from the sampled frames' luma
	 * fingerprints by {@link estimateMotion} (the service merges it in after the
	 * model call). Absent ⇒ the frames were too sparse or too few to support a
	 * verdict — a still image never has one.
	 */
	motion?: MotionClass;
	/**
	 * Framing distance, when the frames establish one. Part of the DEEPENED
	 * fields — see {@link isDeepUnderstanding}.
	 */
	shotType?: ShotType;
	/** Brief structured composition note. Absent ⇒ nothing derived. */
	composition?: CompositionNote;
	/** The felt emotional register of the clip (one or two words), when legible. */
	emotion?: string;
	/**
	 * Coarse audio classification (speech presence + loudness band), MEASURED
	 * from the asset's real audio — see {@link AudioProbe}. Absent ⇒ neither
	 * source had anything to say (no transcript yet, no decodable audio track).
	 */
	audio?: AudioProbe;
	/** Continuity fingerprint for match-cutting/identity. Absent ⇒ nothing derived. */
	continuityFingerprint?: ContinuityFingerprint;
	/**
	 * Every frame the model was shown, in time order — WHAT it looked at and
	 * WHEN. Absent on records written before frame provenance existed.
	 *
	 * This is what makes {@link AssetFace.anchorFrame} mean something: that index
	 * addresses THIS array (resolve it with {@link anchorFrameTime}). Without it
	 * the clearest view of a face — the frame you would seed a persona lock from —
	 * could not be recovered once the pass returned.
	 */
	framesSeen?: UnderstandingFrame[];
	/**
	 * Shot structure MEASURED from the sampled frames — see {@link ShotSummary}.
	 * Absent ⇒ fewer than two samples (a still image has no shot structure).
	 */
	shots?: ShotSummary;
	/**
	 * Moments the speaker pointed at something on screen, MEASURED from the
	 * transcript. Absent ⇒ no transcript existed when the pass ran, which is a
	 * different claim from an empty array ("transcript read, no cues in it").
	 * Re-running the pass after transcription fills it.
	 */
	deicticBeats?: DeicticBeat[];
	/** VLM model name that produced this understanding (for invalidation on upgrade). */
	modelName: string;
	/** When the understanding was produced (epoch ms). */
	createdAt: number;
}

/**
 * True ⇒ `u` carries the DEEPENED perception fields. False ⇒ a "shallow"
 * record: either produced before this widening, or a degraded/fail-safe record.
 * Callers use this to detect an asset worth a demand-driven re-extraction — the
 * trigger itself is a follow-up; this is only the detector.
 *
 * Keyed on `shotType` alone. It used to also require `motion`, back when the
 * extraction prompt forced the model to emit one for every clip; `motion` is now
 * MEASURED ({@link estimateMotion}) and legitimately absent for a still image or
 * a too-sparsely-sampled video, so requiring it would mark those assets
 * permanently shallow and invite an extraction loop that could never satisfy it.
 * `shotType` is what's left of "always inferable from the frames the model
 * actually sees", and it stays the signal.
 */
export function isDeepUnderstanding(u: AssetUnderstanding): boolean {
	return u.shotType != null;
}

/**
 * Resolve a face's {@link AssetFace.anchorFrame} to an asset-relative TIME — the
 * moment this person was seen most clearly, as a seekable timestamp.
 *
 * Returns `undefined` when the record predates
 * {@link AssetUnderstanding.framesSeen}, when the face carries no anchor, or
 * when the index falls outside the recorded frames. Callers seed persona locks
 * and thumbnails from this, so never substitute `0` on a miss — `0` is a real
 * timestamp meaning "the first frame".
 */
export function anchorFrameTime(
	u: AssetUnderstanding,
	face: AssetFace,
): number | undefined {
	const frames = u.framesSeen;
	if (!frames?.length) return undefined;
	const i = face.anchorFrame;
	if (i === undefined || !Number.isInteger(i) || i < 0 || i >= frames.length)
		return undefined;
	return frames[i].t;
}

/** The minimal persona shape the pass needs to reconcile faces (decoupled from the store). */
export interface PersonaRef {
	id: string;
	name: string;
	/** Optional descriptor, shown to the VLM so it can match a face to this cast member. */
	descriptor?: string;
}

// ── role as a BELIEF ─────────────────────────────────────────────────────────

/**
 * The role a consumer should ACT on: the human/usage `roleConfirmed` override
 * when present, otherwise the inferred `role`. Always read roles through this —
 * never `u.role` directly — so a confirmation is honored everywhere.
 */
export function effectiveRole(u: AssetUnderstanding): AssetRole {
	return u.roleConfirmed ?? u.role;
}

/** A piece of evidence that an asset plays a given role (e.g. the Director dropped it in a hero slot). */
export interface RoleSignal {
	role: AssetRole;
	/** Evidence strength in (0, 1]. Values outside are clamped. */
	weight: number;
}

/**
 * Fold a usage {@link RoleSignal} into an understanding's role BELIEF and return
 * the updated record (pure — never mutates its input). This is the "role updates
 * by usage" path: e.g. the Director promoting an asset into a hero slot is a
 * strong `hero` signal that strengthens (or, over enough evidence, flips) the
 * inferred role.
 *
 * Rules:
 *  - A `roleConfirmed` override is ABSOLUTE — a human said so, so signals are
 *    ignored and the record is returned unchanged.
 *  - A signal AGREEING with the current role raises confidence toward 1:
 *    `c' = c + (1 − c)·w`.
 *  - A signal DISAGREEING decays the current confidence (`c' = c·(1 − w)`); if the
 *    incoming evidence `w` now outweighs the decayed belief, the role FLIPS to the
 *    signalled role at confidence `w`.
 *
 * NOTE: the wiring that EMITS these signals (the Director calling this when it
 * uses an asset) is a documented stub — see the service's `reinforceRole`. This
 * update rule itself is real and fully tested.
 */
export function applyRoleSignal(
	u: AssetUnderstanding,
	signal: RoleSignal,
): AssetUnderstanding {
	if (u.roleConfirmed) return u; // human override wins — signals can't move it.

	const w = Math.min(1, Math.max(0, signal.weight));
	if (w === 0) return u;

	if (signal.role === u.role) {
		const c = clamp01(u.roleConfidence);
		return { ...u, roleConfidence: c + (1 - c) * w };
	}

	const decayed = clamp01(u.roleConfidence) * (1 - w);
	if (w > decayed) {
		// The new evidence outweighs the (decayed) old belief — flip the role.
		return { ...u, role: signal.role, roleConfidence: w };
	}
	return { ...u, roleConfidence: decayed };
}

// ── model-call framing ───────────────────────────────────────────────────────

/**
 * System prompt for the tool-less asset-understanding model call.
 *
 * Deliberately asks for NEITHER camera motion NOR audio. The call is handed 1–8
 * JPEG stills sampled seconds apart, with no audio bytes and no contiguous
 * frames — it has no evidence for either, and an earlier version of this prompt
 * that required both ("never omit these two") got exactly what it asked for:
 * confident, fabricated values that consumers downstream read as observed fact.
 * `motion` is now measured by {@link estimateMotion} and `audio` from the
 * transcript + a real loudness curve; see {@link AudioProbe}.
 */
export const ASSET_UNDERSTANDING_SYSTEM_PROMPT = [
	"You are the ingest EYE of an AI video editor. You are shown 1–8 frames sampled IN TIME ORDER from ONE media asset a user just imported (a video clip or a still). You may also be given a KNOWN CAST list (personas already in the project) and an optional HINT.",
	"Your job is to describe what the asset IS, as a compact structured record, so the editor can file it by role and by who is in it. Describe ONLY what is actually visible across the frames; never invent a subject, a person, a role, or a look the frames don't show.",
	"Reply with ONE minified JSON object and nothing else:",
	'{"caption":"<one sentence>","role":"hero"|"product"|"logo"|"face-anchor"|"b-roll"|"screen-rec","roleConfidence":<0-1>,"tags":["<open-vocab object/person/scene tags>"],"faces":[{"persona":"<exact KNOWN CAST name, or empty if not a known person>","descriptor":"<age range, build, hair, face, wardrobe, distinguishing features>","recurring":<true if this person appears across multiple frames>,"anchorIndex":<0-based frame index where this face is clearest>,"confidence":<0-1>}],"style":{"palette":"<color grade>","lensMood":"<lens/DoF/film stock/mood>","setting":"<environment, time of day, lighting>"},"shotType":"wide"|"medium"|"close-up"|"extreme-close-up"|"insert","composition":{"subjectPosition":"<e.g. center, left-third, right-third>","headroom":"<tight|normal|excess>","ruleOfThirds":<true|false>},"emotion":"<1-2 words for the felt register, e.g. joyful, tense, somber>","continuity":{"lighting":"<short phrase>","whiteBalance":"<warm|cool|neutral, or a short phrase>","wardrobe":"<short phrase, omit if no person>","colorSignature":"<dominant grade/color phrase>"}}',
	"Rules:",
	"- role: pick the SINGLE best fit. hero = the featured subject/money shot; product = a product beauty/detail shot; logo = a brand mark/wordmark/bug; face-anchor = a person's face clear and front-on enough to anchor identity; b-roll = generic supporting/background footage; screen-rec = a screen recording / screencast / UI capture. roleConfidence reflects how sure you are.",
	"- tags: 6–18 concise OPEN-vocabulary tags for the salient objects, people, actions, and scene — across ALL the frames, not just the first. Prefer concrete nouns. Do not pad with near-duplicates.",
	"- faces: include an entry ONLY for a clearly visible human face. If the person matches a KNOWN CAST member, set persona to that EXACT name; otherwise leave persona empty and give a good descriptor. Omit the faces array entirely when no human face is present. Never guess a cast name you were not given.",
	"- style: fill the fields the frames actually establish; omit a field (or the whole style object) when the frames say nothing about it. Keep each a compact phrase.",
	"- shotType: pick the single best fit from the given options when the framing is legible; OMIT it when the frames genuinely don't establish a framing distance. Do not pick one to fill the field.",
	"- composition, emotion, continuity: fill ONLY the sub-fields the frames actually establish; omit a sub-field (or the whole object) when unclear. Keep every phrase compact (a few words). continuity.wardrobe applies only when a person is visible.",
	"- Do NOT report camera motion or anything about audio. You are shown still frames sampled seconds apart and no audio; both are measured elsewhere from the real signal. Any such field you emit is discarded.",
	"- Prefer the HINT for intent, but the FRAMES are the source of truth. When unsure about role or a face, lower the confidence rather than inventing certainty.",
].join("\n");

/** Render the persona roster as the KNOWN CAST block the VLM matches faces against. */
export function renderPersonaRoster(personas: PersonaRef[]): string {
	const lines = personas
		.map((p) => cleanStr(p.name))
		.filter((n): n is string => Boolean(n));
	if (lines.length === 0) return "";
	const detailed = personas
		.map((p) => {
			const name = cleanStr(p.name);
			if (!name) return null;
			const desc = cleanStr(p.descriptor);
			return desc ? `${name} — ${desc}` : name;
		})
		.filter((l): l is string => Boolean(l));
	return `KNOWN CAST (match a visible face to one of these EXACT names, or leave persona empty):\n${detailed.join(
		"\n",
	)}`;
}

/**
 * Build the user-turn content for an understanding call: an intro (hint + known
 * cast) as text, then each sampled frame as an image block (index order preserved
 * so `anchorIndex` lines up). Frames that aren't decodable base64 data URLs are
 * silently dropped.
 */
export function buildUnderstandingUserBlocks(
	frames: string[],
	opts?: { personas?: PersonaRef[]; hint?: string },
): Anthropic.ContentBlockParam[] {
	const blocks: Anthropic.ContentBlockParam[] = [
		{ type: "text", text: understandingIntroText(frames.length, opts) },
	];
	for (const frame of frames) {
		const block = dataUrlToImageBlock(frame);
		if (block) blocks.push(block);
	}
	return blocks;
}

/**
 * The shared intro text (hint + known cast + frame count) every understanding
 * request leads with, regardless of which relay dialect carries the frames —
 * kept as one helper so the Anthropic and Gemini builders can never drift.
 */
function understandingIntroText(
	frameCount: number,
	opts?: { personas?: PersonaRef[]; hint?: string },
): string {
	const hint = cleanStr(opts?.hint);
	const roster = renderPersonaRoster(opts?.personas ?? []);
	const introParts: string[] = [];
	if (hint) introParts.push(`HINT (what the user is doing): ${hint}`);
	if (roster) introParts.push(roster);
	introParts.push(
		`The ${frameCount} frame(s) from ONE asset follow in time order (index 0 first). Describe the asset as the JSON record.`,
	);
	return introParts.join("\n\n");
}

// ── parsing (fail-safe) ──────────────────────────────────────────────────────

/** Context the parser needs to resolve a reply into a persisted understanding. */
export interface UnderstandingParseContext {
	mediaId: string;
	/** Number of frames sent (bounds `anchorIndex`). */
	imageCount: number;
	/** The persona roster, to resolve a reported cast name → a persona id. */
	personas: PersonaRef[];
	/** VLM model name that produced the reply. */
	modelName: string;
	/** Override the timestamp (tests); defaults to `Date.now()`. */
	now?: number;
}

/**
 * The DEGRADED understanding: the fail-safe every unparseable / malformed reply
 * collapses to. `b-roll` @ confidence 0 with empty tags/faces means "unknown —
 * treat as generic footage, trust nothing here" — it never fabricates a role, a
 * face, or a look.
 */
export function degradedUnderstanding(
	ctx: Pick<UnderstandingParseContext, "mediaId" | "modelName" | "now">,
	caption = "",
): AssetUnderstanding {
	return {
		mediaId: ctx.mediaId,
		caption,
		role: "b-roll",
		roleConfidence: 0,
		tags: [],
		faces: [],
		modelName: ctx.modelName,
		createdAt: ctx.now ?? Date.now(),
	};
}

/**
 * Parse an understanding model reply into an {@link AssetUnderstanding}. Always
 * returns a valid record — this is the deterministic gate the ingest pipeline
 * trusts, so it FAILS SAFE: unparseable output, malformed JSON, or an unusable
 * body collapse to {@link degradedUnderstanding} (`b-roll` @ confidence 0, no
 * tags, no faces) rather than inventing a classification.
 */
export function parseAssetUnderstanding(
	text: string,
	ctx: UnderstandingParseContext,
): AssetUnderstanding {
	const json = firstJsonObject(text);
	if (!json) return degradedUnderstanding(ctx);

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return degradedUnderstanding(ctx);
	}

	const caption = cleanStr(obj.caption ?? obj.description) ?? "";
	const { role, roleConfidence } = parseRole(obj.role, obj.roleConfidence);
	const tags = parseTags(obj.tags);
	const faces = parseFaces(obj.faces, ctx.imageCount, ctx.personas);
	const styleProbe = parseStyleProbe(obj.style);
	const shotType = normalizeShotType(obj.shotType) ?? undefined;
	const composition = parseComposition(obj.composition);
	const emotion = cleanStr(obj.emotion ?? obj.tone);
	// `motion` and `audio` are NOT read off the reply — the model has no evidence
	// for either (stills only, no audio) and a value here would be invention. The
	// service merges in the measured ones after this parse; a model that emits
	// them anyway is silently ignored.
	const continuityFingerprint = parseContinuityFingerprint(
		obj.continuity ?? obj.continuityFingerprint,
	);

	return {
		mediaId: ctx.mediaId,
		caption,
		role,
		roleConfidence,
		tags,
		faces,
		...(styleProbe ? { styleProbe } : {}),
		...(shotType ? { shotType } : {}),
		...(composition ? { composition } : {}),
		...(emotion ? { emotion } : {}),
		...(continuityFingerprint ? { continuityFingerprint } : {}),
		modelName: ctx.modelName,
		createdAt: ctx.now ?? Date.now(),
	};
}

/**
 * Map a loose motion string to a canonical {@link MotionClass}, or null.
 *
 * No longer parses a model reply (the pass doesn't ask for motion any more) —
 * this is the READ path. Its live job is collapsing records already sitting in
 * the schema-less store under the old four-class vocabulary: `pan` and
 * `handheld` were the two the frames could never actually distinguish, and both
 * mean `moving`. The store needs no migration because every reader that cares
 * runs a stored value through here first.
 */
export function normalizeMotion(raw: unknown): MotionClass | null {
	const s = String(raw ?? "")
		.toLowerCase()
		.trim();
	if (!s) return null;
	if ((MOTION_CLASSES as readonly string[]).includes(s))
		return s as MotionClass;
	if (s.includes("fast") || s.includes("whip") || s.includes("quick cut"))
		return "fast-cut";
	if (
		s.includes("handheld") ||
		s.includes("shaky") ||
		s.includes("shake") ||
		s.includes("pan") ||
		s.includes("tilt") ||
		s.includes("dolly") ||
		s.includes("track") ||
		s.includes("moving") ||
		s.includes("gimbal")
	)
		return "moving";
	if (
		s.includes("static") ||
		s.includes("locked") ||
		s.includes("tripod") ||
		s.includes("still") ||
		s.includes("fixed")
	)
		return "static";
	return null;
}

/** Map a loose shot-type string (synonyms included) to a canonical {@link ShotType}, or null. */
export function normalizeShotType(raw: unknown): ShotType | null {
	const s = String(raw ?? "")
		.toLowerCase()
		.trim();
	if (!s) return null;
	if ((SHOT_TYPES as readonly string[]).includes(s)) return s as ShotType;
	// Check the most specific first so "extreme close-up" isn't caught by the
	// looser "close" rule.
	if (s.includes("extreme close") || s === "ecu" || s.includes("macro"))
		return "extreme-close-up";
	if (s.includes("close") || s === "cu") return "close-up";
	if (s.includes("insert") || s.includes("detail shot")) return "insert";
	if (s.includes("medium") || s === "ms" || s.includes("mid shot"))
		return "medium";
	if (
		s.includes("wide") ||
		s.includes("establishing") ||
		s === "ws" ||
		s.includes("long shot")
	)
		return "wide";
	return null;
}

/** Coerce a loose `composition` object into a {@link CompositionNote}, or undefined when empty. */
function parseComposition(raw: unknown): CompositionNote | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const subjectPosition = cleanStr(obj.subjectPosition ?? obj.position);
	const headroom = cleanStr(obj.headroom);
	const ruleOfThirds =
		typeof obj.ruleOfThirds === "boolean" ? obj.ruleOfThirds : undefined;
	if (!subjectPosition && !headroom && ruleOfThirds === undefined)
		return undefined;
	return {
		...(subjectPosition ? { subjectPosition } : {}),
		...(headroom ? { headroom } : {}),
		...(ruleOfThirds !== undefined ? { ruleOfThirds } : {}),
	};
}

/** Coerce a loose `continuity` object into a {@link ContinuityFingerprint}, or undefined when empty. */
function parseContinuityFingerprint(
	raw: unknown,
): ContinuityFingerprint | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const lighting = cleanStr(obj.lighting);
	const whiteBalance = cleanStr(obj.whiteBalance ?? obj.whitebalance ?? obj.wb);
	const wardrobe = cleanStr(obj.wardrobe);
	const colorSignature = cleanStr(obj.colorSignature ?? obj.color);
	if (!lighting && !whiteBalance && !wardrobe && !colorSignature)
		return undefined;
	return {
		...(lighting ? { lighting } : {}),
		...(whiteBalance ? { whiteBalance } : {}),
		...(wardrobe ? { wardrobe } : {}),
		...(colorSignature ? { colorSignature } : {}),
	};
}

/** Map a loose role string (synonyms included) to a canonical {@link AssetRole}, or null. */
export function normalizeRole(raw: unknown): AssetRole | null {
	const s = String(raw ?? "")
		.toLowerCase()
		.trim();
	if (!s) return null;
	// Check the most specific first so "screen recording" isn't caught by a
	// looser rule, and "b-roll" (the catch-all) is checked last.
	if (s.includes("screen") || s.includes("screencast") || s.includes("capture"))
		return "screen-rec";
	if (s.includes("logo") || s.includes("wordmark") || s.includes("brand mark"))
		return "logo";
	if (s.includes("product")) return "product";
	if (
		s.includes("face") ||
		s.includes("portrait") ||
		s.includes("talking head") ||
		s.includes("headshot") ||
		s.includes("spokesperson") ||
		s.includes("presenter") ||
		s.includes("selfie")
	)
		return "face-anchor";
	if (s.includes("hero") || s === "main" || s === "feature") return "hero";
	if (
		s.includes("b-roll") ||
		s.includes("broll") ||
		s.includes("b roll") ||
		s.includes("background") ||
		s.includes("filler") ||
		s === "generic"
	)
		return "b-roll";
	return null;
}

/** Coerce a loose role + confidence into a canonical pair; unknown role ⇒ b-roll @ 0. */
function parseRole(
	rawRole: unknown,
	rawConfidence: unknown,
): { role: AssetRole; roleConfidence: number } {
	const role = normalizeRole(rawRole);
	if (!role) return { role: "b-roll", roleConfidence: 0 };
	const parsed = Number(rawConfidence);
	const roleConfidence = Number.isFinite(parsed) ? clamp01(parsed) : 0.5;
	return { role, roleConfidence };
}

/** Coerce a loose tags array into deduped, trimmed, non-empty strings (order kept). */
function parseTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		const tag = cleanStr(item);
		if (!tag) continue;
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(tag);
	}
	return out;
}

/**
 * Coerce a loose faces array into reconciled {@link AssetFace}s. A face is kept
 * only when it carries something actionable — a roster match OR a descriptor;
 * bare noise is dropped. `persona` is resolved against the roster BY NAME
 * (case-insensitive), so a hallucinated name that isn't in the roster is treated
 * as a NEW face (`isNew`), never a fabricated match.
 */
function parseFaces(
	raw: unknown,
	imageCount: number,
	personas: PersonaRef[],
): AssetFace[] {
	if (!Array.isArray(raw)) return [];
	const maxIndex = Math.max(0, imageCount - 1);
	const out: AssetFace[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const face = item as Record<string, unknown>;
		const descriptor = cleanStr(face.descriptor ?? face.description);
		const reportedName = cleanStr(face.persona ?? face.name);
		const match = reportedName
			? personas.find(
					(p) => p.name.trim().toLowerCase() === reportedName.toLowerCase(),
				)
			: undefined;

		// Keep only faces we can act on: a known cast match, or a stranger we can
		// describe (and therefore offer to lock).
		if (!match && !descriptor) continue;

		const rawConfidence = Number(face.confidence ?? face.score);
		const score = Number.isFinite(rawConfidence) ? clamp01(rawConfidence) : 0.5;
		const rawIndex = Number(face.anchorIndex ?? face.anchorFrame);
		const anchorFrame = Number.isFinite(rawIndex)
			? Math.min(maxIndex, Math.max(0, Math.floor(rawIndex)))
			: undefined;

		out.push({
			...(match ? { personaMatch: match.id } : {}),
			score,
			isNew: !match,
			...(descriptor ? { descriptor } : {}),
			...(anchorFrame !== undefined ? { anchorFrame } : {}),
		});
	}
	return out;
}

/** Coerce a loose `style` object into a {@link StyleProbe}, or undefined when empty. */
function parseStyleProbe(raw: unknown): StyleProbe | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const palette = cleanStr(obj.palette);
	const lensMood = cleanStr(obj.lensMood ?? obj.lens ?? obj.mood);
	const setting = cleanStr(obj.setting ?? obj.location);
	if (!palette && !lensMood && !setting) return undefined;
	return {
		...(palette ? { palette } : {}),
		...(lensMood ? { lensMood } : {}),
		...(setting ? { setting } : {}),
	};
}

// ── shot-boundary detection (Palmier §1, reimplemented from prose) ────────────

/** An 8×8 mean-luma fingerprint of a frame — 64 values in [0, 1], row-major. */
export type LumaGrid = number[];

/** Grid resolution (8×8 = 64 cells), matching the cheap fingerprint in the poach doc. */
export const LUMA_GRID_SIZE = 8;

/** Mean-absolute-difference above which two consecutive fingerprints are a new shot. */
export const SHOT_DIFF_THRESHOLD = 0.12;

/** Force a fresh sample at least this often (frames) so long static shots still get coverage. */
export const SHOT_COVERAGE_FLOOR = 4;

/**
 * Compute an `gridSize`×`gridSize` mean-luma fingerprint from raw RGBA pixel data
 * (as returned by a canvas `getImageData`). Deliberately crude/cheap — a mean per
 * cell, not a histogram — which is all the shot-diff needs. Pure: takes a plain
 * `{ data, width, height }` so it's testable without a DOM.
 */
export function computeLumaGrid(
	image: { data: ArrayLike<number>; width: number; height: number },
	gridSize: number = LUMA_GRID_SIZE,
): LumaGrid {
	const { data, width, height } = image;
	const sums = new Array<number>(gridSize * gridSize).fill(0);
	const counts = new Array<number>(gridSize * gridSize).fill(0);
	for (let y = 0; y < height; y++) {
		const cy = Math.min(gridSize - 1, Math.floor((y / height) * gridSize));
		for (let x = 0; x < width; x++) {
			const cx = Math.min(gridSize - 1, Math.floor((x / width) * gridSize));
			const p = (y * width + x) * 4;
			// Rec. 601 luma, normalized to [0, 1].
			const luma =
				(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
			const cell = cy * gridSize + cx;
			sums[cell] += luma;
			counts[cell] += 1;
		}
	}
	return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0));
}

/** Mean absolute difference between two luma fingerprints (0 = identical, 1 = opposite). */
export function gridDiff(a: LumaGrid, b: LumaGrid): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return 0;
	let sum = 0;
	for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
	return sum / n;
}

/**
 * Assign a shot index to each candidate frame (in order) from its luma
 * fingerprint. A frame opens a NEW shot when its fingerprint diverges from the
 * last KEPT reference beyond {@link SHOT_DIFF_THRESHOLD}, OR when the coverage
 * floor has elapsed (so a long static shot still re-samples). Returns one
 * shotIndex per input grid.
 */
export function segmentShots(
	grids: LumaGrid[],
	opts?: { threshold?: number; coverageFloor?: number },
): number[] {
	const threshold = opts?.threshold ?? SHOT_DIFF_THRESHOLD;
	const coverageFloor = Math.max(1, opts?.coverageFloor ?? SHOT_COVERAGE_FLOOR);
	const out: number[] = [];
	let shot = 0;
	let ref: LumaGrid | null = null;
	let sinceRef = 0;
	for (const grid of grids) {
		if (ref === null) {
			ref = grid;
			sinceRef = 0;
			out.push(shot);
			continue;
		}
		sinceRef += 1;
		const isCut = gridDiff(ref, grid) > threshold;
		const flooredOut = sinceRef >= coverageFloor;
		if (isCut || flooredOut) {
			// A real cut, OR the coverage floor elapsed (so a long static shot still
			// yields periodic representation instead of one flooded segment).
			shot += 1;
			ref = grid;
			sinceRef = 0;
		}
		out.push(shot);
	}
	return out;
}

/**
 * Pick one representative frame index per shot from a `segmentShots` result: the
 * FIRST frame of each shot (the cut point). Optionally capped at `maxFrames`,
 * spread evenly across the shots so a long multi-shot source still yields a
 * bounded, well-distributed set to caption. This is what keeps a multi-shot video
 * from flooding the VLM (and the tags) with near-identical frames.
 */
export function pickShotRepresentatives(
	shotIndices: number[],
	maxFrames?: number,
): number[] {
	const firsts: number[] = [];
	let prev = -1;
	for (let i = 0; i < shotIndices.length; i++) {
		if (shotIndices[i] !== prev) {
			firsts.push(i);
			prev = shotIndices[i];
		}
	}
	if (!maxFrames || firsts.length <= maxFrames) return firsts;
	// Evenly subsample the shot representatives down to the cap.
	const out: number[] = [];
	const step = firsts.length / maxFrames;
	for (let k = 0; k < maxFrames; k++) out.push(firsts[Math.floor(k * step)]);
	return Array.from(new Set(out));
}

/** One sampled frame, as {@link chooseUnderstandingFrames} needs to see it. */
export interface FrameCandidate {
	/** Asset-relative seconds. */
	timestampSec: number;
	/** The frame's luma fingerprint. */
	grid: LumaGrid;
	/** How this sample got into the list. */
	reason: FrameReason;
}

/**
 * Choose which sampled candidates the model actually sees, returning their
 * indices in TIME order.
 *
 * Two rules, in this order:
 *  1. **Cue frames are pinned.** A `transcript-cue` candidate is reserved
 *     against `maxFrames` BEFORE the shot pass runs, so even-sampling can never
 *     evict it. That ordering is the whole point: a speaker gesturing at a slide
 *     barely moves the picture, so the visual selector is exactly the thing that
 *     would drop the frame if it were allowed to vote.
 *  2. **The remaining budget goes to shot coverage** — one representative per
 *     detected shot ({@link segmentShots} + {@link pickShotRepresentatives}),
 *     computed over the UNIFORM candidates only so a cue's off-grid timestamp
 *     can't invent a shot boundary.
 *
 * Pure so the budget arithmetic is testable without a DOM; the sampling that
 * produces the candidates lives in `services/search/asset-understanding-service`.
 */
export function chooseUnderstandingFrames(
	candidates: FrameCandidate[],
	maxFrames: number,
): number[] {
	if (candidates.length === 0 || maxFrames <= 0) return [];
	if (candidates.length === 1) return [0];

	const cueIdx: number[] = [];
	const uniformIdx: number[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (candidates[i].reason === "transcript-cue") cueIdx.push(i);
		else uniformIdx.push(i);
	}

	// Never let cues take the whole budget — the model still has to be able to
	// tell what the asset IS, which is what the shot coverage is for.
	const pinned = cueIdx.slice(0, Math.max(0, maxFrames - 1));
	const repBudget = Math.max(1, maxFrames - pinned.length);
	const reps = pickShotRepresentatives(
		segmentShots(uniformIdx.map((i) => candidates[i].grid)),
		repBudget,
	);

	const chosen = new Set<number>(pinned);
	for (const r of reps) {
		const original = uniformIdx[r];
		if (original !== undefined) chosen.add(original);
	}
	return [...chosen].sort(
		(a, b) => candidates[a].timestampSec - candidates[b].timestampSec,
	);
}

// ── measured facets (deterministic — never asked of the model) ───────────────
// The two facets the understanding CALL cannot honestly produce. Both are pure
// and live here (not in the service) so they're unit-testable without a DOM.

/**
 * Mean fingerprint diff at or below which consecutive in-shot frames read as the
 * SAME framing — i.e. the camera didn't go anywhere between samples.
 */
export const MOTION_STATIC_DIFF = 0.02;

/** Fraction of consecutive sample pairs that must be CUTS before a clip reads as cut-driven. */
export const MOTION_FAST_CUT_RATIO = 0.6;

/**
 * Longest mean sampling interval (seconds) at which a cut ratio still means
 * anything. Sample two frames 12 s apart in ordinary footage and nearly every
 * pair looks like a cut — that's the sampler being sparse, not the edit being
 * fast, so past this interval we decline to call `fast-cut` at all.
 */
export const MOTION_FAST_CUT_MAX_INTERVAL_SEC = 3;

/** Minimum consecutive pairs before the cut ratio is trusted (one stray cut must not decide it). */
export const MOTION_FAST_CUT_MIN_PAIRS = 4;

/** One frame's motion evidence: its luma fingerprint and when it was sampled. */
export interface MotionSample {
	grid: LumaGrid;
	timestampSec: number;
}

/**
 * Estimate a clip's {@link MotionClass} from the luma fingerprints the shot
 * detector already computed — no second decode, no model call, no guess.
 *
 * Each consecutive pair is either a CUT (fingerprint diverges past
 * {@link SHOT_DIFF_THRESHOLD}, the same line {@link segmentShots} draws) or an
 * IN-SHOT pair. A high cut ratio over a dense enough sampling ⇒ `fast-cut`;
 * otherwise the mean in-shot diff says whether the framing held
 * ({@link MOTION_STATIC_DIFF} ⇒ `static`) or moved (⇒ `moving`).
 *
 * Returns `null` — the honest answer — when the samples can't support a verdict:
 * fewer than two frames (every still image), or every pair a cut at a cadence
 * too sparse to distinguish a fast edit from a slow sampler. Callers OMIT the
 * field rather than substituting a default; see {@link AssetUnderstanding.motion}.
 */
export function estimateMotion(samples: MotionSample[]): MotionClass | null {
	if (samples.length < 2) return null;

	let cuts = 0;
	let pairs = 0;
	let inShotDiffSum = 0;
	let inShotPairs = 0;
	let intervalSum = 0;
	for (let i = 1; i < samples.length; i++) {
		const diff = gridDiff(samples[i - 1].grid, samples[i].grid);
		pairs += 1;
		intervalSum += Math.abs(
			samples[i].timestampSec - samples[i - 1].timestampSec,
		);
		if (diff > SHOT_DIFF_THRESHOLD) {
			cuts += 1;
		} else {
			inShotDiffSum += diff;
			inShotPairs += 1;
		}
	}

	const meanInterval = intervalSum / pairs;
	if (
		pairs >= MOTION_FAST_CUT_MIN_PAIRS &&
		meanInterval > 0 &&
		meanInterval <= MOTION_FAST_CUT_MAX_INTERVAL_SEC &&
		cuts / pairs >= MOTION_FAST_CUT_RATIO
	)
		return "fast-cut";

	// Every pair was a cut, but too sparsely sampled to call it a fast edit —
	// there is no in-shot evidence left to read, so say nothing.
	if (inShotPairs === 0) return null;

	return inShotDiffSum / inShotPairs <= MOTION_STATIC_DIFF
		? "static"
		: "moving";
}

/**
 * Summarize a clip's SHOT STRUCTURE from the same luma fingerprints
 * {@link estimateMotion} reads — cuts only, no coverage floor (see
 * {@link ShotSummary} for why that distinction matters).
 *
 * Answers a question the pass could not answer before: is this a RAW TAKE or
 * something already cut? Those want opposite treatment — you re-cut raw footage
 * and you leave a finished edit alone — and until now the segmentation that
 * knows was computed for frame selection and discarded.
 *
 * Returns `null` for fewer than two samples: a still image has no shot
 * structure, and saying `count: 1` there would dress up an absence as a
 * measurement.
 */
export function summarizeShots(samples: MotionSample[]): ShotSummary | null {
	if (samples.length < 2) return null;

	const cutsAtSec: number[] = [];
	let intervalSum = 0;
	for (let i = 1; i < samples.length; i++) {
		intervalSum += Math.abs(
			samples[i].timestampSec - samples[i - 1].timestampSec,
		);
		if (gridDiff(samples[i - 1].grid, samples[i].grid) > SHOT_DIFF_THRESHOLD)
			cutsAtSec.push(samples[i].timestampSec);
	}

	const count = cutsAtSec.length + 1;
	const span = Math.abs(
		samples[samples.length - 1].timestampSec - samples[0].timestampSec,
	);
	return {
		count,
		cutsAtSec,
		meanShotSec: span > 0 ? span / count : 0,
		sparse:
			intervalSum / (samples.length - 1) > MOTION_FAST_CUT_MAX_INTERVAL_SEC,
	};
}

// ── transcript cues (deictic frame pinning) ─────────────────────────────────
// Technique poached from bradautomates/claude-video's `--timestamps` flag (MIT;
// prose/idea only, no code copied). See {@link DeicticBeat} for why visual
// selection alone cannot find these moments.

/**
 * Phrase fragments with which a speaker points at something ON SCREEN, as
 * regex source, matched case-insensitively against segment text.
 *
 * Kept deliberately tight. A bare "look" or "see" is far more often rhetorical
 * ("look, the point is…", "I see what you mean") than deictic, so every entry
 * requires the pointing complement that makes it about something visible. The
 * list errs toward MISSING a cue rather than firing on one: a missed cue costs
 * the frame we would have had anyway under the old behaviour, while a false
 * one spends a slot out of a budget of {@link MAX_TRANSCRIPT_CUES}.
 */
export const DEICTIC_CUE_SOURCES: readonly string[] = [
	"look at (?:this|that|these|those|the|it|how|what)",
	"(?:take|have) a look",
	"let me show you",
	"(?:if|when) you look",
	"as you can (?:see|tell)",
	"you can see (?:this|that|these|those|the|it|here|how|what)",
	"notice (?:how|that|the|this|these|what)",
	"watch (?:this|that|closely|carefully|how|what happens)",
	"(?:right|over|down|up|in) here",
	"see here",
	"here (?:we have|you can see|you see|is the|is what|is where)",
	"check (?:this|it) out",
	"pay attention to",
	"(?:shown|highlighted|circled|pictured) (?:here|below|above)",
	"on (?:the )?screen",
	"this (?:one )?right here",
];

/**
 * Seconds added after the cue phrase ends. The thing being pointed at lands ON
 * or just AFTER the words — "watch what happens" precedes what happens — so
 * sampling at the phrase boundary would catch the setup instead of the payoff.
 */
export const CUE_LEAD_SEC = 0.4;

/** Cues closer together than this collapse to the first; consecutive cues describe one moment. */
export const CUE_MIN_GAP_SEC = 1.5;

/**
 * Most cues one asset contributes. Cue frames are PINNED — reserved against the
 * frame budget before shot representatives are picked — so an uncapped list
 * from a lecture could crowd out the coverage that tells the model what the
 * asset IS. Four of eight leaves half the budget for the shot pass.
 */
export const MAX_TRANSCRIPT_CUES = 4;

/** Options for {@link findTranscriptCues}. */
export interface TranscriptCueOptions {
	/** Seconds after the cue phrase to sample (default {@link CUE_LEAD_SEC}). */
	leadSec?: number;
	/** Minimum spacing between kept cues (default {@link CUE_MIN_GAP_SEC}). */
	minGapSec?: number;
	/** Cap on returned cues (default {@link MAX_TRANSCRIPT_CUES}). */
	maxCues?: number;
	/** Asset duration in seconds; cue times are clamped inside it when given. */
	durationSec?: number;
}

/**
 * Locate each word's character span within `text` so a regex match can be
 * resolved back to a WORD, and from there to a real timestamp.
 *
 * Scans forward with a cursor, so repeated words map in order. A word the
 * provider spelled differently from the segment text (punctuation folding,
 * normalization) simply doesn't map and is skipped — the caller degrades to the
 * previous mapped word rather than guessing a position.
 */
function mapWordCharStarts(
	text: string,
	words: { word: string; end: number }[],
): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	let cursor = 0;
	for (const w of words) {
		const needle = w.word.trim().toLowerCase();
		if (!needle) continue;
		const at = text.indexOf(needle, cursor);
		if (at < 0) continue;
		out.push({ start: at, end: w.end });
		cursor = at + needle.length;
	}
	return out;
}

/**
 * Find the moments a speaker points at something on screen, as
 * {@link DeicticBeat}s in ASSET-RELATIVE seconds.
 *
 * TIME RESOLUTION, and its honest limits. With per-word timings (MAI-Transcribe-2
 * aligns words for real — see `isWordTimed`) the cue resolves to the END of the
 * matching phrase's last word, which is accurate to a word. WITHOUT them the
 * only defensible answer is the segment's own start: the cue is somewhere in
 * that sentence and interpolating a position inside it would be invented
 * precision of exactly the kind the confabulation fix removed from this pass.
 * A whole-segment anchor is a worse frame, not a wrong claim.
 *
 * Over-cap cues are subsampled EVENLY across the asset rather than truncated,
 * so a 10-minute talk doesn't spend its whole cue budget in the first minute.
 */
export function findTranscriptCues(
	segments: TranscriptSegmentLite[],
	opts?: TranscriptCueOptions,
): DeicticBeat[] {
	const lead = opts?.leadSec ?? CUE_LEAD_SEC;
	const minGap = opts?.minGapSec ?? CUE_MIN_GAP_SEC;
	const maxCues = Math.max(0, opts?.maxCues ?? MAX_TRANSCRIPT_CUES);
	const duration = opts?.durationSec;
	if (maxCues === 0 || segments.length === 0) return [];

	const re = new RegExp(`\\b(?:${DEICTIC_CUE_SOURCES.join("|")})`, "g");
	const found: DeicticBeat[] = [];

	for (const seg of segments) {
		const text = (seg.text ?? "").toLowerCase();
		if (!text) continue;
		const ranges = seg.words?.length ? mapWordCharStarts(text, seg.words) : [];
		re.lastIndex = 0;
		for (const m of text.matchAll(re)) {
			const matchEnd = (m.index ?? 0) + m[0].length;
			// Last word that STARTS before the match ends — the phrase's own last word.
			let wordEnd: number | undefined;
			for (const r of ranges) {
				if (r.start < matchEnd) wordEnd = r.end;
				else break;
			}
			const base = wordEnd ?? seg.start;
			let t = base + lead;
			if (duration !== undefined && duration > 0)
				t = Math.min(t, Math.max(0, duration - 0.05));
			t = Math.max(0, t);
			found.push({ t: Math.round(t * 100) / 100, phrase: m[0] });
		}
	}

	found.sort((a, b) => a.t - b.t);

	const spaced: DeicticBeat[] = [];
	for (const cue of found) {
		const prev = spaced[spaced.length - 1];
		if (prev && cue.t - prev.t < minGap) continue;
		spaced.push(cue);
	}
	if (spaced.length <= maxCues) return spaced;

	const step = spaced.length / maxCues;
	const picked: DeicticBeat[] = [];
	for (let k = 0; k < maxCues; k++) picked.push(spaced[Math.floor(k * step)]);
	return picked;
}

/** dBFS at or above which the measured level reads as `high`. */
export const AUDIO_ENERGY_HIGH_DBFS = -14;

/** dBFS at or above which the measured level reads as `medium` (below ⇒ `low`). */
export const AUDIO_ENERGY_MEDIUM_DBFS = -30;

/**
 * Band a per-chunk loudness curve into an {@link AudioEnergy}.
 *
 * `levels` is the curve `lib/auto-cut`'s `computeLoudness` already produces for
 * silence detection: one max-abs sample amplitude per analysis chunk, in [0, 1].
 * We take its RMS (so loud chunks weigh more than a long quiet tail, which is
 * what "energy" means here) and read it in dBFS against two thresholds.
 *
 * Returns `null` for an empty/unusable curve — absent, never a default.
 */
export function classifyAudioEnergy(
	levels: ArrayLike<number>,
): AudioEnergy | null {
	let sumSquares = 0;
	let counted = 0;
	for (let i = 0; i < levels.length; i++) {
		const v = levels[i];
		if (!Number.isFinite(v)) continue;
		const magnitude = Math.min(1, Math.abs(v));
		sumSquares += magnitude * magnitude;
		counted += 1;
	}
	if (counted === 0) return null;

	const rms = Math.sqrt(sumSquares / counted);
	if (rms <= 0) return "low"; // digital silence is a real measurement.
	const dbfs = 20 * Math.log10(rms);
	if (dbfs >= AUDIO_ENERGY_HIGH_DBFS) return "high";
	if (dbfs >= AUDIO_ENERGY_MEDIUM_DBFS) return "medium";
	return "low";
}

// ── model config (which brain runs the pass) ─────────────────────────────────

/**
 * The SINGLE source of truth for which model the understanding pass requests:
 * `NEXT_PUBLIC_UNDERSTANDING_MODEL`, trimmed; unset/blank ⇒ `undefined` ⇒
 * today's behavior (no `model` sent — the Director relay picks its default).
 *
 * Read PER CALL (not at module load) so bun tests can override `process.env`
 * without module-reload tricks; the literal member access keeps Next's
 * build-time inlining working in the client bundle (same convention as
 * `NEXT_PUBLIC_UNDERSTANDING_AUTORUN` in the service).
 */
export function configuredUnderstandingModel(): string | undefined {
	const raw = process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	return trimmed ? trimmed : undefined;
}

/** Is `model` one the NATIVE Gemini relay serves (vs. the Director's Anthropic-compatible relay)? */
export function isGeminiModel(model: string | undefined): boolean {
	return !!model && model.trim().toLowerCase().startsWith("gemini");
}

/**
 * Pick the {@link UnderstandAssetFn} that serves `modelName` (the RESOLVED tag
 * the record will be stored under — see the service's
 * `resolveUnderstandingModelName`): a `gemini-*` model runs on the native
 * {@link geminiUnderstandAsset} seam; everything else (including the default
 * `vlm-v1` pipeline tag) stays on {@link relayUnderstandAsset}.
 */
export function selectUnderstandAssetFn(modelName: string): UnderstandAssetFn {
	return isGeminiModel(modelName)
		? geminiUnderstandAsset
		: relayUnderstandAsset;
}

// ── production model calls (the network seams) ───────────────────────────────

/** The tool-less model call that turns an asset's frames into an understanding. */
export type UnderstandAssetFn = (
	frames: string[],
	ctx: {
		mediaId: string;
		personas: PersonaRef[];
		modelName: string;
		hint?: string;
	},
) => Promise<AssetUnderstanding>;

/** The browser-side endpoint of the stateless server relay (mirrors `agent.ts`). */
const AGENT_RELAY_URL = "/api/llm/agent";

/**
 * A relay HTTP failure that CARRIES the `Response`, so upstream policy can
 * inspect the status without this module knowing about it. The one consumer
 * today is the credit gate: `understandAssetBatch` routes a 402 through
 * `gateOn402` (which needs the un-consumed body — hence `response` is attached
 * unread; the error message reads from a clone). Everything else treats this
 * like any other transport error.
 */
export class UnderstandingRelayError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly response: Response,
	) {
		super(message);
		this.name = "UnderstandingRelayError";
	}
}

/** Is this error the paid relay saying "insufficient credits" (HTTP 402)? */
export function isCreditGateError(
	err: unknown,
): err is UnderstandingRelayError {
	return err instanceof UnderstandingRelayError && err.status === 402;
}

/** Pull the concatenated text out of an Anthropic assistant content array. */
function textOfContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is Anthropic.TextBlock =>
				!!b &&
				typeof b === "object" &&
				(b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("");
}

/**
 * Production {@link UnderstandAssetFn}: one tool-less, non-streaming relay call
 * that sends the sampled frames as image blocks and parses the reply into an
 * {@link AssetUnderstanding}. This is the default the ingest service uses; tests
 * inject a stub instead. Throws on a relay/transport error (the caller catches
 * and records it) — a PARSE failure, by contrast, fails safe to a degraded
 * understanding.
 */
export const relayUnderstandAsset: UnderstandAssetFn = async (frames, ctx) => {
	// A configured NON-Gemini model rides the request as an explicit override
	// (the relay resolves `body.model || DIRECTOR_MODEL || default`). Unset ⇒ no
	// `model` field at all — byte-identical to the pre-config behavior. Gemini
	// models never reach this seam ({@link selectUnderstandAssetFn} routes them
	// to {@link geminiUnderstandAsset}), so they are never sent here either.
	const configured = configuredUnderstandingModel();
	const model =
		configured && !isGeminiModel(configured) ? configured : undefined;
	const res = await fetch(AGENT_RELAY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...(model ? { model } : {}),
			messages: [
				{
					role: "user",
					content: buildUnderstandingUserBlocks(frames, {
						personas: ctx.personas,
						hint: ctx.hint,
					}),
				},
			],
			system: ASSET_UNDERSTANDING_SYSTEM_PROMPT,
			tools: [],
			stream: false,
		}),
	});
	if (!res.ok) {
		// Read the message from a CLONE so `res` itself stays un-consumed — the
		// credit gate downstream needs to `clone().json()` the original.
		const body = (await res
			.clone()
			.json()
			.catch(() => null)) as {
			error?: string;
			message?: string;
		} | null;
		throw new UnderstandingRelayError(
			`Asset understanding relay error (${res.status}): ${
				body?.message ?? body?.error ?? "unknown error"
			}`,
			res.status,
			res,
		);
	}
	const body = (await res.json()) as { content?: unknown };
	return parseAssetUnderstanding(textOfContent(body.content), {
		mediaId: ctx.mediaId,
		imageCount: frames.length,
		personas: ctx.personas,
		modelName: ctx.modelName,
	});
};

// ── native Gemini seam ───────────────────────────────────────────────────────

/**
 * The browser-side endpoint of the stateless NATIVE Gemini relay (a Gemini-shaped
 * passthrough: `{ model, contents, systemInstruction, generationConfig }` in,
 * a raw `generateContent` response out; server-side `GEMINI_API_KEY`; same
 * auth / rate-limit / 402 contracts as {@link AGENT_RELAY_URL}).
 */
const GEMINI_RELAY_URL = "/api/llm/gemini";

/** A Gemini `inlineData` content part (base64 media riding in the request). */
export interface GeminiInlineDataPart {
	inlineData: { mimeType: string; data: string };
}

/** A Gemini text content part. */
export interface GeminiTextPart {
	text: string;
}

/** One Gemini content part — the minimal local shape (no Gemini SDK dependency). */
export type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

/** Accepted image data-URL shape (mirrors the vision critic's `DATA_URL_RE`). */
const GEMINI_DATA_URL_RE =
	/^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

/**
 * Turn a sampled frame (a base64 `data:` URL) into a Gemini `inlineData` part,
 * or null when the URL isn't a decodable base64 image (the caller drops it —
 * same silent-drop behavior as {@link dataUrlToImageBlock} on the Anthropic
 * side). `image/jpg` is normalized to the canonical `image/jpeg`.
 */
export function dataUrlToInlineDataPart(
	dataUrl: string,
): GeminiInlineDataPart | null {
	const match = dataUrl.match(GEMINI_DATA_URL_RE);
	if (!match) return null;
	const mimeType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
	return { inlineData: { mimeType, data: match[2] } };
}

/**
 * Build the Gemini-native content parts for an understanding call: the SAME
 * intro text as {@link buildUnderstandingUserBlocks} (one shared helper, so the
 * dialects can never drift), then each sampled frame as an `inlineData` part in
 * index order (so `anchorIndex` lines up). Undecodable frames are silently
 * dropped.
 *
 * Deliberately a SEPARABLE step from the request framing in
 * {@link geminiUnderstandAsset}: phase 2 swaps these per-frame image parts for
 * native video input (Files API / `inlineData` video) without touching the
 * envelope around them.
 */
export function buildUnderstandingGeminiParts(
	frames: string[],
	opts?: { personas?: PersonaRef[]; hint?: string },
): GeminiPart[] {
	const parts: GeminiPart[] = [
		{ text: understandingIntroText(frames.length, opts) },
	];
	for (const frame of frames) {
		const part = dataUrlToInlineDataPart(frame);
		if (part) parts.push(part);
	}
	return parts;
}

/**
 * Gemini structured-output schema (`generationConfig.responseSchema`, OpenAPI
 * subset with Gemini's UPPERCASE `Type` enums) for the understanding reply —
 * derived from the exact shape {@link parseAssetUnderstanding} expects, so the
 * model is CONSTRAINED to parseable output instead of free-texting JSON.
 * `faces`/`style` stay optional (the prompt says to omit them when absent) and
 * {@link parseAssetUnderstanding} remains the validator/coercer on top — the
 * schema improves reliability, it does not replace the fail-safe parse.
 * `propertyOrdering` is a Gemini structured-output recommendation: a stable
 * key order measurably improves output quality/consistency, and it mirrors the
 * field order the system prompt documents.
 */
export const ASSET_UNDERSTANDING_RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		caption: { type: "STRING" },
		role: { type: "STRING", enum: [...ASSET_ROLES] },
		roleConfidence: { type: "NUMBER" },
		tags: { type: "ARRAY", items: { type: "STRING" } },
		faces: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: {
					persona: { type: "STRING" },
					descriptor: { type: "STRING" },
					recurring: { type: "BOOLEAN" },
					anchorIndex: { type: "INTEGER" },
					confidence: { type: "NUMBER" },
				},
				propertyOrdering: [
					"persona",
					"descriptor",
					"recurring",
					"anchorIndex",
					"confidence",
				],
			},
		},
		style: {
			type: "OBJECT",
			properties: {
				palette: { type: "STRING" },
				lensMood: { type: "STRING" },
				setting: { type: "STRING" },
			},
			propertyOrdering: ["palette", "lensMood", "setting"],
		},
		shotType: { type: "STRING", enum: [...SHOT_TYPES] },
		composition: {
			type: "OBJECT",
			properties: {
				subjectPosition: { type: "STRING" },
				headroom: { type: "STRING" },
				ruleOfThirds: { type: "BOOLEAN" },
			},
			propertyOrdering: ["subjectPosition", "headroom", "ruleOfThirds"],
		},
		emotion: { type: "STRING" },
		continuity: {
			type: "OBJECT",
			properties: {
				lighting: { type: "STRING" },
				whiteBalance: { type: "STRING" },
				wardrobe: { type: "STRING" },
				colorSignature: { type: "STRING" },
			},
			propertyOrdering: [
				"lighting",
				"whiteBalance",
				"wardrobe",
				"colorSignature",
			],
		},
	},
	// `shotType` is the one deepened facet in the required set: the frames always
	// establish a framing distance, so the model can answer it from what it was
	// actually shown, and it is the signal `isDeepUnderstanding` reads.
	// `motion` and `audio` are absent from this schema ENTIRELY, not merely
	// optional — a structured-output schema is an instruction, and listing a
	// field the model has no evidence for is how the fabrication started. Both
	// are measured outside this call ({@link estimateMotion}, {@link AudioProbe}).
	required: ["caption", "role", "roleConfidence", "tags", "shotType"],
	propertyOrdering: [
		"caption",
		"role",
		"roleConfidence",
		"tags",
		"faces",
		"style",
		"shotType",
		"composition",
		"emotion",
		"continuity",
	],
} as const;

/** Pull the concatenated text out of a raw Gemini `generateContent` response. */
function textOfGeminiCandidates(body: unknown): string {
	const candidates = (body as { candidates?: unknown } | null)?.candidates;
	if (!Array.isArray(candidates)) return "";
	const first = candidates[0] as { content?: { parts?: unknown } } | undefined;
	const parts = first?.content?.parts;
	if (!Array.isArray(parts)) return "";
	return parts
		.map((p) => {
			const text = (p as { text?: unknown } | null)?.text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

/**
 * NATIVE-Gemini {@link UnderstandAssetFn}: one non-streaming, Gemini-shaped
 * call against the stateless `/api/llm/gemini` relay — frames as `inlineData`
 * parts, the understanding prompt as `systemInstruction`, and native structured
 * output ({@link ASSET_UNDERSTANDING_RESPONSE_SCHEMA}). Selected by
 * {@link selectUnderstandAssetFn} when the configured model is `gemini-*`, so
 * `ctx.modelName` here IS the Gemini model id — it rides as `body.model` and
 * (via the parse context) lands verbatim in the stored record's `modelName`.
 *
 * Error contract mirrors {@link relayUnderstandAsset} exactly: a non-OK
 * response throws an {@link UnderstandingRelayError} carrying the un-consumed
 * `Response`, so the batch runner's 402 → `gateOn402` credit path fires
 * unchanged; a PARSE failure fails safe to a degraded understanding.
 */
export const geminiUnderstandAsset: UnderstandAssetFn = async (frames, ctx) => {
	const res = await fetch(GEMINI_RELAY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: ctx.modelName,
			contents: [
				{
					role: "user",
					parts: buildUnderstandingGeminiParts(frames, {
						personas: ctx.personas,
						hint: ctx.hint,
					}),
				},
			],
			systemInstruction: {
				parts: [{ text: ASSET_UNDERSTANDING_SYSTEM_PROMPT }],
			},
			generationConfig: {
				responseMimeType: "application/json",
				responseSchema: ASSET_UNDERSTANDING_RESPONSE_SCHEMA,
				// Perception/extraction, not planning: Gemini's docs recommend the
				// LOWER thinking levels for classification/fact-extraction — cuts
				// latency and cost on this high-volume bulk call with no quality
				// stake in deep reasoning.
				thinkingConfig: { thinkingLevel: "low" },
			},
		}),
	});
	if (!res.ok) {
		// Read the message from a CLONE so `res` itself stays un-consumed — the
		// credit gate downstream needs to `clone().json()` the original.
		const body = (await res
			.clone()
			.json()
			.catch(() => null)) as {
			error?: string;
			message?: string;
		} | null;
		throw new UnderstandingRelayError(
			`Asset understanding relay error (${res.status}): ${
				body?.message ?? body?.error ?? "unknown error"
			}`,
			res.status,
			res,
		);
	}
	const body = (await res.json()) as unknown;
	return parseAssetUnderstanding(textOfGeminiCandidates(body), {
		mediaId: ctx.mediaId,
		imageCount: frames.length,
		personas: ctx.personas,
		modelName: ctx.modelName,
	});
};

// ── local helpers ────────────────────────────────────────────────────────────

/** Clamp a number into [0, 1]. */
function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

/** Trim a loose value to a non-empty string, or `undefined`. */
function cleanStr(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t ? t : undefined;
}

/**
 * Extract the first balanced top-level JSON object from arbitrary text (tolerates
 * a ```json fence and surrounding prose). Mirrors the scanners in
 * `vision-critic.ts` / `reference-intake.ts`.
 */
function firstJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const haystack = fenced ? fenced[1] : text;
	const start = haystack.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < haystack.length; i++) {
		const ch = haystack[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return haystack.slice(start, i + 1);
		}
	}
	return null;
}
