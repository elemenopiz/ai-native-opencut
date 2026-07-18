# W-FIX browser acceptance — BUG55 + BUG56 (campaign C26)

Run 2026-07-18 ~07:10 by the L1 against the campaign tip (@7b671e15 code) via
`apps/web/e2e/hunt/c26-fix.verify.ts`, real Chrome (`channel: "chrome"`), dev
server `NEXT_PUBLIC_E2E=1 PORT=3304` from the campaign worktree. Host load
average at run time: 3.46 (1-min) — quiet window after the fleet wave wound
down. First attempt earlier failed on the cold editor-route compile (goto
140s timeout); route warmed via curl (200 in 180s), second run completed.

| Scenario | Verdict | Evidence |
|---|---|---|
| S1 corrupt .mp4 not added (BUG55) | PASS | added=0; toast "Couldn't read a video track from w-fix-corrupt.mp4…"; zero pageErrors |
| S2 healthy H.264 unaffected | PASS | added=1 with `{duration:2, width:640, height:360}` |
| S3a duplicate across two uploads (BUG56) | PASS | added=2 (both copies kept); toast `"w-fix-dup-a.mp4" looks like a duplicate…imported anyway.` |
| S3b duplicate twice within ONE batch (BUG56) | PASS | added=2; duplicate toast seen |
| S4 clean upload → no false positive | PASS | added=1; zero duplicate toasts |

Console noise in all scenarios = the two known environmental patterns only
(8420 health-poll ERR_CONNECTION_REFUSED chore; anon-session 401s on
/api/studio/sets) — no new errors, no pageerrors.

Verdict lines are the script's own computed summary (assertions on E2E-bridge
asset store state + captured toast text), not hand-transcribed observations.
