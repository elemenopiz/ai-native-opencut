/**
 * Palette — a small neutral, readable default color set: `foreground`,
 * `background`, `accent`, plus two scrim treatments.
 *
 * A "scrim" is the translucent wash placed behind text so it stays legible
 * over ARBITRARY footage — the thing that makes a safe-margin/type-scale
 * system actually readable once it's composited over real video instead of a
 * flat background. Two scrims are provided because the two directions aren't
 * symmetric in how this codebase will use them: `scrimDark` (a dark wash
 * behind light foreground text) is the overwhelmingly common case — most
 * footage is bright/busy enough that light text needs darkening behind it —
 * while `scrimLight` (a light wash behind dark text) exists for the rarer
 * inverse, kept here for completeness rather than left for a caller to invent
 * ad hoc.
 *
 * ARBITRARY, FLAGGED FOR REVIEW: `foreground`/`background` are safe,
 * near-universal choices (nearly-white on nearly-black — "nearly" so neither
 * clips to pure 0/255 on broadcast-legal footage). `accent` is a genuine
 * editorial pick with no strong grounding — a human with an actual brand
 * color should swap it. Scrim opacities (0.55 / 0.65) are tuned by common
 * caption-design practice (dark scrims can run lighter than light scrims
 * because dark-on-light contrast reads faster) but not measured against real
 * footage.
 */

export interface ScrimStyle {
	/** CSS color (hex). */
	color: string;
	/** 0–1 opacity. */
	opacity: number;
}

export interface Palette {
	/** Default text/graphic color. */
	foreground: string;
	/** Default background fill (title cards, letterboxing, etc). */
	background: string;
	/** Default accent (underlines, active-state chips, a bug's ring) — the one genuinely arbitrary pick, see file header. */
	accent: string;
	/** Dark scrim for light foreground text over bright/busy footage — the common case. */
	scrimDark: ScrimStyle;
	/** Light scrim for dark foreground text over dark footage — the rarer inverse. */
	scrimLight: ScrimStyle;
}

export const DEFAULT_PALETTE: Palette = {
	foreground: "#F5F5F5",
	background: "#0A0A0A",
	accent: "#38BDF8",
	scrimDark: { color: "#000000", opacity: 0.55 },
	scrimLight: { color: "#FFFFFF", opacity: 0.65 },
};
