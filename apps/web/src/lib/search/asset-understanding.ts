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
 *    faces reconciled to personas, and an optional style probe.
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
	/** VLM model name that produced this understanding (for invalidation on upgrade). */
	modelName: string;
	/** When the understanding was produced (epoch ms). */
	createdAt: number;
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

/** System prompt for the tool-less asset-understanding model call. */
export const ASSET_UNDERSTANDING_SYSTEM_PROMPT = [
	"You are the ingest EYE of an AI video editor. You are shown 1–8 frames sampled IN TIME ORDER from ONE media asset a user just imported (a video clip or a still). You may also be given a KNOWN CAST list (personas already in the project) and an optional HINT.",
	"Your job is to describe what the asset IS, as a compact structured record, so the editor can file it by role and by who is in it. Describe ONLY what is actually visible across the frames; never invent a subject, a person, a role, or a look the frames don't show.",
	"Reply with ONE minified JSON object and nothing else:",
	'{"caption":"<one sentence>","role":"hero"|"product"|"logo"|"face-anchor"|"b-roll"|"screen-rec","roleConfidence":<0-1>,"tags":["<open-vocab object/person/scene tags>"],"faces":[{"persona":"<exact KNOWN CAST name, or empty if not a known person>","descriptor":"<age range, build, hair, face, wardrobe, distinguishing features>","recurring":<true if this person appears across multiple frames>,"anchorIndex":<0-based frame index where this face is clearest>,"confidence":<0-1>}],"style":{"palette":"<color grade>","lensMood":"<lens/DoF/film stock/mood>","setting":"<environment, time of day, lighting>"}}',
	"Rules:",
	"- role: pick the SINGLE best fit. hero = the featured subject/money shot; product = a product beauty/detail shot; logo = a brand mark/wordmark/bug; face-anchor = a person's face clear and front-on enough to anchor identity; b-roll = generic supporting/background footage; screen-rec = a screen recording / screencast / UI capture. roleConfidence reflects how sure you are.",
	"- tags: 6–18 concise OPEN-vocabulary tags for the salient objects, people, actions, and scene — across ALL the frames, not just the first. Prefer concrete nouns. Do not pad with near-duplicates.",
	"- faces: include an entry ONLY for a clearly visible human face. If the person matches a KNOWN CAST member, set persona to that EXACT name; otherwise leave persona empty and give a good descriptor. Omit the faces array entirely when no human face is present. Never guess a cast name you were not given.",
	"- style: fill the fields the frames actually establish; omit a field (or the whole style object) when the frames say nothing about it. Keep each a compact phrase.",
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

	return {
		mediaId: ctx.mediaId,
		caption,
		role,
		roleConfidence,
		tags,
		faces,
		...(styleProbe ? { styleProbe } : {}),
		modelName: ctx.modelName,
		createdAt: ctx.now ?? Date.now(),
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
			},
		},
		style: {
			type: "OBJECT",
			properties: {
				palette: { type: "STRING" },
				lensMood: { type: "STRING" },
				setting: { type: "STRING" },
			},
		},
	},
	required: ["caption", "role", "roleConfidence", "tags"],
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
