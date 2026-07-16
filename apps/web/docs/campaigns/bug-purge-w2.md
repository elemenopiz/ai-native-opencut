# Campaign: bug-purge-w2 (C7 wave 2)

Branch: `campaign/bug-purge-w2` off main @423efd82. L1 orchestrator log — crash-survival state.

## Scope

**Part 1 — C4-A bug crop (queue §2):**
- BUG7 (cmd palette Cmd/Ctrl+K headless): repro headed+headless, disposition. Recon lead:
  `src/stores/keybindings-store.ts:223` — `ctrl: isAppleDevice() ? ev.metaKey : ev.ctrlKey`;
  on Apple platforms literal Ctrl+K never matches, only Meta+K. Headless Chromium on a Mac
  reports Apple → harness sending Control+K is a no-op **by design**. Likely artifact.
  Also note: Cmd+K = AI command panel (`toggle-ai-command-panel`), Cmd+Shift+P = command
  palette (`command-palette.tsx:276`) — the C4-A expectation may have conflated the two.
- BUG10 (text-preset doubled truncation): root cause found in recon —
  `src/components/editor/panels/assets/draggable-item.tsx:136-138`:
  `name.length > 8 ? \`${name.slice(0, 16)}...${name.slice(-3)}\` : name` — any name of
  9–19 chars renders whole + "..." + last-3 ("Body Text...ext"). Worker fix.
- BUG11 (EditableProjectName no keyboard path): `editor-header.tsx:449-523`, readOnly input
  with onClick-only entry. Worker adds Enter/F2 + a11y attrs.
- BUG13 (DeleteElementsCommand raw TypeError on malformed input): guard + unit test,
  `src/lib/commands/timeline/element/delete-elements.ts`. Worker.
- BUG8 (export-popover × signup-tooltip z-order): repro + document ONLY — export-button.tsx
  under active integration elsewhere. L1 does this by hand.

**Part 2 — fresh-fixture golden-path hunt:** mint NEW fixtures (portrait 9:16 1080x1920,
10-bit HDR HEVC, tiny 2s clip, audio-only, PNG w/ alpha) → import → timeline edit → REAL
export → ffprobe validate. Watch: BUG12-class regressions, portrait-canvas export
correctness, alpha handling. No provider credits — local fixtures + E2E bridge only.

## Off-limits (hot surfaces — queue rows instead)
stores/*, ai-client.ts, route table, packages/env, package.json/bun.lock, migrations,
renderer/compositor/video-cache internals, server-side auth, money/credits,
export-button.tsx + e2e-bridge.tsx, existing e2e specs (new spec files OK).

## Worker roster (partitioned by file cluster; all sonnet, worktree, background)

| W | Task | Owned files | Status |
|---|---|---|---|
| W1 | BUG13 guard + unit test | `src/lib/commands/timeline/element/delete-elements.ts` + new test in `__tests__/` | dispatched |
| W2 | BUG11 keyboard access | `src/components/editor/editor-header.tsx` | dispatched |
| W3 | BUG10 truncation fix | `src/components/editor/panels/assets/draggable-item.tsx` | dispatched |
| W4 | Part-2 fixture hunt | fixtures dir + optional NEW e2e spec only; no product code | dispatched |
| L1 | BUG7 repro/disposition + BUG8 repro-doc | none (read + browser only) | in progress |

## Verify plan
- Battery on campaign tip after merges: typecheck 0 / lint no-worse / build / bun test;
  e2e suite once (happy-path expected stable post-BUG12).
- Browser-verify BUG10/BUG11 fixes from this worktree (standalone dev server + url preview).
- BUG7/BUG8 evidence: screenshots + console notes in this log.

## Findings log

(appended as the campaign runs)
