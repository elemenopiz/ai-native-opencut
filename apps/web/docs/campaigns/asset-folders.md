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
| A store+commands | task/c33-folder-model | 2026-07-18 | — | — | sonnet, bg worktree |
| B panel UI | task/c33-folder-ui | 2026-07-18 | — | — | sonnet, bg worktree; frontend-design skill; owns own dev server :3210 |
| C folder upload | task/c33-folder-upload | 2026-07-18 | — | — | sonnet, bg worktree |

Integration order at return: A → C → B. B typecheck WILL show A/C-missing-import errors
until A+C merge — expected, reconciled at integration, not a B failure.

## Bugs filed (range BUG120–BUG124)

_none yet_

## Decisions log

- 2026-07-18: Folder list persists as `TProject.mediaFolders` via the `setDirectorBrief`
  markDirty→saveProject path; `folderId` additive on `MediaAssetData`. No migration, no new
  storage method — stays out of C28 (services/storage) and C27 (existing commands) territory.
