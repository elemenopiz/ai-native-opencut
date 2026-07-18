# C33 — Asset folders (USER feature request F9)

**L1 orchestrator log.** Branch `campaign/asset-folders` (off `main` @29a06429). ID range
BUG120–BUG124. Territory: assets-panel folder UI, media/project folder fields, NEW
`lib/commands/media/*folder*` files, folder tests. OFF-LIMITS: existing command files (C27),
services/storage internals beyond additive persisted fields (C28), services/renderer, lib/mcp.

> Status tables record only what HAS happened. Pre-filling "done" is falsification.

## The ask (F9, feature-ideas.md)

Organize uploaded assets into folders in the Assets panel. Upload a whole folder of files at
once (preserving structure). Create folders manually to organize existing assets.

## Architecture decision (verified against current main)

**No server, no DB migration.** All client-side, persisted through the existing storage path:

- **Folder list = project metadata.** New `TProject.mediaFolders?: MediaFolder[]`. CRUD via the
  project manager mirroring the **`setDirectorBrief` idiom** (`project-manager.ts:676`): mutate
  `this.active`, `editor.save.markDirty()` (SaveManager → `storageService.saveProject`), `notify()`.
  This is the "existing storage path" — no new storage method, no migration, no C28 collision.
- **Folder membership = per-asset field.** New `folderId?: string` on `MediaAssetData`
  (`services/storage/types.ts`) — additive optional field, round-trips through the existing
  `saveMediaAsset`/`loadAllMediaAssets` JSON persistence exactly like `passthrough?`/`proxy?` did.
  `undefined`/absent ⇒ asset lives at root.
- **Undo = commands** per the `RemoveMediaAssetCommand` idiom (`lib/commands/media/remove-media-asset.ts`):
  snapshot state, mutate through manager APIs, persist fire-and-forget, restore verbatim on undo.
  ALL new command files are `*folder*`-named to avoid C27's in-flight sweep of existing files.

## FROZEN INTERFACE CONTRACT (all three workers code to this; do not renegotiate mid-flight)

```ts
// types — Worker A owns
export interface MediaFolder { id: string; name: string; parentId: string | null; } // null ⇒ top level
// MediaAssetData (services/storage/types.ts) gains, additively:  folderId?: string;  // absent ⇒ root

// EditorCore.project — Worker A (mirror getDirectorBrief/setDirectorBrief exactly)
editor.project.getMediaFolders(): MediaFolder[]                       // [] when unset/no active project
editor.project.setMediaFolders({ folders: MediaFolder[] }): void      // markDirty + notify

// EditorCore.media — Worker A (folderId already travels on getAssets() items)
editor.media.moveAssetToFolder({ projectId, assetId, folderId }: { projectId: string; assetId: string; folderId: string | null }): Promise<void>
// sets asset.folderId (null ⇒ delete field), persists via the existing updateMediaAsset/saveMediaAsset path, notifies

// Commands — Worker A (each ONE history entry; dispatch via editor.commands.execute)
new CreateFolderCommand(projectId: string, opts: { name: string; parentId: string | null }) // .getFolderId(): string
new RenameFolderCommand(projectId: string, folderId: string, name: string)
new DeleteFolderCommand(projectId: string, folderId: string)   // policy: NEVER cascade-delete assets.
    // member assets → root (folderId=undefined); child folders → reparent to deleted folder's parentId; fully reversible
new MoveAssetToFolderCommand(projectId: string, assetId: string, targetFolderId: string | null)
// all re-exported from "@/lib/commands/media"

// Folder-upload parsing — Worker C (pure, no React, no manager access)
// lib/media/folder-upload.ts
export type DroppedEntry = { file: File; path: string[] };  // path = folder segments only, filename excluded
export function filesFromDirectoryInput(files: FileList): DroppedEntry[]          // reads webkitRelativePath
export async function extractDroppedEntries(dataTransfer: DataTransfer): Promise<DroppedEntry[]>  // webkitGetAsEntry walk; falls back to flat files (path:[]) when the entries API is absent
// use-file-upload.ts (Worker C): add `directory?: boolean` (sets webkitdirectory on the input) + expose
//   `openDirectoryPicker()`, and surface dropped-folder entries so the panel can build folders + import per file.
```

## Partition (by file cluster — no two workers share a file)

| Worker | Model | Owned files | Verify |
|---|---|---|---|
| **A** store+commands | sonnet | `types/assets.ts`, `types/project.ts`, `services/storage/types.ts` (ADDITIVE `folderId` only), `core/managers/project-manager.ts`, `core/managers/media-manager.ts`, NEW `lib/commands/media/{create,rename,delete,move-asset-to}-folder-command.ts`, `lib/commands/media/index.ts` (additive exports), NEW `lib/commands/media/__tests__/*folder*.test.ts` | unit tests (command round-trips + folder store) |
| **B** panel UI | sonnet | `components/editor/panels/assets/views/assets.tsx`, `stores/assets-panel-store.tsx`, NEW `components/editor/panels/assets/views/folder-*.tsx` if needed | browser-verify (own dev server, port 3210) |
| **C** folder upload | sonnet | `hooks/use-file-upload.ts`, NEW `lib/media/folder-upload.ts`, NEW `lib/media/__tests__/folder-upload.test.ts` | unit tests (path parsing) |

Integration order: **A → C → B** (B consumes A's commands + C's parser). Interface contract is
frozen so all three build in parallel against the same signatures; drift fixed at integration.

Budget fallback (overrun): land **A + B manual folders first** (model + UI + move/create/rename/delete),
**C folder-upload second**.

## Verify plan (DoD tier: verified locally)

Browser-driven on the integrated branch (orchestrator does the final pass): create folders,
move assets in/out (context menu + drag onto tile), upload a real nested folder (structure
preserved as folders), delete a folder (assets survive at root), undo each op, drag an asset
out of a folder onto the timeline. Screenshots → `docs/campaigns/assets/asset-folders/`.
Gates: unit tests on commands + store green; `bun run typecheck` exit 0; lint no-worse
(~334e/224w); no new full-suite fails vs 2175/5/12.

## Worker roster & status (records only what HAS happened)

| Worker | Branch | Dispatched | Returned | Merged | Notes |
|---|---|---|---|---|---|
| A store+commands | task/c33-folder-model | 2026-07-18 | 2026-07-18 (parked on a typecheck monitor; complete uncommitted tree found in worktree, L1 reviewed + committed @5b771dda) | @14c8b85a | contract implemented exactly; 23 unit tests |
| B panel UI | task/c33-folder-ui | 2026-07-18 | 2026-07-18 @27f9d122 (self-committed) | @89287540 | +564/-4 assets.tsx, new folder-tile.tsx; reused existing tile card system |
| C folder upload | task/c33-folder-upload | 2026-07-18 | 2026-07-18 (parked likewise; tree reviewed + committed @f2017e84) | @6b611b46 | pure parser + additive hook surface; 10 unit tests |

Integration fixes by L1 (on-campaign): @128a5264 folder-upload type conflicts with lib.dom's
own `webkitRelativePath`/`webkitGetAsEntry` declarations (2 tsc errors from Worker C's local
re-declarations); @8784e984 BUG120 fix (below).

## Verification (tier: **verified locally**, 2026-07-18, real Chromium via Playwright, own dev server :3210 from the campaign worktree)

All driven on the integrated campaign tip; 12 screenshots in `assets/asset-folders/`:

1. **Create folder** (toolbar) → inline-rename engages pre-selected → Enter commits. ✓ (01)
2. **Move asset → folder** via context-menu "Move to folder" submenu (Root entry appears only
   when the asset is in a folder). ✓ (02) **Undo restores prior membership** — both directions
   (root→folder→undo, folder→root→undo). ✓
3. **Navigate**: folder tile click descends; breadcrumb `Root / …` climbs; type-filter counts
   scope to the open folder. ✓ (03, 10, 11)
4. **Drag-from-folder → timeline**: full HTML5 DnD (real drag-data MIME) drops a clip; ⌘Z
   removes it, asset unharmed in folder. ✓ (04)
5. **Rename + undo** ✓ (05); **create + undo** removes the folder ✓.
6. **Delete folder**: confirm copy states nothing inside is deleted; asset lands at Root;
   folder gone. ✓ (06) **Undo restores folder AND exact membership** ("1 asset"). ✓ (08)
7. **Folder upload** (real nested dir via webkitdirectory chooser):
   `TripFootage/{Day1/{2 png}, Day2/{sunset-drive.png, BRoll/street-detail.png}}` →
   structure preserved exactly, nothing flattened to root. ✓ (09–11)
8. **Drag asset onto folder tile** moves it (Day2 asset → BRoll, count "2 assets"); ⌘Z
   restores. ✓ (12)
9. **Persistence**: folder list + membership survived a full browser restart (07) — the
   `TProject.mediaFolders` + `MediaAssetData.folderId` round-trip is real, not in-memory.
10. **C26 regressions**: byte-identical re-import still fires the duplicate toast
    (MutationObserver-verified — the toast expires faster than tool round-trips, hence two
    earlier false-negative polls).

## Battery (integrated tip @8784e984)

- `bun run typecheck` exit 0 (verified unmasked).
- Folder unit tests: 23 (commands+store) + 10 (upload parser) = 33/33 pass.
- Full root `bun test`: **2200 pass / 5 skip / 12 fail** — fail count == the 12-fail
  baseline (no new fails; +33 new passing).
- Lint: 333e/226w on tip; **zero findings in any C33-touched file** (the two nearby findings
  — types/assets.ts noUnusedImports, types/version.ts format — pre-exist on main; count
  deltas vs moved-main are other campaigns' lint fixes landing there).

## Bugs filed (range BUG120–BUG124)

- **BUG120 — FIXED on campaign @8784e984**: folder context-menu "Rename" could never engage —
  Radix ContextMenu restores focus to the trigger on close, landing AFTER the inline rename
  input mounts+focuses; the input's `onBlur` commit fired instantly and edit mode closed.
  Fix (folder-tile.tsx, contained): `onCloseAutoFocus={preventDefault}` on both
  ContextMenuContent instances (idiom already global in ui/dropdown-menu.tsx but absent from
  ui/context-menu.tsx) + a focus retry at 80/250/450ms (Radix's restore can land post
  exit-animation). Browser-verified: input holds focus, Enter commits, ⌘Z undoes.
  NOTE for whoever owns `ui/context-menu.tsx`: the shared ContextMenuContent primitive lacks
  the onCloseAutoFocus guard that DropdownMenuContent has — any other context-menu-triggered
  inline edit will hit this same class of bug.
- BUG121–124: unused.

## Known limitations (recorded, not blockers)

- Folder tiles ignore the sort dropdown (render in creation order before assets) — matches
  file-browser convention but unspecced.
- "Move to folder" submenu lists ALL folders flat (no hierarchy indication) — fine at small
  folder counts; revisit if founders nest deeply.
- Folder-upload progress counts files, not bytes.

## Close-out

Feature complete per minimum-lovable scope (model + UI + manual folders + folder upload +
undo + drag-to-timeline). Branch `campaign/asset-folders`, tip @8784e984 (see log for merge
graph). NO migrations, NO new deps, NO pushes, NO merges to main — integration is L0's call.
Main moved during the campaign (C18 @82973ab9, C27 @796fc0ab — no assets-panel overlap per
L0 relay; re-run `git merge-tree` check at integration). Territory released.

## Decisions log

- 2026-07-18: Folder list persists as `TProject.mediaFolders` via the `setDirectorBrief`
  markDirty→saveProject path; `folderId` additive on `MediaAssetData`. No migration, no new
  storage method — stays out of C28 (services/storage) and C27 (existing commands) territory.
