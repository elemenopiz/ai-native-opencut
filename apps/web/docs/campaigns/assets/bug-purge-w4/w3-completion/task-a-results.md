# Task A — C25 audio-lifecycle contracts (W3, C21b bug-purge-w4)

Driver: `apps/web/e2e/hunt/w3-taska.w3.e2e.ts` (real UI: filechooser
import, real HTML5 drag-to-timeline, real Radix context-menu delete, real
`Meta+z` keypress, real mic-button clicks with
`--use-fake-ui-for-media-capture --use-fake-device-for-media-capture`
launch flags). Raw run: `logs/task-a-contracts.log`.

## CONTRACT 1 (BUG34 fix regression-check) — PASS

Imported `tiny-tone.wav`, dragged it to the timeline, right-clicked the
asset in the Assets panel → Delete (Radix pointer-event sequence, not a
plain `.click()`), then pressed `Meta+Z`.

| Step | Result |
|---|---|
| Asset removed from panel after delete | true |
| Clip removed from timeline after delete | true |
| Asset reappears in panel after undo | true |
| Timeline clip(s) restored after undo | true |
| Audio still decodable after undo (probed via `URL.createObjectURL(asset.file)` → `new Audio()` → `loadedmetadata`) | true, `duration: 1`s |

Screenshots: `screenshots/taska-c1-before-delete.png`,
`taska-c1-after-delete.png`, `taska-c1-after-undo.png`.

**Verdict: PASS.** BUG34's "asset delete + timeline cascade is ONE
reversible command" holds up under a real UI-driven repro — no
regression.

## CONTRACT 2 (record→discard) — PASS

With fake-media-device Chrome launch flags and `grantPermissions(["microphone"])`:

| Step | Result |
|---|---|
| Asset/clip count before any recording | 0 / 0 |
| "Discard recording" button visible while recording | true |
| Asset/clip count after discard | 0 / 0 (zero new) |
| Asset count after a subsequent record→Stop | +1 (exactly one new asset) |

Screenshots: `screenshots/taska-c2-recording-in-progress.png`,
`taska-c2-after-discard.png`, `taska-c2-after-stop.png`.

**Verdict: PASS.** Discard is clean (no orphaned assets/clips); a
completed recording lands exactly one new asset — matches the "completed
take always lands somewhere retrievable" invariant from the prior
board/takes work, and no discard-leak regression.

No product-code changes proposed — both contracts hold on the wave-3
integrated tip.
