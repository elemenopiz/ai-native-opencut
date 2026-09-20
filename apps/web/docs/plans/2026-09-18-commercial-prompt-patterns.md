# Production Prompt Patterns — extracted from the "$350k AI Commercial" full-prompt breakdown

**Source:** Higgsfield blog, *"$350.000 AI Commercial - Full Prompts"*, David Matamoros,
2026-03-26 (companion to a YouTube build). Supplied as text by the user because
`higgsfield.ai` is blocked by this environment's egress policy. **First-party** — this
supersedes the secondary/community sourcing in
`2026-09-18-generation-workflow-research.md` wherever the two disagree.

This is the highest-value prompt material we have: a complete commercial, every prompt
shown, in build order.

---

## 1. The build order, confirmed

Exactly the reference-first sequence, and stricter than the secondary sources implied:

1. **Characters first, before any scene.** *"Every good film starts with consistent
   characters. Before generating any scenes, create a reference sheet for each character so
   they look the same across every shot."*
2. **Locations second.** *"Same idea as characters — generate your key locations once, lock
   them in, and reference them throughout."*
3. **Keyframe third** — composite the locked characters INTO the locked location as a still.
4. **Animate the keyframe** — video is generated *from* the approved still, not from text.
5. **Start-frame / end-frame pairs** for any shot where the change itself is the point.

Nothing is generated from a bare text prompt after step 2. Every later prompt is an
operation on already-approved assets.

## 2. Characters are built from structured parameters, not prose

The character sheet is generated from a **parameter form**, not a paragraph:

> Genre · Budget · Era · Archetype · Identity (sex / ethnicity / age) · Physique · Eyes ·
> Hair · Facial hair · Outfit

e.g. *Action · $100M · 2020s · Lover · Male, Latino, ~30 · Athletic, tall · Hazel ·
Slick back, wavy, brown · Mustache · Black tuxedo.*

"Budget" as a generation parameter is the interesting one — a proxy for production value
that prose ("cinematic", "high quality") conveys far less reliably.

## 3. Named reference handles — the mechanism that makes it hold together

Every locked asset gets a **name**, then is addressed by handle in later prompts:

`@Orlando` · `@Maria` · `@Orlando_spy_costume` · `@hologram_img` · `@watch_img` ·
`@blowgun` · `@lasers_right_angle` · and positional `<<<image_1>>>` / `<<<image_2>>>`

This is the whole trick. Identity is never re-described; it's *referenced*. The prompt then
only carries what changes:

> `@Orlando` opens the door, pauses to look around, then steps into the room. He takes off
> his jacket.

Byorn already has `@Image1` / `@Video2` handle tokens. What's missing is **user-assigned
semantic names** (`@Orlando`, not `@Image3`) and their persistence across a project.

## 4. Reference role assignment — each reference gets a job

Multiple references in one call, each explicitly scoped:

> *"Use the attached image as a reference for style, mood, and lighting, and the second
> image for color grading and tonal balance."*

> *"Use Image 1 exclusively for the female character's appearance, and Image 2 only for the
> environment, lighting, atmosphere, materials, and architectural language."*

Not "here are two references, figure it out" — an explicit contract per image. This is
directly portable to Byorn's `referenceImages[]`, which today is an unlabelled array.

## 5. Reusable prompt blocks worth stealing verbatim

**The "this is a film frame" anti-advertising block** — appears on nearly every character
sheet, and fights the model's pull toward glossy stock imagery:

```
preserve original color grade, preserve original grain, preserve original exposure,
preserve original framing, no beauty grade, no skin smoothing, no sharpening, no HDR,
no contrast push, no saturation boost, photorealistic, this is a film frame not an
advertisement
```

**The character reference-sheet template:**

```
A professional character reference sheet on a clean neutral solid background, featuring a
clean composition, uniform spacing, and perfect consistency across all panels. On the left
— a medium shot of the character framed from the waist up, facing forward. On the right —
two full-body standing views of the same character, arranged as a front view and a back
view. No text, no labels, no background elements other than the plain neutral backdrop.
```

**Location reinterpretation** (reuse the *feel* without pasting the plate):

> *"The setting is inspired by the reference location but not used as a direct background —
> the environment is reconstructed and reinterpreted, maintaining the same atmosphere and
> style."*

**Camera continuity as a delta**, never a re-description:

> *"change camera angle 45 degrees to the right"* · *"slightly change camera angle for 15
> degrees to the left side"* · *"save character pose and framing of the camera from image 1"*

**Dialogue syntax:**

```
@Orlando with a slight smirk says: "Yes, lady…" Static camera.
Shot 1: Close-up on <<<image_1>>>; …  <<<image_1>>>: "Something tells me…"
Shot 2: Close-up on <<<image_2>>>; …  <<<image_2>>>: "Secrets?"
```

## 6. Start-frame / end-frame is used as an editorial device

Not just for continuity — for *authoring a change*:

> laser beams off = start frame, laser beams on = end frame, prompt: *"The lasers suddenly
> activate. The man subtly flinches."*

The transition is expressed as two stills plus a sentence. Byorn's `supportsLastFrame`
capability and `chainFrom` verb already carry the plumbing for this; it isn't being used
this way.

## 7. The admission that matters most to us

> *"Not enough CCTV Look, So I used DaVinci Effects here."*

A flagship, fully-produced commercial — and the author still leaves the tool for a grade.
Combined with the pipeline's stage 8 (*"assemble in your video editor of choice"*), that's
twice in one project that the workflow hands off to an NLE. **Byorn is the NLE that does
not need the handoff.**

---

## 8. What to do with this

1. **Semantic reference handles.** Let a user or the Director name an asset (`@Orlando`) and
   have that name resolve across every later prompt in the project. Today's `@Image1` is
   positional and doesn't survive.
2. **Per-reference role labels.** `referenceImages[]` becomes `{url, role}` — appearance /
   environment / grade / style. Then the prompt builder writes the explicit contract
   sentence instead of hoping.
3. **Ship the anti-advertising block and the reference-sheet template** into
   `playbooks/shot-craft.md` as named, reusable fragments.
4. **Make the build order the Director's default path**: characters → locations → keyframe →
   animate. It currently generates shots ad hoc.
5. **Use start/end-frame pairs as an authoring device**, not only for chaining.

**Poach status:** research only, nothing in the codebase yet. Prompt text lifted verbatim
from this post needs a `POACH-LEDGER.md` row — and note this is a **blog post, not the MIT
skills repo**, so its licence is not MIT. Treat verbatim reuse as quotation-with-attribution
and prefer adapting the *pattern* over copying the text.
