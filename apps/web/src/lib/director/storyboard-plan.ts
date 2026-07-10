/**
 * Storyboard planning artifact — turns the Director's `storyboard` verb from a
 * "make N empty slots" call into a real PLAN the agent authors once and every
 * later turn reads back.
 *
 * Motivation: the frontier brain tends to jump straight to per-shot generation,
 * prompting each shot independently, so a multi-shot brief ("a 3-shot ad for a
 * coffee brand") drifts — shot 2's lens/palette/cast don't match shot 1's. The
 * fix mirrors what `consistency-prompt.ts` already does for the per-shot PROMPT
 * (one reusable STYLE/CHARACTERS/SETTING block folded into every provider call):
 * here we capture, ONCE, the decomposition of the brief into shots with explicit
 * creative intent PLUS a shared "style bible" (palette, lens/mood, cast,
 * setting). That bible is the single source the planner then feeds into
 * `setConsistencyContext`, so plan authorship and prompt-time consistency come
 * from the same place instead of the agent restating style per shot.
 *
 * This is deliberately SESSION state, not persisted to disk — same lifetime and
 * WeakMap-keyed-by-editor scheme as the consistency context, so it's naturally
 * GC'd with the editor and surfaced on `ReelSnapshot.plan` for read-back.
 */

import type { EditorCore } from "@/core";
import type {
	BuildConsistencyContextInput,
	ConsistencyCharacter,
} from "./consistency-prompt";

/**
 * One shot's creative intent within a {@link StoryboardPlan}. The `prompt` is
 * what actually reaches the provider; the other notes are the DIRECTOR'S intent
 * that keeps the sequence coherent — read back on later turns so a "regenerate
 * shot 2" request still honours the original framing/subject.
 */
export interface PlannedShot {
	/** 1-based position in the sequence (stable even if a slot is later removed). */
	index: number;
	/** The generation prompt for this shot (what gets rendered). */
	prompt: string;
	/** What this shot accomplishes narratively (e.g. "establish the setting, cold open"). */
	intent?: string;
	/** Framing / camera movement / lens notes (e.g. "slow push-in, 35mm, eye-level"). */
	camera?: string;
	/** Who / what is on screen and what they're doing (e.g. "Mara, mid-shot, pouring coffee"). */
	subject?: string;
	/** Shot length in seconds. */
	duration: number;
	/** The slot id this shot was materialized into, once `storyboard` runs. */
	slotId?: string;
}

/**
 * The reusable creative "bible" derived once for the whole reel and shared
 * across every shot. This is the plan-level twin of {@link ConsistencyContext}:
 * `palette`+`lensMood` become its STYLE, `characters` its CHARACTERS, `setting`
 * its SETTING (see {@link bibleToConsistencyInput}).
 */
export interface StyleBible {
	/** Color grade / palette (e.g. "warm amber highlights, teal shadows"). */
	palette?: string;
	/** Lens + mood (e.g. "anamorphic, shallow depth of field, dreamy"). */
	lensMood?: string;
	/** Secondary/background cast with no persona of their own — described in text. */
	characters?: ConsistencyCharacter[];
	/** Primary location(s): environment, architecture, time of day, lighting. */
	setting?: string;
}

/**
 * A persisted multi-shot plan: the storyboard artifact later turns read back off
 * {@link import("./types").ReelSnapshot}. Authored once by the planner, before
 * any shot is generated.
 */
export interface StoryboardPlan {
	/** Number of shots in the plan (== `shots.length`, surfaced for the agent). */
	shotCount: number;
	/** Ordered shots with per-shot creative intent. */
	shots: PlannedShot[];
	/** The shared style bible every shot inherits. */
	bible: StyleBible;
	/** Total planned runtime in seconds (sum of shot durations). */
	totalDuration: number;
	/** Wall-clock creation time (ms epoch), so a stale plan is recognizable. */
	createdAt: number;
}

/** A single shot as the planner supplies it, before slot ids are known. */
export interface PlannedShotInput {
	prompt: string;
	duration?: number;
	intent?: string;
	camera?: string;
	subject?: string;
}

const DEFAULT_SHOT_DURATION = 6;

/**
 * Assemble a {@link StoryboardPlan} from the planner's shot list and style
 * bible. Pure and side-effect free — `storyboard` persists the result with
 * {@link storePlan} after materializing slots (patching each shot's `slotId`).
 */
export function buildStoryboardPlan(input: {
	shots: PlannedShotInput[];
	bible?: StyleBible;
}): StoryboardPlan {
	const shots: PlannedShot[] = input.shots.map((s, i) => {
		const duration =
			s.duration && s.duration > 0 ? s.duration : DEFAULT_SHOT_DURATION;
		return {
			index: i + 1,
			prompt: s.prompt,
			duration,
			...(s.intent ? { intent: s.intent } : {}),
			...(s.camera ? { camera: s.camera } : {}),
			...(s.subject ? { subject: s.subject } : {}),
		};
	});
	return {
		shotCount: shots.length,
		shots,
		bible: input.bible ?? {},
		totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
		createdAt: Date.now(),
	};
}

/**
 * Project a {@link StyleBible} onto the {@link BuildConsistencyContextInput} the
 * existing consistency machinery consumes. `palette` and `lensMood` are joined
 * into the one free-text STYLE paragraph; `characters`/`setting` pass straight
 * through. Returns `undefined` when the bible carries nothing worth pinning, so
 * the caller can skip seeding entirely (and leave any prior context untouched).
 */
export function bibleToConsistencyInput(
	bible: StyleBible | undefined,
): BuildConsistencyContextInput | undefined {
	if (!bible) return undefined;
	const styleParts = [bible.palette, bible.lensMood]
		.map((p) => p?.trim())
		.filter((p): p is string => Boolean(p));
	const style = styleParts.join("; ");
	const setting = bible.setting?.trim();
	const characters = bible.characters ?? [];
	if (!style && !setting && characters.length === 0) return undefined;
	return {
		...(style ? { style } : {}),
		...(setting ? { setting } : {}),
		...(characters.length ? { extraCharacters: characters } : {}),
	};
}

// ── Editor-keyed registry ────────────────────────────────────────────────────
//
// One reel has one active storyboard plan, held for the lifetime of the editor
// instance (session state, not persisted) — the same scheme as
// `consistency-prompt.ts`'s context registry, so the two artifacts live and die
// together. Keyed by `EditorCore` reference via a `WeakMap` so it's GC'd with
// the editor and never threads through the API factory's call signature.

const planByEditor = new WeakMap<EditorCore, StoryboardPlan>();

/** Read the storyboard plan authored for this editor, if any. */
export function getStoredPlan(editor: EditorCore): StoryboardPlan | undefined {
	return planByEditor.get(editor);
}

/** Set (or clear, passing `undefined`) the storyboard plan for this editor. */
export function storePlan(
	editor: EditorCore,
	plan: StoryboardPlan | undefined,
): void {
	if (plan) planByEditor.set(editor, plan);
	else planByEditor.delete(editor);
}
