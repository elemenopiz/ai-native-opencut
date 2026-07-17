# Campaign: export-formats (C11) — 2026-07-17

Branch: `campaign/export-formats` off main @2a1307a0. L1 orchestrator log (crash-survival
state — status tables record only what HAS happened).

## Objective

1. **Captions/SRT+VTT export** — local (no ai-backend round-trip), timeline-time aligned,
   validated output.
2. **Preset matrix** — social-size presets (dimension-carrying), GIF + WebM options in the
   export dialog, wired to the existing encoder path (no rebuild).
3. **Export QA matrix doc** — `apps/web/docs/export/qa-matrix-2026-07-17.md`, real exports
   ffprobed per preset.

## Recon facts (verified in-tree 2026-07-17)

- `renderer-manager.exportProject` always exports at `activeProject.settings.canvasSize`;
  `ExportOptions` has NO dimensions field. The dimension plumb = optional
  `dimensions` on `ExportOptions` → SceneExporter render-vs-output split (render scene at
  project canvasSize, contain-fit blit onto an output canvas of preset size; elements are
  positioned relative to canvas center, so rendering the scene itself at a different
  aspect would recompose, not scale — blit is the correct approach).
- mediabunny 1.29.1 has **no GIF output format** (checked `mediabunny.d.ts`: Mp4/WebM(Mkv)/
  Mov/MpegTs/Ogg/etc, zero "gif" matches). No gif dep anywhere. GIF ⇒ clean-room GIF89a
  encoder module (LZW + median-cut palette), no new deps (hard gate).
- Existing SRT/VTT export (`captions.tsx` `handleExportSubtitles`) calls
  `aiClient.generateSubtitles` — the **frozen Python ai-backend** (ADR-004); broken for
  prod strangers. Replace with local serialization.
- `lib/subtitles/` already has srt/vtt/ass **parsers** (MIT port) + `SubtitleCue` type —
  use as round-trip validators for the new serializers.
- Transcript timestamps are **asset-relative** (== trim timebase); timeline text elements
  are timeline-time. Caption export must emit timeline time.
- Two preset systems exist: `constants/export-constants.ts` `EXPORT_PRESETS` (wired to
  dialog; format/quality only) and `lib/export-presets.ts` `PLATFORM_PRESETS` (has
  canvasSize; batch-export panel). Extend the dialog's system with dimensions; don't
  unify (out of scope).
- `ExportFormat` consumers beyond dialog: `lib/director/tool-catalog.ts`,
  `director-api.ts`, `lib/media/clip-reference.ts` — widening the union to "gif" must
  keep those compiling and their schemas honest.
- QA recipe: `e2e/real-export/golden-path-export.e2e.ts` + `playwright.real-export.config.ts`
  + `test:e2e:real` (export stub OFF) + ffprobe — C12's machine-verified pattern.
- Taste-gate G7 unanswered ⇒ export-dialog changes stay in the existing idiom (chips +
  collapsible Sections), additive only, no restyle.

## Plan — waves & file-cluster partition

| Wave | Worker | Owned files (exclusive) | Deliverable |
|---|---|---|---|
| 1 | W1 captions (sonnet) | `lib/subtitles/serialize.ts`(new) + tests, `lib/export/captions.ts`(new) + tests, `panels/assets/views/captions.tsx` (export handler swap only) | Local SRT/VTT serialize + timeline-time cue collection + UI swap |
| 1 | W2 presets (sonnet) | `types/export.ts`, `constants/export-constants.ts`, `components/editor/export-button.tsx`, `core/managers/renderer-manager.ts`, `services/renderer/scene-exporter.ts` | Dimension-carrying presets, contain-fit output plumb, dialog wiring (mp4/webm) |
| 1 | W3 gif encoder (sonnet) | `lib/export/gif/**`(new) + tests | Clean-room GIF89a encoder to a fixed contract |
| 2 | W4 gif wiring (sonnet, off campaign after W2+W3 merge) | scene-exporter gif branch, export-button gif option, mime/ext maps, ExportFormat union | GIF export end-to-end |
| 3 | W5 QA (sonnet) | `e2e/real-export/preset-matrix.e2e.ts`(new), `docs/export/qa-matrix-2026-07-17.md`(new) | Real exports per preset, ffprobe evidence, QA doc |
| 3 | L1 | — | Browser-verify dialog + captions export, screenshots |

GIF encoder contract (fixed now so W4 can wire without renegotiation):
`apps/web/src/lib/export/gif/encoder.ts` exports
`class GifEncoder { constructor({width,height,fps,loop?}); addFrame(frame: ImageData): void; finish(): Uint8Array }`
— GIF89a, NETSCAPE2.0 infinite loop, per-frame local color table (median-cut ≤256),
LZW, delay = round(100/fps) cs.

## Status log (append-only; only things that HAVE happened)

- 2026-07-17: campaign branch created off main @2a1307a0; recon done; plan committed.
