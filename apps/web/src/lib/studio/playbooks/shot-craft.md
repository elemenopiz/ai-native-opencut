---
name: shot-craft
description: Camera and motion prompt craft for AI-generated video, plus the STYLE-token lock that keeps an independently-generated multi-shot reel looking like one film instead of a slideshow of unrelated clips. Covers concrete camera/lens/lighting language, motion verbs, the "describe what changes, not what's already there" rule for image-to-video and image-to-image, the structured SCENE/MOTION/AUDIO/NEGATIVE shot block, and positive-phrasing rewrites for models with no negative-prompt field. Use whenever generating a video shot, planning or writing prompts for a multi-shot reel/sequence, or animating an existing still/frame into motion — even if the user doesn't ask for it by name. Complements `ugc-video-prompts` (the still-then-animate UGC pipeline specifically); this is the general-purpose camera/motion/consistency craft underneath any multi-shot generation, UGC or not.
---

# Shot Craft: Camera, Motion & Style-Lock

## Core principle

Each shot in a reel is its own independent generation call — the model has no memory of the shot before or after it. Two things make a sequence of independent calls read as one directed piece instead of a grab-bag of clips: **concrete, physical prompt language** (a named lens/angle/light source beats "cinematic" every time), and **one exact wording repeated on purpose** everywhere the sequence needs to hold together — the style descriptor, the character description, the location. Byorn already has the mechanism for the second half of that (`ConsistencyContext` / `StyleBible` — see below); this playbook is about what to put in it and how to word each shot around it.

## Camera & lighting vocabulary

Vague direction produces vague footage. Every shot prompt should name, concretely:

- **Lens** — a focal length or its effect: 35mm for an intimate wide, 85mm for a compressed portrait, wide-angle for environmental scale.
- **Angle** — low, overhead, eye-level, slightly-above — not just "good angle."
- **Motion** — the specific camera move, not "nice camera work": dolly in, tracking shot, slow push, sweeping pan, crane up, handheld drift. Byorn's camera-preset fragments (`lib/studio/camera-presets.ts`) are exactly this vocabulary already wired to real generation — reuse their phrasing (`"slow dolly-in, camera pushes steadily toward the subject"`, `"tracking shot following the subject from behind"`) rather than inventing looser paraphrases.
- **Lighting** — name the actual source and what it visibly does: rim light, golden-hour side light, moody backlight, neon glow, harsh overhead fluorescent. "Good lighting" gives the model nothing to target; "warm rim light separating the subject from a dark background" does.

Subject, setting, and style still come first in the sentence — camera and lighting are what you layer on top, not a replacement for concrete subject detail.

## Motion verbs (video)

A still-image prompt describes what's *there*. A video/motion prompt has to describe what *moves*, and how:

- **Camera motion verbs** — zooms in, dollies left, sweeps across, pushes in slowly, whips fast, cranes up, tracks alongside.
- **Subject motion** — name the actual movement: "the dancer spins," "smoke rises slowly," "her hand reaches for the cup." Generic "moves naturally" gives the model nothing to lock onto; a specific verb does.
- Prefer one clear action per shot over several stacked actions — a shot trying to do three things at once is where motion starts looking chaotic instead of directed.

## Don't redescribe the anchor frame

When a shot anchors an existing image or frame — image-to-video, an `end_image`/`start_image` continuation, or an image-to-image edit — the model already has those pixels. Redescribing the subject/setting that's already in the reference only invites the model to reconcile two descriptions of the same thing, which is where drift and inconsistency creep in.

- **Image-to-video**: the anchor frame is frame one. The prompt describes motion, not the frame — camera behavior and subject motion only.
- **Image-to-image**: the prompt describes what *changes* about the input, not the input itself.

Bad: *"a man with brown hair in a leather jacket holding coffee, made into anime."* Good: *"transform into anime style, vibrant colors, soft cel shading."* The reference image already carries the man, the jacket, and the coffee — the prompt's only job is to say what's different.

## STYLE-token consistency for multi-shot reels

This is the part that matters most for Byorn specifically: the Director generates a reel as a sequence of independent shot calls, and the single biggest failure mode is visual drift — shot 3 doesn't look like it belongs to the same film as shot 1.

The fix is mechanical, not aesthetic: write **one exact STYLE descriptor phrase** — palette, lens/render character, finish, mood — and paste that **identical string, verbatim, unparaphrased**, into every shot's prompt in the sequence. Not "warm and cinematic" in shot one and "warm cinematic tones" in shot four — the *same characters*, every time. A model treats a reworded synonym as a different instruction; it only holds a look constant across independent calls when it sees the literal same words.

This maps directly onto what Byorn already has, rather than being a new thing to bolt on:

- `StyleBible.palette` + `StyleBible.lensMood` are exactly this STYLE token, held at the plan level for the whole reel.
- `ConsistencyContext.style`, surfaced through the Director's `getConsistencyContext`/`setConsistencyContext` verbs, is what gets folded into every independent shot generation call — the wiring that pastes the token into every shot is already built.
- What's missing is craft, not plumbing: write that one `palette`/`lensMood` string as a precise, reusable phrase up front (e.g. *"muted teal-and-amber grade, anamorphic flares, shallow depth of field, 16mm grain"*), not a vague mood word, and never let a later shot's prompt quietly reword it.

If the reel also needs to look explicitly non-photorealistic or in a specific illustrated register (animation, stylized explainer footage, motion graphics), end the STYLE token with an unambiguous register statement — e.g. *"non-photorealistic, illustrated, not a photo, no live-action, no realism"* — so the model doesn't default back to photoreal on shots where the reference context is thin.

## The structured shot block

For anything beyond a one-line prompt — any shot with camera direction, sound, and things to avoid, all needing to be tracked separately — write it as a labeled block instead of one run-on sentence. It's easier to keep consistent across a sequence and easier to audit shot-by-shot:

```
SCENE: {the subject and the one clear action in this shot}.
MOTION: {camera move + subject motion — what moves, and how}.
AUDIO: {ambient sound/music only, if the model takes it — never dialogue instructions here}.
NEGATIVE: {only for models with a real negative-prompt field — see positive phrasing below otherwise}.
```

Keep SCENE and MOTION separate even when they'll end up concatenated into one prompt string for the model — separating "what's in frame" from "what moves" is what keeps a shot from quietly drifting into redescribing the anchor frame (see above) instead of directing motion.

## Positive phrasing (no negative-prompt field)

Most generation models Byorn talks to don't expose a separate negative-prompt parameter — the whole prompt is one string. Telling a model what *not* to do inside that string is unreliable; state the desired positive result instead:

| Instead of | Write |
|---|---|
| no blur | tack sharp |
| no people | uninhabited landscape |
| not blurry | crisp focus throughout |
| no smooth camera move | handheld micro-shake |
| no text or watermark | clean unmarked frame |

Reserve an explicit `NEGATIVE:` line (in the structured block above) for the rarer model that actually accepts a real negative-prompt field — check the model's capability entry before assuming it does.

## Keep it dense, not padded

Concrete, specific prompts hold up better than long ones. Aim for roughly 150–200 tokens of real content — enough for subject, camera, lighting, and motion, each stated once and precisely — rather than stretching to fill whatever ceiling the surface allows. Padding past that with restated or redundant description is where prompts start to distort the output rather than sharpen it.

## Worked example

A 3-shot product reel, STYLE token held constant:

STYLE token: `"muted teal-and-amber grade, anamorphic flares, shallow depth of field, subtle 16mm grain"`

```
Shot 1
SCENE: A hand lifts the product off a marble counter into soft daylight, muted teal-and-amber grade, anamorphic flares, shallow depth of field, subtle 16mm grain.
MOTION: Slow dolly-in as the hand rises, camera holds low, tracking the product upward.
AUDIO: Quiet room tone, a single soft clink of glass on marble.
NEGATIVE: no on-screen text, no watermark, no smooth gimbal move.

Shot 2
SCENE: The product rotates in frame against a dark uninhabited backdrop, muted teal-and-amber grade, anamorphic flares, shallow depth of field, subtle 16mm grain.
MOTION: Camera orbits slowly around the product, tack sharp throughout.
AUDIO: Low ambient hum, no music yet.
NEGATIVE: no clutter, no visible hands.

Shot 3
SCENE: The product sits centered on the counter as morning light widens across the frame, muted teal-and-amber grade, anamorphic flares, shallow depth of field, subtle 16mm grain.
MOTION: Slow pull-back revealing the full counter, handheld micro-shake.
AUDIO: Soft swell of ambient music, no dialogue.
NEGATIVE: no text overlay, no logo bug.
```

Notice the STYLE token is the exact same four-clause string in all three SCENE lines — that repetition, not a shared subject or setting, is what makes these three independent generation calls read as one continuous piece.

## Guardrails

- This is prompt-writing craft, not a source of new facts — never invent footage, cast, or product details the project's brief/assets/persona context doesn't already establish. If the reel needs a detail the context doesn't have, ask rather than fabricate.
- Positive-phrasing rewrites are about *how* to state a constraint, not license to soften or drop one — "tack sharp" still means the same restriction as "no blur," just phrased so the model can act on it.
