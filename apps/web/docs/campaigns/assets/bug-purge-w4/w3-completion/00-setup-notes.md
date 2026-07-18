# W3 (task/w3-interaction-completion) — setup notes

- Branch created off main @ a95b616e (2026-07-18)
- Reusing live server on :3303 — confirmed served from worktree
  /Users/zsha/Documents/ai-native-opencut/.claude/worktrees/agent-aa07da3cbe86f796e
  (branch task/w2-interaction-ui @ 29a06429), which itself carries the wave-3
  integrated tip: C15 (ui-phase-b, BUG27/28), C25 (audio-lifecycle, BUG34/35),
  C24, C27, C28's local equivalents merged into that branch's own history via
  separate merge commits (different SHAs than main but same content).
- Predecessor's w-drag suite log read at:
  /Users/zsha/Documents/ai-native-opencut/.claude/worktrees/agent-adeb19298bbfedaff/apps/web/docs/campaigns/assets/bug-purge-w4/w2-interaction/task-a-w-drag-suite.log
  6 failures total, mapping to Task C's 4 items:
    1. M8 "label edge cases" (line 45) + M18 "context menu sweep" (line 133) —
       BOTH fail identically: `TimeoutError: page.waitForEvent filechooser`
       on the SECOND importViaFileInput call in the same session. -> Task C item 1.
    2. M15 "list view: drag from compact/list row" (line 76) — `draggable
       element not found for "tiny_640x360_h264.mp4"` after toggling view
       mode. -> Task C item 2.
    3. M15 "drop onto EMPTY vs EXISTING vs BETWEEN tracks" (line 102) —
       second drop (image onto occupied track region) lands nowhere,
       `imageLanded` false. -> Task C item 3 (strongest real-bug candidate).
    4. M20 "GRANTED starts recording state" (line 164) — `isRecordingVisible`
       false even with context.grantPermissions(["microphone"]) already
       called by the test (no fake-device flags though — suite runs plain
       Chromium getUserMedia which returns no real device in CI/headless).
       -> Task C item 4.
    5. M20 "Audio > Record sub-tab" (line 194) — strict-mode violation,
       TWO elements match getByRole('button',{name:'Audio',exact:true}):
       aria-label="Audio" (assets-panel tab) AND
       data-testid="generate-media-tab-audio" (C15 generate-media tab).
       -> Task C "Also CONFIRM" duplicate accessible name item.

Driving via mcp__Claude_Browser__* tools (Browser pane) against localhost:3303,
not the Playwright test runner — going through the UI like a human, per E2E
bridge SEEDING-ONLY rule.
