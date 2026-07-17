# W-PROXY — Assets panel PREVIEW/PROXY/THUMBNAIL cluster hunt

Campaign C26 (dogfood hunt). Worker: W-PROXY. Branch: `task/c26-hunt-proxy`.
Read-only on product source -- this doc + screenshots + throwaway hunt
scripts under `apps/web/e2e/hunt/` are the only deliverables.

Driven via real Chrome (`channel: "chrome"`) against a manually-started
`NEXT_PUBLIC_E2E=1 PORT=3302` dev server, using
`apps/web/playwright.hunt-w2-proxy.config.ts` +
`apps/web/e2e/hunt/w-proxy-hunt.e2e.ts`. Real uploads via the actual
`Import` button -> native file chooser (not the E2E bridge), so the genuine
`processMediaAssets` ingest / proxy pipeline runs exactly as it would for a
paying user.

## Environment note (affects timing, not findings validity)

This Mac had 5 concurrent `next dev --turbopack` servers running across
different agent worktrees during this hunt (host contention). The first cold
compile of `/editor/[project_id]` (a very large route) took several minutes
longer than it would in isolation. This is noted so nobody misreads
dev-server compile latency as a product bug; it does not affect any finding
below, which are all about post-load runtime behavior.

## Matrix results

| Row | Scenario | Result | Notes |
|-----|----------|--------|-------|
| M9  | Thumbnails while proxy generating | TBD | |
| M10 | Failed proxy (corrupt-but-probeable, big-res) | TBD | |
| M11 | HDR HEVC 10-bit -- assets-side tile/preview/metadata | TBD | |
| M12 | Portrait 1080x1920 -- tile aspect/crop/hover/metadata | TBD | |
| M13 | Big file (400MB+) import | TBD | |
| M16 | Drag/insert onto timeline while proxy generating | TBD | |
| EXTRA | VFR-ish clip ingest | TBD | |
| EXTRA | Thumbnail persistence after reload | TBD | |

(Table filled in after the hunt scripts finish running.)

## Findings

(filled in below as the hunt progresses)
