---
name: ugc-video-prompts
description: Generate ultra-realistic UGC/influencer-style video clips inside Palmier Pro — talking selfies, product demos, candid lifestyle motion — using the proven still-then-animate pipeline instead of cold text-to-video. Drives Palmier Pro's generate_video, get_timeline, and get_media tools directly, with model selection grounded in this project's actual capabilities (dialogue/audio support, reference limits, resolution). Use whenever the user wants UGC-style video, influencer clips, talking-to-camera ad creative, "make a video of [a person/product]," or animating a still into motion — even if they don't say "UGC" explicitly. Pairs with the ugc-photo-prompts skill, which should run first to produce the anchor still.
---

# UGC-Style Video Prompts

## Core principle

Video models are decent at motion but worse than image models at solving "doesn't look AI" from zero — skin, lighting, and identity drift across many frames in ways a single still doesn't. Don't text-to-video a UGC clip from scratch. **Generate the anchor still first** (with the `ugc-photo-prompts` skill, or reuse one already in the media library), **then animate it.** The still already solved realism; the video model only has to solve movement and speech, which is what it's actually good at.

## The pipeline

1. **Anchor still.** Already exists in the media library, or generate one with `ugc-photo-prompts`. This locks subject identity, wardrobe, product, lighting, and skin texture before any motion is added.
2. **Motion prompt.** Describe only what changes from that frame — camera behavior, body motion, speech. Don't redescribe the subject/setting; the still already carries that.
3. **Model pick.** Based on whether the beat needs synced dialogue, multiple combined references, or just clean simple motion — see the table below.
4. **One clip = one beat.** A full UGC ad is a sequence of short jump-cut beats (hook, demo, reaction, CTA), not one continuous shot. Generate each beat as its own clip off the same anchor (or a small consistent set of anchors), then cut them together on the timeline.
5. **Lock the voice across beats.** Same problem as appearance drift, different mechanism — describe the voice explicitly in every beat's prompt (or pin it with a `referenceAudioMediaRefs` clip on Seedance) so the speaker doesn't sound like a different person from one cut to the next.

## Motion-prompt formula

The still already did slots 1–4 and 6–8 from the photo formula. This is just what's added for motion:

1. **Seed reference.** State plainly that this animates the provided still — most models infer this from `startFrameMediaRef`/`referenceImageMediaRefs` alone, but naming it keeps the prompt focused on *change*, not redescription.
2. **Camera behavior.** Default to handheld micro-shake or a static phone propped on a surface — not a smooth gimbal move or a dolly/crane. "Smooth cinematic camera move" is as strong an AI tell in video as studio lighting is in stills.
3. **Subject motion.** Small, continuous, natural movement — a weight shift, a blink, hair moving, a hand gesture mid-sentence. Avoid big choreographed actions unless the beat specifically calls for one (e.g., the demo beat).
4. **Speech, if any.** Put the *exact* line in quotes, written the way someone actually talks — contractions, a small pause, not ad copy. "okay wait this actually smells amazing" reads as real; "Introducing our revolutionary new formula" doesn't, regardless of delivery. **If this speaker appears in more than one beat, describe the voice itself — and always include all four: pitch, tone, accent, and pace, not just one or two.** "A warm, slightly raspy voice" alone is incomplete; "a warm, friendly tone, medium-pitched, neutral American accent, relaxed conversational pace" is the actual bar. Reuse that exact wording verbatim in every beat's prompt — each `generate_video` call has no memory of any other, so the same anchor face will get a *different* voice per clip unless all four are pinned down explicitly every time. Seedance can do better than words: pass the rendered audio from beat one as a `referenceAudioMediaRefs` input on later beats to lock the actual voice rather than approximate it in text.
5. **Duration matched to the beat.** Pick the shortest duration the model offers that fits one beat (often 4–6s) rather than padding a single clip to cover multiple actions — multi-action clips are where motion starts looking choreographed.
6. **Negative motion cues.** Add: no smooth gimbal stabilization, no cinematic camera move, no professional production polish, no overly choreographed motion, no studio lighting. Carry over the standing negative list from `ugc-photo-prompts` for the visual frame itself.

## Model selection

Grounded in this project's actual model catalog and observed behavior, including real failures — not just the catalog spec sheet.

**Default to Grok Imagine Video or Kling V3 for most beats.** Between those two: Kling for anything needing a longer or more nuanced line, Grok when a quick draft is enough.

| Model | Best for | Notes |
|---|---|---|
| **Grok Imagine Video** | Default pick for most beats | Renders synced dialogue audio with accurate lip-sync in this project's tests. Caps at 720p — fine for most UGC use, not a 4k hero asset. |
| **Kling V3 / Kling O3** | Default pick, especially longer/dialogue-heavy beats | Renders synced dialogue audio automatically when the prompt has a quoted line — confirmed repeatedly in this project. O3 allows more references (7 vs 3) if anchoring more than one element. Up to 4k, 3–15s, 16:9/9:16/1:1. |
| **Seedance 2 / Seedance 2 Mini** | Beats combining multiple elements — person + product + a reference audio style | **Never default to 1080p/4k on Seedance 2 — it's expensive. If a beat doesn't specifically need that resolution, use Seedance 2 Mini (720p cap) instead, and if full Seedance 2 at 1080p/4k seems warranted, tell the user it costs significantly more and let them opt in manually rather than generating it by default.** Most flexible model otherwise: up to 9 image refs, 3 video refs, 3 audio refs, 12 total combined. |
| **Veo 3.1 / Veo 3.1 Fast** | Avoid as a default — use only if the user names it specifically | Fails with a content-checker error often in this project (multiple failures across unrelated prompts/anchors in testing here) — unpredictable enough that it's not a safe default pick even though output quality is good when it works. |

Hailuo 2.3 Pro and other catalog models are available but not part of the default rotation — only reach for them if the user asks by name.

## Running this inside Palmier Pro

1. **Get the anchor.** Check `get_media` for an existing still that fits; otherwise generate one via. If you have the skill, check `ugc-photo-prompts` first.
2. **Match the canvas.** `get_timeline` for the project's width/height/fps before picking aspect ratio and duration.
3. **Generate.** `generate_video` with `startFrameMediaRef` set to the anchor still's id (most models), or `referenceImageMediaRefs` if using Seedance to combine multiple elements. Apply the motion-prompt formula above.
4. **Verify.** Async, same as images — `get_media` or `inspect_media` on the placeholder id, confirm `generationStatus` is `none` before treating it as ready. One short wait and recheck, don't poll in a loop.
5. **Assemble the beats.** Once each beat clip is ready, `add_clips`/`insert_clips` onto the timeline in sequence; use `split_clip`/`ripple_delete_ranges` to tighten cuts between beats rather than leaving each clip at its full generated duration.
6. **Voiceover-only alternative.** If a beat doesn't need lip-synced dialogue (pure b-roll with a VO laid over it), use `generate_audio` (TTS) separately instead of forcing a dialogue-capable video model — cheaper and the audio doesn't have to match mouth movement at all.

## Reference-image rule


## Worked example

Continuing the skincare-serum still from `ugc-photo-prompts`: animate it on Kling V3 with a spoken hook line — *"Starting from this image: she glances down at the bottle in her hand, then looks back up at the camera with a small grin and says, in a warm, friendly tone, mid-pitched voice, neutral American accent, relaxed conversational pace, 'okay wait, this actually smells amazing,' a slight handheld shake throughout, no cinematic camera move, no smooth gimbal, no studio lighting, no professional production polish."* That's the hook beat. The demo beat (her actually applying it) and a CTA beat would each be separate, shorter clips off the same anchor — and the full voice description ("a warm, friendly tone, mid-pitched voice, neutral American accent, relaxed conversational pace") gets repeated verbatim in both, not just implied by reusing the same face.

## Guardrails

- Build fictional, generic personas — don't generate a specific real, identifiable person without their consent, and don't use this to recreate a named public figure's likeness.
- Keep wardrobe/pose/action choices brand-safe and non-sexualizing by default; only go further if the user explicitly asks for it.
