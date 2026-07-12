# B3 — Real Export & Paid-Generation Verification Runbook

> The crown pre-beta proof (ADR-005 step B3). Context: a **real video export has never been
> machine-verified** — the e2e "export" test swaps the renderer for a stub that returns a
> 1 KB zero-byte buffer, so no automated test has ever produced a playable file. Likewise a
> real **paid Director generation with credit reserve→settle** has never been observed on real
> infra. This runbook makes both a ~10-minute human pass. Produced by a read-only code trace
> 2026-07-12; file:line anchors let you re-verify without re-deriving.

---

## A1 — Real export → play the file

**Setup**
1. Sign in, open or create a project.
2. Import a **real video clip with audio** (Media tab, drag-drop or picker). A clip with a
   clap/beat near the *end* makes A/V drift visible. Put it on the timeline.
3. Note the project canvas size + fps (editor Settings, or the export dialog) — this is your
   "expected resolution" ground truth (`components/editor/export-button.tsx:159-160`).

**Trigger export**
4. Click the **Export** pill (`data-testid="export-open"`, `export-button.tsx:84-108`).
5. Defaults are **MP4 / High / Include audio ✓ / Byorn watermark ✓** (`constants/export-constants.ts:3-7`).
   Platform presets change only format/quality/audio — resolution always comes from the canvas.
6. Click the primary **Export** (`data-testid="export-run"`).
7. Watch the progress bar — it's real per-frame progress from `SceneExporter`
   (`services/renderer/scene-exporter.ts:144`), not a timer. A 10–20s clip should progress over
   several seconds. **An instant 0→100% jump is suspicious** (possible stub build leaked to prod).
8. On completion a file downloads via `Blob` + `<a download>` (`lib/export.ts:20-38`) — check the
   download bar for `<ProjectName>.mp4` (or `.webm`).

**PASS criteria**
- File exists, non-trivial size, and **actually opens/plays** in QuickTime/VLC. (This is the crux
  CI never checks.)
- **Duration** matches the timeline (±~1 frame).
- **A/V sync** holds at both the start AND the tail (drift accumulates — check the end).
- **Resolution** exactly matches the project canvas. Verify with:
  `ffprobe -v error -show_entries stream=width,height,codec_name,r_frame_rate -of default file.mp4`
- **Codec**: MP4 → H.264 + AAC (or Opus if AAC unsupported); WebM → VP9 + Opus
  (`scene-exporter.ts:97-123`).
- **Watermark** present if left checked (`services/renderer/canvas-renderer.ts:168-241`).

**Failure modes to watch (only the real path can hit these — the stub can't):**
- File won't open / corrupt → `output.finalize()` or WebCodecs encode issue.
- Audio missing/silent despite "Include audio" → mixdown (`createTimelineAudioBuffer`) or
  `AudioBufferSource` wiring bug.
- Audio drifts progressively toward the end.
- Wrong resolution / aspect (stretched/cropped).
- "Export failed to produce buffer" toast → null buffer from mediabunny (`scene-exporter.ts:157-160`).
- Export stalls if you background the tab / let the machine sleep — the render is 100% in-tab
  client JS, **no server-side resume**. Keep the tab foregrounded the whole export.

---

## A2 — Paid Director generation → reserve→settle observed

**Trigger one real paid generation**
1. Editor left rail → **Director** tab (`stores/assets-panel-store.tsx:60-63`), mode **Direct**
   (default, `panels/assets/views/director.tsx:870-878`).
2. Storyboard textarea: one line, e.g. `wide shot of a neon city at night | 5` (`| 5` = seconds).
   **Do not** select a Persona (keeps it to a single reserve/settle pair, no extra persona-still charge).
3. Click **"Reserve slots from shot list"** (free — just makes an empty slot).
4. Set **Takes ×** = `1`, click **Generate all**. If a cost-approval dialog appears, **Approve**
   (`director.tsx:499-509`).
5. This fires a real `POST /api/studio/generate` (`app/api/studio/generate/route.ts`):
   - Server-side cost = `costFor("byteplus-seedance","video",{seconds:N})` = **10 credits/sec × N**
     (min 1) (`lib/credits/cost-table.ts:21-27,76-83`). The 5s example = **50 credits**.
   - `meteredReserve` runs **before** provider dispatch (`generate/route.ts:334-346`).
   - Seedance returns `status:"pending"` (`lib/studio/provider-adapter.ts:180`) — genuinely async,
     so reserve and settle are separated in time and observable as two events.
6. Client polls `GET /api/studio/generate/[jobId]` until terminal → **settles** on success,
   **releases** on failure (`generate/[jobId]/route.ts:67-113`).

**What to watch — three ways, pick by access level:**

*Signal 1 — `/api/credits/balance`* (`app/api/credits/balance/route.ts`):
- Before: note `balance`, `reserved`, `spendable` (hit the endpoint directly in a tab — the pill
  only auto-refreshes at request start/end, not mid-poll, `hooks/use-studio-generation.ts:174-184`).
- Mid-job (still "processing"): `reserved` +50, `balance` unchanged, `spendable` −50.
- After completion: **`balance` −50 if SETTLED**, **unchanged if RELEASED**. ⚠️ `spendable` looks
  identical in both cases — you must read `balance` to tell settle from release.

*Signal 2 — `/api/credits/history`* (no DB access needed, `lib/credits/ledger.ts:467-495`):
- History excludes delta=0 rows (both `reserve` and `release` markers are delta=0).
- **PASS = settled:** a new entry `{ reason:"settle", delta:-50, refType:"studio_job" }`.
- **Released (failed job):** *no new entry appears* — the absence is the signal.

*Signal 3 — direct SQL on prod Postgres (if you have access):*
```sql
SELECT reason, delta, balance_after, ref_type, ref_id, metadata, created_at
FROM credit_ledger
WHERE user_id = '<your-user-id>'
ORDER BY created_at DESC LIMIT 10;

SELECT balance, reserved, balance - reserved AS spendable
FROM credit_accounts WHERE user_id = '<your-user-id>';
```
Expect two rows: `reason='reserve', delta=0, metadata.hold=50` then `reason='settle', delta=-50`
(charged) — or `reason='release', delta=0, metadata.released=50` (refunded). `ref_id` on both is
the **take id** (per-job charge id), not the set id (`generate/route.ts:330-346`).

*Note:* closing the tab mid-poll does **not** lose the hold — a sweep reconciles it against the
provider's real outcome (`lib/credits/sweep.ts:1-37`). For a clean signal, keep the tab open until
the take shows "ready"/"kept".

---

## B — Why the e2e "export" proves less than it looks

`components/editor/e2e-bridge.tsx:74-98` replaces `RendererManager.exportProject` wholesale with a
stub that records the call `options`, fires `onProgress(0)`→`onProgress(1)`, and returns
`{ success:true, buffer: new ArrayBuffer(1024) }`. The test (`e2e/happy-path.e2e.ts:195-235`) only
asserts the button was clicked, `isExporting` toggled, and the options were right. **It never
observes bytes.** Everything below the swap is skipped:
- `buildScene()` (`services/renderer/scene-builder.ts`) — no real scene graph.
- `createTimelineAudioBuffer()` (`lib/media/audio.ts`, `OfflineAudioContext.decodeAudioData`) — no audio mixdown.
- `SceneExporter.export()` (`scene-exporter.ts:81-165`) — the per-frame loop, `CanvasRenderer.render()`,
  real video-frame decode, WebGL effects, watermark compositing, and mediabunny's WebCodecs
  `VideoEncoder`/`AudioEncoder` + mux + `finalize()` — none of it runs.

So "export kicks off a render" is tested; **"a playable video comes out" has never been exercised by
any automated test.** B3 is the first time it ever happens — hence the insistence above on opening
the file and probing duration/resolution/codec.

---

## C — Pre-deploy real-export sanity: YES, feasible without a deployment

The real encode needs `OffscreenCanvas`, real frame decode, `AudioContext`/`OfflineAudioContext`,
and WebCodecs (via `mediabunny`). None exist in the `bun test` runtime (confirmed by
`services/renderer/nodes/video-node.test.ts:1-40`, which mocks the canvas + frame cache), so a
Node/Bun unit harness **cannot** run the real path — but a **real Chromium (headless or headed)
can**, and it does **not** need the production deployment.

**Key unlock:** `NEXT_PUBLIC_E2E` is baked in at build time. The stub only exists when built with
`NEXT_PUBLIC_E2E=1` (`package.json:11` `build:e2e`). A normal `bun run dev` or `bun run build &&
bun run start` (no flag) compiles `E2E_ENABLED=false`, so `E2EBridge` no-ops and the genuine
`RendererManager.exportProject → SceneExporter → mediabunny` path runs.

**How (all local, no prod creds — export touches neither DB nor billing):**
1. `cd apps/web && bun run dev` (or `bun run build && bun run start` for prod-closeness).
2. Open in a real browser — your Chrome, or a fresh ad-hoc Playwright script pointed at
   `localhost:3000` (NOT the existing `playwright.config.ts`, which is wired to the stubbed
   `build:e2e` server).
3. Import a short real clip w/ audio → timeline → Export → Export.
4. Capture the download (`page.waitForEvent('download')`) or save manually.
5. `ffprobe` the file: duration ≈ timeline, resolution == canvas, video codec == h264/vp9, audio
   stream present with matching duration.

This catches corrupt-output / wrong-resolution / dropped-audio / wrong-codec bugs **before** the
deploy. It **cannot** pre-verify production-only concerns — CDN/hosting quirks, a prod CSP or
COOP/COEP header blocking `SharedArrayBuffer`/WebCodecs, HTTPS-only feature gating — which is
exactly what the human B3 pass on the live deployment is still for.
