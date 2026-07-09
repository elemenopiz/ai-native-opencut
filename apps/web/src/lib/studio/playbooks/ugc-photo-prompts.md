---
name: ugc-photo-prompts
description: Generate ultra-realistic, UGC/influencer-style photos inside Palmier Pro — candid selfies, flash photos, lifestyle shots, and product-in-hand ad creative that read as genuine phone photos instead of AI-generated images. Drives Palmier Pro's get_timeline/get_media/generate_image tools directly (correct aspect ratio, model choice, reference-image handling). Use whenever the user wants UGC-style imagery, influencer selfies, "make it look like a real iPhone photo," authentic/non-AI-looking ad creative, or product photos held by a model — even if they don't say "UGC" explicitly.
---

# UGC-Style Photo Prompts

## Core principle

Image models default to polish: symmetric features, smooth retouched skin, studio lighting, clean backgrounds. That polish is the single biggest tell that an image is AI-generated, and it's exactly what kills performance for UGC ads and influencer content — the entire point of UGC is that it doesn't look produced.

Telling the model "make it look realistic" doesn't work, because "realistic" isn't a style the model can target — it's an absence of all the polish defaults, and the model needs that absence written into every slot of the prompt as a specific physical detail. Realism comes from specificity (a named flaw, a named light source, a named texture), not from the word "realistic" itself.

## The 9-slot formula

Fill every slot, in this order, for every prompt:

1. **Format declaration** — camera + shot type + aspect ratio, stated first. This locks the model into "photo," not "illustration." e.g. *"Ultra-realistic iPhone front-camera selfie, 4:5 vertical"* / *"Ultra-photorealistic flash photo, 4:5 vertical."*
2. **Framing & lens behavior** — distance (arm's length / chest-up / full body), angle (slightly above or below eye level), and the lens distortion that comes with it (wide-angle selfie warp, a shoulder cropped out of frame, imperfect centering).
3. **Subject — the imperfection stack.** Never write "beautiful woman, smiling." Specify hair texture and disorder (damp, windblown, flyaways), skin (tone + pores + one specific flaw — freckles, redness, sweat, under-eye shadow, tan line), and a *momentary, specific* expression (mid-laugh, looking off to the side, mouth slightly open) instead of a generic one.
4. **Wardrobe + accessories, named specifically.** Fabric, fit, and at least one small accessory (hoops, a layered necklace, a bag strap). Generic clothing description reads as generic AI output — specificity here is doing real work, not just flavor.
5. **Pose as interaction, not posture.** Give the subject something to physically do — hold an object, mid-gesture, walking, getting their hair touched by someone off-frame — rather than "posing for camera." Static posing is the second-biggest AI tell after skin polish.
6. **Setting with texture and clutter.** Name actual materials (brick, stone, fridge glass, car upholstery, a tiled floor) and at least one incidental detail unrelated to the subject (a second person's arm in frame, a parked car, a visible price tag). Staged sets don't have incidental detail; real environments always do.
7. **Lighting, named and physical.** State the actual light source (direct flash, golden-hour side light, fluorescent overhead, window light) and what it visibly does to skin and shadow — not "good lighting," but what the light is doing.
8. **Vibe tag.** One short phrase tying the scene together — *"everyday building-corridor look," "candid basement-party energy"* — this keeps the model from sliding back into editorial polish even after all the specific detail above.
9. **Negative space.** Say what NOT to do. This is doing as much work as the rest of the prompt — see the standing list below.

## Standing negative prompt

Use this (or a trimmed version) on every generation. If the model has a separate negative-prompt field (Midjourney `--no`, SDXL negative conditioning), put it there. If the model only takes one prompt with no negative field (nano-banana-pro, Flux, Veo stills), append it as plain language at the end instead:

> studio lighting, airbrushed or retouched skin, perfect symmetry, doll-like or waxy skin, over-smoothed face, professional photoshoot polish, cinematic color grade, CGI look, fantasy lighting, unrealistic eyes, text, watermark, logo

## Universal realism add-on

If a draft still comes back too clean, don't rewrite the whole prompt — append this line:

> Real iPhone photo uploaded to Instagram, imperfect framing, visible pores, flyaway hairs, natural facial asymmetry, slight motion blur, phone HDR, compression artifacts, uneven lighting, no beauty retouching, no professional studio setup, no cinematic color grading.

## Worked example (product-in-hand ad shot)

| Slot | Choice |
|---|---|
| 1. Format | Ultra-realistic iPhone front-camera selfie, 4:5 vertical |
| 2. Framing | Arm's length, slightly above eye level, one shoulder cropped at the frame edge |
| 3. Subject | Mid-20s woman, damp tousled brunette hair, visible pores, faint under-eye shadow, caught mid-laugh with eyes half-closed |
| 4. Wardrobe | Fitted olive ribbed tank top, small gold hoop earrings, a thin layered necklace |
| 5. Pose | Holding [PRODUCT] up close to the lens with one hand, other hand mid-gesture brushing hair back |
| 6. Setting | Plain bedroom corner — unmade bed visible at the edge, a phone charger cable on the nightstand |
| 7. Lighting | Warm afternoon window light from the left, soft shadow falling across the right side of her face |
| 8. Vibe | "Just got this in the mail" energy |
| 9. Negative | (standing list above) |

Assembled: *"Ultra-realistic iPhone front-camera selfie, 4:5 vertical, arm's length, slightly above eye level, one shoulder cropped at the frame edge. A mid-20s woman with damp tousled brunette hair, visible pores, faint under-eye shadow, caught mid-laugh with her eyes half-closed. She wears a fitted olive ribbed tank top, small gold hoop earrings, and a thin layered necklace, and holds [PRODUCT] up close to the lens with one hand while the other brushes her hair back. Background is a plain bedroom corner with an unmade bed visible at the edge and a phone charger cable on the nightstand. Warm afternoon window light comes from the left, casting a soft shadow across the right side of her face. 'Just got this in the mail' energy. No studio lighting, no airbrushed or retouched skin, no perfect symmetry, no CGI look, no text, no watermark."*

Swap slot 5/6/8 and you have a review-style talking-selfie shot or an unboxing shot with the same bones.

**What actually happened when this ran** (real test, not hypothetical): pores, the charger cable, and the warm-light/shadow contrast all rendered exactly as specified — those three slots have real, demonstrated pull on the model. "One shoulder cropped at the frame edge" did not land — both shoulders stayed fully in frame. Lesson: framing/crop instructions are the least reliable slot so far. Always check the actual output against each slot after generating — don't assume compliance just because it's in the prompt.

## More templates

Five more, same 9-slot structure, fill the brackets:

**1. Solo mirror/bedroom selfie** — the everyday "getting ready" shot, the default category when nothing else fits.
Format: iPhone selfie, 4:5. Framing: front-camera, chest-up, slight high angle, mirror or arm's-length. Subject: [hair texture/color], [pores / faint blemish / under-eye texture], [a smirk / mid-blink / lips slightly parted — not "smiling"]. Wardrobe: [top + fabric], [1–2 small accessories]. Pose: phone visible if mirror selfie, otherwise a hand mid-motion adjusting hair/hem. Setting: [bedroom/bathroom], everyday clutter — charger cord, half-open closet, towel on a hook. Lighting: overhead room or window light, slightly uneven, shadow under the chin. Vibe: "quick outfit check before leaving."

**2. Flash nightlife candid** — bar/street/party, direct flash is the dominant light source.
Format: iPhone flash photo, 4:5. Framing: arm's length or slightly above, casual tilt, imperfect centering. Subject: [hair messed by wind/humidity], [shine from flash + one texture detail], [laughing / talking mid-sentence / caught off guard]. Wardrobe: [jacket/top], [hoops/bangles], [a bag strap visible]. Pose: holding a drink, mid-gesture, or arm around someone partially out of frame. Setting: [street/bar exterior], wet pavement or brick texture, blurred crowd/signage. Lighting: direct on-camera flash — hard shadow behind subject, blown highlights, ambient neon bleeding in. Vibe: "spontaneous night-out, not a posed photo-op."

**3. Outdoor/travel** — daylight, open setting, avoid the "travel magazine" look.
Format: iPhone photo, 4:5. Framing: full body or chest-up, taken by subject or companion, slightly off-center. Subject: [hair moving in wind], [sun flush / tan line / freckles], [squinting / mid-laugh / looking past camera]. Wardrobe: [season-appropriate outfit, named fabric], [1 accessory]. Pose: walking, sitting, or interacting with the environment, not standing for a portrait. Setting: [stone wall / dock / market stall] + one piece of incidental background life (another tourist, parked bikes). Lighting: [golden hour / harsh midday sun], named skin effect. Vibe: "caught mid-trip, not posing for it."

**4. Lifestyle with activity** — gym, kitchen, café, desk; the photo should look like it interrupted the activity.
Format: iPhone selfie or photo, 4:5. Framing: close/mid-distance, angle dictated by the activity. Subject: [hair affected by the activity], [flush/sweat sheen or none], [focused or mid-task expression]. Wardrobe: [activity-appropriate clothing]. Pose: mid-rep, mid-stir, mid-typing — the activity *is* the pose. Setting: [gym/kitchen/cafe], activity-specific equipment, one blurred person/object in background. Lighting: [fluorescent / window / mixed], named effect. Vibe: "caught in the middle of it."

**5. Two-person candid** — someone else's hands/arm/shoulder visible but not the focus. One of the strongest "this wasn't staged" signals, and underused.
Format: candid iPhone photo, 4:5. Framing: mid-distance, chest-up or mid-thigh, slightly off-angle as if taken by a third person. Subject: [hair/skin/expression], relaxed, looking slightly off-camera or at the second person. Wardrobe: [outfit, named fabric], [1 accessory]. Pose: sitting/standing while the second person does something to/with them (braiding hair, handing over a coffee). Setting: [location], second person visible only from [arm/torso/hands] with one named clothing fragment for them too. Lighting: [daylight/indoor lamp], named effect. Vibe: "mid-conversation, not posed for either person."

## Running this inside Palmier Pro

This skill drives Palmier Pro's MCP tools directly. Standard sequence:

1. **Match the canvas.** Call `get_timeline` first. Use its `width`/`height` to derive the aspect ratio for `generate_image` instead of defaulting to 4:5 — a 9:16 project wants 9:16 stills, not feed-style crops the user will have to reframe.
2. **Check for an existing reference asset.** Call `get_media` and look for a product/subject photo already in the library before describing one from scratch in prose. If one exists, pass its id in `referenceMediaRefs` — see the reference-image rule below for when this is and isn't appropriate.
3. **Pick the model based on what matters more, not habit:**
   - **Realism / "doesn't look AI" is the priority** (most UGC, most influencer selfies) → `nano-banana-pro`. In side-by-side testing it held skin micro-texture and followed specific lighting instructions more faithfully, at meaningfully higher resolution.
   - **The product itself must read clearly and unmistakably** (catalog-adjacent, hero product shot) → `gpt-image-2` tends to frame the product more prominently, at some cost to skin/lighting realism.
   - This is a real tradeoff observed empirically, not a fixed rule — when it matters, generate one of each and compare rather than assuming.
4. **Generate, then verify.** `generate_image` is async — call `get_media` (or `inspect_media` on the returned placeholder id) to confirm `generationStatus` is `none` before treating the asset as ready. Don't poll in a tight loop; one short wait and recheck is enough.
5. **Place it.** Once ready, `add_clips` or `insert_clips` onto the timeline at the right track/frame if the user wants it in the edit, not just sitting in the library.

## Using reference images (referenceMediaRefs)

**How to pass it well:**

- A reference image anchors the *object/subject's identity* (exact shape, color, material, face). It does not anchor style, lighting, pose, or setting — you still write the full 9-slot prompt around it. A reference photo alone doesn't make an output look like UGC; the prompt slots still have to do that work.
- Don't redescribe the reference's own appearance in the prompt text — that just invites the model to reconcile two descriptions of the same object instead of trusting the image. Refer to it generically ("the bag from the reference image," "holding the product shown") and let the image carry color/material/shape.
- Reference image quality matters more than reference image style. A clean, evenly-lit catalog-style shot (plain background, no harsh shadows baked in) gives the model the cleanest read on shape and material and is easiest to relight convincingly in a new scene. A reference photo with strong existing shadows/color cast carries that lighting into the output whether you want it to or not.
- If you have more than one angle of the same product, passing multiple `referenceMediaRefs` generally improves shape fidelity, especially for less common silhouettes.
- Reference images don't need to match the output's aspect ratio — the model extracts the subject, not the canvas.
- Reuse the same `mediaRef` across multiple `generate_image` calls when you want one product/subject to appear consistently across a set of different scenes ("campaign" look) rather than re-uploading or re-describing it each time.
- Keep product reference assets in their own `folderId` in the media library so `get_media` surfaces them quickly for reuse later.

## Guardrails

- Build fictional, generic personas — don't generate a specific real, identifiable person without their consent, and don't use this to recreate a named public figure's likeness.
- Keep wardrobe/pose choices brand-safe and non-sexualizing by default; only go more revealing than streetwear if the user explicitly asks for it.
