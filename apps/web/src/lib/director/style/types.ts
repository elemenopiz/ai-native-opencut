/**
 * Shared contract for `lib/director/style/` — the Director's layout/typography
 * DEFAULTS module.
 *
 * Motivation (see the two measured gaps that created this module): there is no
 * safe-margin/title-safe concept anywhere in the codebase (`grep -rn
 * "safeMargin|titleSafe|safeArea"` was empty before this directory), so text
 * and graphics can land anywhere a phone UI or a platform's chrome will cover
 * them. `storyboard-plan.ts`'s `StyleBible` is a different concern entirely —
 * it seeds GENERATION prompts (palette/lens-mood as free text for an image/
 * video model); nothing here overlaps it, because this module is LAYOUT and
 * TYPOGRAPHY, resolved to concrete geometry/pixel values, never prompt text.
 *
 * DESIGN PRINCIPLE (binding on every file in this directory): everything here
 * is a DEFAULT the model reads and may override, never a constraint enforced
 * at a boundary. The Director redesign this module belongs to exists to
 * remove invented ceilings — a "safe area" that clamps or rejects an
 * out-of-bounds placement would be exactly the ceiling being torn out. So:
 *   - every export is plain data or a PURE function computing plain data from
 *     inputs (canvas size, orientation, a fraction) — no validation that
 *     throws/clamps a caller's own numbers, no mutation, no I/O.
 *   - nothing here imports timeline types or constructs a timeline element —
 *     turning a `LayoutGeometry` into an actual text/graphic element is a
 *     later phase's job, kept out of this module on purpose so it stays
 *     trivially testable and framework-free.
 *
 * `Orientation`'s three values deliberately match `asset-manifest.ts`'s
 * `AssetOrientation` vocabulary (read there for the canonical definition) but
 * are OWN-COPIED rather than imported — same "own copy, not import" discipline
 * `craft/types.ts` uses for `CraftOp` mirroring `edit-critic.ts`'s
 * `ProposedFix`: this keeps the style module decoupled from the asset-manifest
 * module's own evolution (and from needing to touch a file another workstream
 * owns) while still speaking the same three-way vocabulary.
 */

/** Coarse canvas shape — mirrors `AssetOrientation`'s vocabulary (`asset-manifest.ts`), own copy per this directory's decoupling discipline (see file header). */
export type Orientation = "landscape" | "portrait" | "square";

/** A canvas/frame size in pixels — the only "real" unit anything in this module resolves down to. */
export interface Canvas {
	width: number;
	height: number;
}

/** A resolved rectangle in pixel space: top-left `x`/`y` plus `width`/`height`. */
export interface PixelBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
