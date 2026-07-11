/**
 * Library Insights — pure derivations over {@link AssetUnderstanding} records
 * for the Insights panel view (`panels/assets/views/insights.tsx`).
 *
 * The Understanding Pass writes rich per-asset records (caption / role belief /
 * tags / faces / style probe) that, until this view, nothing ever showed the
 * user. This module turns those records into the *aggregate* story the panel
 * tells — with zero new model calls:
 *
 *  - {@link describeConfidence} — role confidence in plain language ("fairly
 *    sure", "just a guess"), never a raw percentage. Confidence 0 is "no read"
 *    (the degraded fail-safe record), NOT "0% sure it's b-roll".
 *  - {@link extractSwatches} / {@link libraryPalette} — mine the style probe's
 *    free-text look descriptions ("soft neutral with pink accent") for color
 *    words and render them as real swatches: the library's palette, derived
 *    from language.
 *  - {@link topLookWords} — the dominant camera/setting vocabulary across the
 *    library ("shallow DoF", "overhead", "daylight").
 *  - {@link detectStyleOutliers} — flag an asset whose *style class* (anime,
 *    CGI, black & white, …) is unique in an otherwise consistent library.
 *  - {@link roleCounts} / {@link needsReview} / {@link hasNewFace} — the
 *    at-a-glance triage numbers, always read through {@link effectiveRole}.
 *
 * PURE LOGIC: no React, no DOM, no IndexedDB — everything here is
 * unit-testable (see `library-insights.test.ts`).
 */

import {
	ASSET_ROLES,
	type AssetRole,
	type AssetUnderstanding,
	effectiveRole,
} from "./asset-understanding";

// ── confidence, in plain language ────────────────────────────────────────────

/** How sure the AI's role belief reads to a human. `tone` drives styling only. */
export interface ConfidencePhrase {
	label: string;
	tone: "certain" | "confident" | "unsure" | "none";
}

/**
 * The inferred role confidence as a short plain-language phrase. Deliberately
 * never a percentage — the brief's goal is "this is helpful", not "the AI is
 * second-guessing itself". Confidence 0 is the degraded fail-safe ("no read"),
 * not a 0% belief in b-roll.
 */
export function describeConfidence(roleConfidence: number): ConfidencePhrase {
	if (roleConfidence <= 0) return { label: "no read", tone: "none" };
	if (roleConfidence < 0.5) return { label: "just a guess", tone: "unsure" };
	if (roleConfidence < 0.75) return { label: "fairly sure", tone: "unsure" };
	if (roleConfidence < 0.9) return { label: "confident", tone: "confident" };
	return { label: "certain", tone: "certain" };
}

/**
 * Should this record be surfaced as "check the AI's guess"? True for weak or
 * absent beliefs the user hasn't already corrected — a `roleConfirmed`
 * override means a human has spoken and there is nothing left to review.
 */
export function needsReview(u: AssetUnderstanding): boolean {
	return u.roleConfirmed === undefined && u.roleConfidence < 0.6;
}

/** True when the pass flagged a recurring face with no persona-roster match. */
export function hasNewFace(u: AssetUnderstanding): boolean {
	return u.faces.some((f) => f.isNew);
}

// ── the palette, mined from language ─────────────────────────────────────────

/** One color word found in a look description, resolved to a displayable hex. */
export interface Swatch {
	/** The color word as it appeared (lowercased). */
	word: string;
	hex: string;
}

/**
 * Color vocabulary → displayable hex. Keys are matched as whole words against
 * the style probe's free text; values are picked to read as that color on both
 * light and dark UI, not to be colorimetrically exact — the model wrote
 * "pink", not a hex.
 */
const COLOR_WORDS: Record<string, string> = {
	pink: "#ec4899",
	rose: "#f43f5e",
	red: "#ef4444",
	crimson: "#dc2626",
	orange: "#f97316",
	amber: "#f59e0b",
	golden: "#eab308",
	gold: "#eab308",
	yellow: "#facc15",
	cream: "#f1e8d0",
	beige: "#e0d5b8",
	tan: "#d2b48c",
	brown: "#92400e",
	browns: "#92400e",
	chocolate: "#7b3f00",
	green: "#22c55e",
	olive: "#808000",
	teal: "#14b8a6",
	cyan: "#06b6d4",
	blue: "#3b82f6",
	navy: "#1e3a8a",
	indigo: "#6366f1",
	violet: "#8b5cf6",
	purple: "#a855f7",
	lavender: "#c4b5fd",
	magenta: "#d946ef",
	white: "#f8fafc",
	black: "#1c1917",
	gray: "#9ca3af",
	grey: "#9ca3af",
	silver: "#c0c0c0",
	charcoal: "#44403c",
	neutral: "#d6d3d1",
	pastel: "#fbcfe8",
	pastels: "#fbcfe8",
	neon: "#39ff14",
	turquoise: "#40e0d0",
	coral: "#ff7f50",
	peach: "#ffcba4",
	mint: "#98fb98",
};

/**
 * Find every color word in a look description and resolve it to a swatch, in
 * text order, deduped. `"warm golden browns on cream white"` →
 * golden · browns · cream · white.
 */
export function extractSwatches(text: string | undefined): Swatch[] {
	if (!text) return [];
	const seen = new Set<string>();
	const out: Swatch[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
		const hex = COLOR_WORDS[raw];
		if (!hex || seen.has(raw)) continue;
		seen.add(raw);
		out.push({ word: raw, hex });
	}
	return out;
}

/** The full style-probe text of a record, joined for word mining. */
function probeText(u: AssetUnderstanding): string {
	const p = u.styleProbe;
	if (!p) return "";
	return [p.palette, p.lensMood, p.setting].filter(Boolean).join(" · ");
}

/** Per-asset swatches: color words mined from the whole style probe. */
export function assetSwatches(u: AssetUnderstanding): Swatch[] {
	return extractSwatches(probeText(u));
}

/** A swatch weighted by how many assets its color word appears in. */
export interface WeightedSwatch extends Swatch {
	count: number;
}

/**
 * The library's dominant palette: every color word across every style probe,
 * counted once per asset, most common first. This is the "derive a palette
 * from language" trick that gives the paid pass a visible, delightful payoff.
 */
export function libraryPalette(
	records: AssetUnderstanding[],
	max = 6,
): WeightedSwatch[] {
	const counts = new Map<string, WeightedSwatch>();
	for (const u of records) {
		for (const s of assetSwatches(u)) {
			const existing = counts.get(s.word);
			if (existing) existing.count += 1;
			else counts.set(s.word, { ...s, count: 1 });
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, max);
}

// ── dominant look vocabulary ─────────────────────────────────────────────────

/** Words too generic to say anything about a look. */
const LOOK_STOPWORDS = new Set([
	"the",
	"and",
	"with",
	"over",
	"onto",
	"into",
	"against",
	"style",
	"very",
	"slightly",
	"tones",
	"tone",
	"accents",
	"accent",
	"lighting",
	"light",
]);

/** A recurring look word and how many assets it appears in. */
export interface LookWord {
	/** Original casing of the first occurrence (so "DoF" stays "DoF"). */
	word: string;
	count: number;
}

/**
 * The most recurring meaningful words in one style-probe field across the
 * library — e.g. `lensMood` yields "overhead · shallow · DoF"; `setting`
 * yields "indoor · daylight". Only words seen in 2+ assets qualify: a word
 * one clip used is an anecdote, not a look.
 */
export function topLookWords(
	records: AssetUnderstanding[],
	field: "lensMood" | "setting",
	max = 3,
): LookWord[] {
	const counts = new Map<string, { word: string; count: number }>();
	for (const u of records) {
		const text = u.styleProbe?.[field];
		if (!text) continue;
		const seenHere = new Set<string>();
		for (const raw of text.split(/[^a-zA-Z]+/)) {
			if (raw.length < 3) continue;
			const key = raw.toLowerCase();
			if (LOOK_STOPWORDS.has(key) || COLOR_WORDS[key] || seenHere.has(key))
				continue;
			seenHere.add(key);
			const existing = counts.get(key);
			if (existing) existing.count += 1;
			else counts.set(key, { word: raw, count: 1 });
		}
	}
	return [...counts.values()]
		.filter((w) => w.count >= 2)
		.sort((a, b) => b.count - a.count)
		.slice(0, max);
}

// ── stylistic outliers ───────────────────────────────────────────────────────

/**
 * Style *classes* — medium-level looks (as opposed to palettes) that make an
 * asset stick out of a photographic library. Matched against tags + the style
 * probe. Real data motivated this: an "anime style" frame turned up in an
 * otherwise photographic pastry shoot.
 */
const STYLE_CLASSES: ReadonlyArray<{ label: string; re: RegExp }> = [
	{
		label: "anime / illustrated",
		re: /\b(anime|manga|cartoon|illustrat\w*|hand.?drawn|sketch|comic)\b/i,
	},
	{
		label: "3D render / CGI",
		re: /\b(3d.?render\w*|cgi|claymation|low.?poly)\b/i,
	},
	{ label: "pixel art", re: /\bpixel.?art\b/i },
	{
		label: "black & white",
		re: /\b(black.and.white|monochrome|b&w|grayscale|greyscale)\b/i,
	},
	{
		label: "vintage film",
		re: /\b(vintage|retro|film.grain|super.?8|vhs)\b/i,
	},
	{ label: "neon / synthwave", re: /\b(synthwave|vaporwave|cyberpunk)\b/i },
];

/** The style classes an asset's tags + style probe claim. */
export function styleClassesOf(u: AssetUnderstanding): string[] {
	const text = `${u.tags.join(" ")} ${probeText(u)}`;
	return STYLE_CLASSES.filter((c) => c.re.test(text)).map((c) => c.label);
}

/**
 * Flag stylistic outliers: assets carrying a style class that NO other asset
 * in the library shares, when the library is big enough (4+ understood
 * records) for "everyone else" to mean something. Returns mediaId → the
 * outlying class label. Deliberately conservative — a rare class shared by
 * two assets is a sub-style, not an outlier.
 */
export function detectStyleOutliers(
	records: AssetUnderstanding[],
): Map<string, string> {
	const out = new Map<string, string>();
	if (records.length < 4) return out;
	const carriers = new Map<string, string[]>(); // class label → mediaIds
	for (const u of records) {
		for (const label of styleClassesOf(u)) {
			const list = carriers.get(label);
			if (list) list.push(u.mediaId);
			else carriers.set(label, [u.mediaId]);
		}
	}
	for (const [label, mediaIds] of carriers) {
		if (mediaIds.length === 1) out.set(mediaIds[0], label);
	}
	return out;
}

// ── role aggregation ─────────────────────────────────────────────────────────

/**
 * How many assets play each role, read through {@link effectiveRole} so a
 * human confirmation counts as what the user said, not what the AI guessed.
 * Every role is present (0 when unused) so the UI can render a stable shelf.
 */
export function roleCounts(
	records: AssetUnderstanding[],
): Record<AssetRole, number> {
	const out = Object.fromEntries(ASSET_ROLES.map((r) => [r, 0])) as Record<
		AssetRole,
		number
	>;
	for (const u of records) out[effectiveRole(u)] += 1;
	return out;
}
