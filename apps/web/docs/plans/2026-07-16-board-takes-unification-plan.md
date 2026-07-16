# Board/Takes Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Single generations (image or video) save straight to Assets; batches of 2+ land as drafts in Board, where the user stars winners into Assets. The flat "Takes" tab is deleted; the dead `boardItems` table/API becomes Board's data source.

**Architecture:** The generate-time caller (GenerationForm / ImagePanel) already knows the requested count before firing. Route each result on completion: count===1 → `addItemsToProjectMedia` (straight to Assets, as today for images); count>1 → POST to the existing `/api/studio/board` API (already fully implemented, just unread until now). `reel-board.tsx` is rewritten to read `GET /api/studio/board` instead of scanning the timeline (which only ever reflected the separate, still-untouched Director batch/slot flow). The flat Takes tab, its notification store, and `TakeCard` are deleted outright — their only consumer goes away with them.

**Tech Stack:** Next.js API routes, Drizzle/Postgres (`generationSets`/`takes`/`imageStills`/`boardItems` — no schema changes), Zustand, bun test.

**Design doc:** `apps/web/docs/plans/2026-07-16-board-takes-unification-design.md`

---

## Task 1: Video generation — auto-route on completion (single → Assets, batch → Board)

**Files:**
- Modify: `apps/web/src/hooks/use-studio-generation.ts`

**Step 1: Add the routing imports and extend the `generate` params type**

At the top of the file, add:

```ts
import type { EditorCore } from "@/core";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
```

In the `generate` field of `UseStudioGenerationReturn`, add three fields to the params object type: `editor: EditorCore`, `projectId: string`, `batchSize: number`.

**Step 2: Add a routing helper above `generate`**

Insert this function inside `useStudioGeneration`, above the `generate` `useCallback` definition:

```ts
// Routes one finished take: a lone result goes straight into the project's
// Assets library (no review step); a take from a 2+ batch is parked in the
// board's pending-review queue instead, so the user picks a winner there.
const routeCompletedTake = useCallback(
	async (args: {
		editor: EditorCore;
		projectId: string;
		batchSize: number;
		takeId: string;
		videoUrl: string;
		prompt: string;
	}) => {
		if (args.batchSize <= 1) {
			await addItemsToProjectMedia({
				editor: args.editor,
				projectId: args.projectId,
				items: [
					{
						url: args.videoUrl,
						name: args.prompt || "Generated take",
						kind: "video",
					},
				],
				source: "ai",
			});
			return;
		}
		await apiFetch("/api/studio/board", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ takeId: args.takeId }),
		});
	},
	[],
);
```

**Step 3: Wire the routing into both completion paths of `generate`**

`generate`'s body has two places a take reaches "done": the synchronous
`data.status === "completed"` branch, and the end of `pollJobToCompletion`.
Change `generate`'s signature to destructure `editor`, `projectId`,
`batchSize` out of its params, and call `routeCompletedTake` in both spots.

Replace:

```ts
				if (data.status === "completed") {
					setStatus("done");
					// Sync backends settle inline — refresh the header balance pill.
					void useCreditsStore.getState().refresh();
					return;
				}

				setStatus("polling");
				const outcome = await pollJobToCompletion(data.takeId, data.jobId);
				setStatus(outcome);
				// Async video settled/released on completion — refresh the balance.
				void useCreditsStore.getState().refresh();
```

with:

```ts
				if (data.status === "completed") {
					setStatus("done");
					if (data.videoUrl) {
						await routeCompletedTake({
							editor: params.editor,
							projectId: params.projectId,
							batchSize: params.batchSize,
							takeId: data.takeId,
							videoUrl: data.videoUrl,
							prompt: params.prompt,
						});
					}
					// Sync backends settle inline — refresh the header balance pill.
					void useCreditsStore.getState().refresh();
					return;
				}

				setStatus("polling");
				const outcome = await pollJobToCompletion(data.takeId, data.jobId);
				setStatus(outcome);
				if (outcome === "done") {
					const settled = activeTakesRef.current.find(
						(t) => t.takeId === data.takeId,
					);
					if (settled?.videoUrl) {
						await routeCompletedTake({
							editor: params.editor,
							projectId: params.projectId,
							batchSize: params.batchSize,
							takeId: data.takeId,
							videoUrl: settled.videoUrl,
							prompt: params.prompt,
						});
					}
				}
				// Async video settled/released on completion — refresh the balance.
				void useCreditsStore.getState().refresh();
```

`pollJobToCompletion` updates `activeTakes` via `setActiveTakes` but doesn't
return the resolved take's URL, so read it back off a ref. Add the ref near
the top of the hook (right after the `activeTakes` state declaration):

```ts
	const activeTakesRef = useRef<StudioTake[]>([]);
	useEffect(() => {
		activeTakesRef.current = activeTakes;
	}, [activeTakes]);
```

Add `useRef, useEffect` to the existing `react` import if not already there
(the file already imports `useCallback, useState` — add the other two).

Update `generate`'s `useCallback` dependency array to include
`routeCompletedTake`.

**Step 4: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: fails only on `generate.tsx` and `generation-form.tsx` call sites
(fixed in Task 2) — no errors inside `use-studio-generation.ts` itself.

**Step 5: Commit**

```bash
git add apps/web/src/hooks/use-studio-generation.ts
git commit -m "feat(studio): auto-route completed takes to Assets or Board by batch size"
```

---

## Task 2: Wire GenerationForm + GenerateView to the new routing

**Files:**
- Modify: `apps/web/src/components/editor/panels/assets/views/generate.tsx`
- Modify: `apps/web/src/components/studio/generation-form.tsx`

**Step 1: `generate.tsx` — inject editor/projectId, drop the Takes-tab notification effect**

Delete the whole notification `useEffect` block (the one calling
`setGenerating`/`setReady`/the "View in Takes" toast) and its supporting
imports/hooks:

```ts
	// Drive the Takes tab icon (left rail): fill it blue while a generation is
	// in flight, keep it blue once done so the user knows takes are waiting.
	const setGenerating = useTakesNotificationStore((s) => s.setGenerating);
	const setReady = useTakesNotificationStore((s) => s.setReady);
	const clearTakesNotification = useTakesNotificationStore((s) => s.clear);
	const setAssetsActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const wasBusy = useRef(false);
	useEffect(() => {
		if (busy && !wasBusy.current) setGenerating();
		else if (!busy && wasBusy.current) {
			setReady();
			// The ambient star-glow on the Takes tab (left rail) is easy to miss —
			// surface a toast that points at the SAME star so the two read as one
			// signal, with a one-click jump straight there.
			if (status === "done") {
				toast.success("Take ready", {
					description: "View it in Takes.",
					icon: (
						<HugeiconsIcon
							icon={StarIcon}
							className="size-4 fill-current text-blue-500"
						/>
					),
					action: {
						label: "View in Takes",
						onClick: () => {
							setAssetsActiveTab("starred");
							clearTakesNotification();
						},
					},
				});
			}
		}
		wasBusy.current = busy;
	}, [
		busy,
		status,
		setGenerating,
		setReady,
		clearTakesNotification,
		setAssetsActiveTab,
	]);
```

Remove now-unused imports: `useRef` (check it's not used elsewhere in the
file before deleting — it isn't), `useTakesNotificationStore`,
`useAssetsPanelStore`, `StarIcon`, `HugeiconsIcon` (check `Video02Icon` etc.
still need it from the same import — keep the import line, just drop
`StarIcon` from the destructured icon import list; `HugeiconsIcon` itself is
still used elsewhere in the file for the tab icons, so keep that import).

**Step 2: Add an editor/projectId-injecting wrapper around `generate`**

Replace:

```ts
export function GenerateView() {
	const { status, error, generate, clearError } = useStudioGeneration();

	const editor = useEditor();
	const [section, setSection] = useState("generate");
```

with:

```ts
export function GenerateView() {
	const { status, error, generate, clearError } = useStudioGeneration();

	const editor = useEditor();
	const [section, setSection] = useState("generate");

	// GenerationForm builds the generate params (including batchSize) but has
	// no reason to know about EditorCore/project id — inject them here so the
	// hook can route a finished take straight to Assets or to Board.
	const handleGenerate = useCallback(
		(params: Parameters<typeof generate>[0]) => {
			let projectId: string | null = null;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				projectId = null;
			}
			if (!projectId) {
				toast.error("No active project to add to.");
				return Promise.resolve();
			}
			return generate({ ...params, editor, projectId });
		},
		[editor, generate],
	);
```

Update the `<GenerationForm>` element:

```diff
-						<GenerationForm
-							onGenerate={generate}
+						<GenerationForm
+							onGenerate={handleGenerate}
```

`useCallback` is already imported in this file (used by
`handleGenerateMultiframe`) — no new import needed.

**Step 2: `generation-form.tsx` — thread batchSize, await the batch, fire one toast**

Update the `onGenerate` prop type (near the top of the file) to include
`batchSize` in its params object — it already accepts an object literal, so
just add the field to the existing type declaration:

```diff
 interface GenerationFormProps {
 	onGenerate: (params: {
 		prompt: string;
 		referenceImageUrl?: string;
 		referenceImages?: string[];
 		referenceVideos?: string[];
 		lastFrameUrl?: string;
 		seed?: number;
 		resolution: VideoResolution;
 		orientation: VideoOrientation;
 		duration: number;
 		mode: VideoMode;
 		personaId?: string;
 		consistencyMode?: "high" | "fast";
+		batchSize: number;
 	}) => Promise<void>;
```

(Check the exact remainder of the type below line 60 and add `batchSize`
there without disturbing the other fields — read the file around lines
51–75 first.)

Replace the "pin to board" / notification imports with a Board import:

```diff
-import { useAssetsPanelStore } from "@/stores/assets-panel-store";
-import { useTakesNotificationStore } from "@/stores/takes-notification-store";
+import { useBoardStore } from "@/stores/board-store";
```

(Only remove `useAssetsPanelStore`/`useTakesNotificationStore` if nothing
else in the file uses them — grep the file first: `grep -n
"useAssetsPanelStore\|useTakesNotificationStore" generation-form.tsx`. Given
`viewInTakes`/`clearTakesNotification` are the only other consumers and both
are being replaced in this task, they should be safe to remove.)

Replace `viewInTakes`:

```diff
-	const setAssetsActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
-	const clearTakesNotification = useTakesNotificationStore((s) => s.clear);
-	function viewInTakes() {
-		setAssetsActiveTab("starred");
-		clearTakesNotification();
-	}
+	function openBoard() {
+		useBoardStore.getState().setOpen(true);
+	}
```

Update the progress-bar link:

```diff
 							<button
 								type="button"
-								onClick={viewInTakes}
+								onClick={openBoard}
 								className="font-semibold text-foreground/80 transition-colors hover:text-foreground"
 							>
-								View in Takes →
+								Open Board →
 							</button>
```

Replace the fire-and-forget batch loop and add the batch-aware toast. Find:

```ts
		// Fire `count` variations at once. With no locked seed each picks its own
		// random seed server-side, so you get distinct takes.
		for (let i = 0; i < count; i++) onGenerate(params);
	}
```

Replace with:

```ts
		// Fire `count` variations at once. With no locked seed each picks its own
		// random seed server-side, so you get distinct takes. `batchSize` rides
		// along on every request so the hook can auto-route the result: straight
		// to Assets for a lone take, held in Board for a batch to pick from.
		const batchSize = count;
		const results = await Promise.allSettled(
			Array.from({ length: batchSize }, () =>
				onGenerate({ ...params, batchSize }),
			),
		);
		const succeeded = results.filter((r) => r.status === "fulfilled").length;
		if (succeeded === 0) return;
		if (batchSize === 1) {
			toast.success("Added to Assets.");
		} else {
			toast.success(
				`${succeeded} take${succeeded === 1 ? "" : "s"} ready — pick your favorite`,
				{
					action: {
						label: "Open Board",
						onClick: () => useBoardStore.getState().setOpen(true),
					},
				},
			);
		}
	}
```

**Step 3: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS (0 errors) — this closes out every call site touched by
Task 1's signature change.

**Step 4: Commit**

```bash
git add apps/web/src/components/editor/panels/assets/views/generate.tsx apps/web/src/components/studio/generation-form.tsx
git commit -m "feat(studio): route video generations to Assets/Board by batch size, drop Takes-tab toast"
```

---

## Task 3: Image generation — same auto-route rule

**Files:**
- Modify: `apps/web/src/components/studio/image-panel.tsx`

**Step 1: Read the current top of the file (imports, `GeneratedStill` type) and the full `handleGenerate` function before editing** — re-read
`apps/web/src/components/studio/image-panel.tsx` in full if it hasn't been
re-read this session, since only excerpts were seen during design.

**Step 2: Add a board-import path alongside `importStillsToAssets`**

Add near `importStillsToAssets`:

```ts
	// Multi-image batches don't land in Assets automatically — they're parked
	// in Board so the user can star a winner (single images skip this and
	// keep going straight to Assets, unchanged from before).
	async function importStillsToBoard(images: GeneratedStill[]) {
		await Promise.all(
			images.map((img) =>
				fetch("/api/studio/board", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ imageStillId: img.id }),
				}),
			),
		);
	}
```

Confirm `GeneratedStill` has an `id` field (it's inserted from
`imageStills` rows server-side in `/api/studio/image/route.ts` — check the
route's response mapping around `images: records.map((r) => ({ id: r.id,
... }))` seen earlier). If `GeneratedStill`'s type doesn't declare `id`,
add it.

**Step 3: Branch on `total` instead of always calling `importStillsToAssets`**

Find, inside the `chunks.map` callback:

```ts
						// Drop them into Assets as they arrive (fire-and-forget).
						void importStillsToAssets(data.images);
```

Replace with:

```ts
						// A lone image goes straight to Assets, as before. A batch (2+)
						// is held in Board instead — nothing is auto-saved until the
						// user stars a winner there.
						if (total === 1) {
							void importStillsToAssets(data.images);
						} else {
							void importStillsToBoard(data.images);
						}
```

**Step 4: Toast once after the whole batch settles**

The `Promise.all(chunks.map(...))` call is already `await`ed inside a
`try { ... } finally { setGenerating(false); ... }` block. Immediately after
that `await Promise.all(...)` call (still inside the `try`, before
`finally`), add:

```ts
				if (total > 1 && received > 0) {
					toast.success(
						`${received} image${received === 1 ? "" : "s"} ready — pick your favorite`,
						{
							action: {
								label: "Open Board",
								onClick: () => useBoardStore.getState().setOpen(true),
							},
						},
					);
				}
```

(`received` is already tracked in the surrounding closure — reuse it rather
than re-deriving a count. `toast` is already imported in this file.)

Add the import:

```ts
import { useBoardStore } from "@/stores/board-store";
```

**Step 5: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS

**Step 6: Manual sanity check of the branch logic**

Read back the edited `handleGenerate` function once fully and confirm: for
`total === 1` the behavior is byte-for-byte what it was before this task
(still auto-saves, still toasts via `importStillsToAssets`'s own
`"Added N images to Assets."` message — decide whether that message should
now say "Added to Assets." singular for `total===1`; if `importStillsToAssets`
already reads `added` off the actual save result, its message is fine as-is,
leave it).

**Step 7: Commit**

```bash
git add apps/web/src/components/studio/image-panel.tsx
git commit -m "feat(studio): hold multi-image batches in Board instead of auto-saving all to Assets"
```

---

## Task 4: `use-board-items.ts` — data hook for the pending-review queue

**Files:**
- Create: `apps/web/src/hooks/use-board-items.ts`

**Step 1: Write the hook**

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import type { EditorCore } from "@/core";
import { apiFetch } from "@/lib/auth/unauthorized";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import { waitForJobTerminal } from "@/stores/generation-status-store";

export interface BoardItem {
	id: string;
	kind: "take" | "image";
	takeId: string | null;
	imageStillId: string | null;
	notes: string | null;
	createdAt: string;
	take: {
		id: string;
		setId: string;
		seed: number | null;
		resolution: string;
		thumbnailUrl: string | null;
		videoUrl: string | null;
		status: string;
		errorMessage: string | null;
	} | null;
	set: { prompt: string; orientation: string } | null;
	image: {
		id: string;
		prompt: string;
		imageUrl: string | null;
		size: string;
	} | null;
}

/**
 * The Board's data source: everything currently parked in `boardItems`,
 * waiting for the user to star a winner into Assets or dismiss it. Deletes
 * items it currently holds are one-way — undoing a star means deleting the
 * asset normally afterward, not un-starring here (see the design doc).
 */
export function useBoardItems({
	editor,
	projectId,
}: {
	editor: EditorCore;
	projectId: string | null;
}) {
	const [items, setItems] = useState<BoardItem[]>([]);
	const [loading, setLoading] = useState(false);

	const refetch = useCallback(async () => {
		setLoading(true);
		try {
			const res = await apiFetch("/api/studio/board");
			if (!res.ok) return;
			const data = (await res.json()) as { items: BoardItem[] };
			setItems(data.items);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	// Promote a draft to Assets, then drop it from the pending queue.
	const promoteToAssets = useCallback(
		async (item: BoardItem) => {
			if (!projectId) return;
			const url =
				item.kind === "take" ? item.take?.videoUrl : item.image?.imageUrl;
			if (!url) return;
			const name =
				(item.kind === "take" ? item.set?.prompt : item.image?.prompt) ||
				"Generated";
			await addItemsToProjectMedia({
				editor,
				projectId,
				items: [{ url, name, kind: item.kind === "take" ? "video" : "image" }],
				source: "ai",
			});
			await apiFetch(`/api/studio/board?id=${item.id}`, { method: "DELETE" });
			await refetch();
		},
		[editor, projectId, refetch],
	);

	// Discard a draft without saving it anywhere.
	const dismiss = useCallback(
		async (item: BoardItem) => {
			await apiFetch(`/api/studio/board?id=${item.id}`, { method: "DELETE" });
			await refetch();
		},
		[refetch],
	);

	// Re-fire a video draft at 1080p, then swap the pin over to the new take
	// once it lands (the promote endpoint always creates a new take row under
	// the same generation set — it doesn't touch boardItems itself).
	const promoteTo1080p = useCallback(
		async (item: BoardItem) => {
			if (item.kind !== "take" || !item.takeId) return;
			const res = await apiFetch(`/api/studio/takes/${item.takeId}/promote`, {
				method: "POST",
			});
			if (!res.ok) return;
			const data = (await res.json()) as {
				takeId: string;
				jobId: string;
				status: string;
			};
			if (data.status !== "completed") {
				await waitForJobTerminal(data.jobId);
			}
			await apiFetch(`/api/studio/board?id=${item.id}`, { method: "DELETE" });
			await apiFetch("/api/studio/board", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ takeId: data.takeId }),
			});
			await refetch();
		},
		[refetch],
	);

	return { items, loading, refetch, promoteToAssets, dismiss, promoteTo1080p };
}
```

**Step 2: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS (this file has no consumers yet, so it can't break anything
— just needs to compile standalone).

**Step 3: Commit**

```bash
git add apps/web/src/hooks/use-board-items.ts
git commit -m "feat(studio): add use-board-items hook over the existing boardItems API"
```

---

## Task 5: Rewrite `reel-board.tsx` to render pending drafts

**Files:**
- Modify: `apps/web/src/components/editor/board/reel-board.tsx`

**Step 1: Replace the whole file**

```tsx
"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { useEffect } from "react";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { useBoardStore } from "@/stores/board-store";
import { useBoardItems, type BoardItem } from "@/hooks/use-board-items";

/**
 * Board — the single place batches of 2+ generations land for you to pick a
 * winner. A lone generation skips this entirely and goes straight to Assets;
 * this view only ever shows drafts still waiting on a decision.
 */
export function ReelBoard() {
	const open = useBoardStore((s) => s.open);
	const setOpen = useBoardStore((s) => s.setOpen);
	const editor = useEditor();

	let projectId: string | null = null;
	try {
		projectId = editor.project.getActive().metadata.id;
	} catch {
		projectId = null;
	}

	const { items, refetch, promoteToAssets, dismiss, promoteTo1080p } =
		useBoardItems({ editor, projectId });

	useEffect(() => {
		if (open) void refetch();
	}, [open, refetch]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, setOpen]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background/98 backdrop-blur">
			<div className="flex items-center gap-2 border-b px-4 py-2.5">
				<HugeiconsIcon icon={SparklesIcon} className="size-4 text-primary" />
				<span className="text-sm font-medium">Board</span>
				<span className="text-xs text-muted-foreground">
					{items.length} pending · star a winner to save it to Assets
				</span>
				<button
					type="button"
					aria-label="Close board"
					onClick={() => setOpen(false)}
					className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-4" />
					Close
				</button>
			</div>

			<div className="flex-1 overflow-y-auto p-5">
				{items.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Nothing pending — batches of 2+ generations land here for you to
						pick a winner.
					</div>
				) : (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
						{items.map((item) => (
							<DraftCard
								key={item.id}
								item={item}
								onStar={() => promoteToAssets(item)}
								onDismiss={() => dismiss(item)}
								onPromote={
									item.kind === "take" && item.take?.resolution !== "1080p"
										? () => promoteTo1080p(item)
										: undefined
								}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function DraftCard({
	item,
	onStar,
	onDismiss,
	onPromote,
}: {
	item: BoardItem;
	onStar: () => void;
	onDismiss: () => void;
	onPromote?: () => void;
}) {
	const url =
		item.kind === "take"
			? (item.take?.thumbnailUrl ?? item.take?.videoUrl)
			: item.image?.imageUrl;
	const isFailed = item.kind === "take" && item.take?.status === "error";
	const isPending =
		item.kind === "take" &&
		item.take?.status !== "error" &&
		!item.take?.videoUrl;
	const prompt =
		(item.kind === "take" ? item.set?.prompt : item.image?.prompt) ?? "";

	return (
		<div className="group relative aspect-video overflow-hidden rounded-lg border bg-muted">
			{url ? (
				item.kind === "take" ? (
					<video
						src={url}
						className="size-full object-cover"
						muted
						loop
						playsInline
					/>
				) : (
					<img src={url} alt="" className="size-full object-cover" />
				)
			) : (
				<div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
					{isFailed ? "Failed" : isPending ? "Generating…" : ""}
				</div>
			)}

			<button
				type="button"
				aria-label="Dismiss"
				onClick={onDismiss}
				className="absolute top-2 left-2 flex size-6 items-center justify-center rounded-full bg-black/50 text-white/70 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
			>
				<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
			</button>

			{url && (
				<div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2">
					<span className="min-w-0 flex-1 truncate text-[10px] text-white/80">
						{prompt}
					</span>
					<div className="flex shrink-0 gap-1">
						{onPromote && (
							<button
								type="button"
								onClick={onPromote}
								className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-white/25"
							>
								1080p
							</button>
						)}
						<button
							type="button"
							onClick={onStar}
							className={cn(
								"rounded px-1.5 py-0.5 text-[10px] font-medium",
								"bg-amber-400/90 text-black hover:bg-amber-400",
							)}
						>
							Star
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
```

**Step 2: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS. (`SlotEl`/`Take`/`VideoElement`/`ImageElement` types are no
longer imported here — confirm no other file imported anything from
`reel-board.tsx` itself before moving on: `grep -rn "from
\"@/components/editor/board/reel-board\"" apps/web/src` should show only
`apps/web/src/app/editor/[project_id]/page.tsx`, unchanged.)

**Step 3: Commit**

```bash
git add apps/web/src/components/editor/board/reel-board.tsx
git commit -m "feat(studio): rewrite Board to show pending drafts instead of scanning the timeline"
```

---

## Task 6: Delete the Takes tab and its dead-adjacent code

**Files:**
- Delete: `apps/web/src/components/editor/panels/assets/views/starred-takes.tsx`
- Delete: `apps/web/src/components/studio/take-card.tsx`
- Delete: `apps/web/src/stores/takes-notification-store.ts`
- Modify: `apps/web/src/stores/assets-panel-store.tsx`
- Modify: `apps/web/src/components/editor/panels/assets/index.tsx`
- Modify: `apps/web/src/components/editor/panels/assets/tabbar.tsx`

**Step 1: Confirm nothing else references these three files before deleting**

```bash
grep -rln "starred-takes\|take-card\|takes-notification-store" apps/web/src --include="*.ts*"
```

Expected matches (all get edited/deleted in this task): `starred-takes.tsx`
itself, `take-card.tsx` itself, `takes-notification-store.ts` itself,
`assets-panel-store.tsx` (no — that file doesn't import these; skip),
`index.tsx`, `tabbar.tsx`. If anything else shows up, stop and investigate
before deleting.

**Step 2: Delete the three files**

```bash
git rm apps/web/src/components/editor/panels/assets/views/starred-takes.tsx
git rm apps/web/src/components/studio/take-card.tsx
git rm apps/web/src/stores/takes-notification-store.ts
```

**Step 3: `assets-panel-store.tsx` — remove the "starred" tab**

Remove `"starred"` from `TAB_KEYS`:

```diff
 export const TAB_KEYS = [
 	"media",
 	"director",
-	"starred",
 	"text",
```

Remove the `starred` entry from the `tabs` object:

```diff
-	starred: {
-		icon: createHugeiconsIcon({ icon: StarIcon }),
-		label: "Takes",
-	},
 	text: {
```

Remove the now-unused `StarIcon` import if nothing else in the file uses it
(check first: `grep -n "StarIcon" assets-panel-store.tsx` — if the only
match is the import line and the deleted block, remove it from the
`@hugeicons/core-free-icons` import list).

**Step 4: `index.tsx` — remove the view mapping**

```diff
-import { StarredTakesView } from "./views/starred-takes";
```

```diff
 		director: <DirectorView />,
-		starred: <StarredTakesView />,
 		text: <TextView />,
```

**Step 5: `tabbar.tsx` — remove the Takes-tab notification icon logic**

Remove the notification-store import and its two hook calls:

```diff
-import {
-	type TakesNotificationStatus,
-	useTakesNotificationStore,
-} from "@/stores/takes-notification-store";
```

```diff
 	const { activeTab, setActiveTab } = useAssetsPanelStore();
 	const editor = useEditor();
-	const takesStatus = useTakesNotificationStore((s) => s.status);
-	const clearTakesNotification = useTakesNotificationStore((s) => s.clear);
 	const [showTopArrow, setShowTopArrow] = useState(false);
```

Remove the `isTakesTab` branch (keep `acceptsTakeDrop` — the media tab's
drag-a-take-to-save-it behavior is unrelated and still works: a take card no
longer exists to originate that drag from Board, but `handleTakeDrop` itself
is harmless dead code you can leave as-is since nothing regresses by keeping
it — do NOT remove `handleTakeDrop`/`acceptsTakeDrop` in this task, only the
Takes-tab-identity bits below):

```diff
-					const isTakesTab = tabKey === "starred";
 					return (
```

```diff
 									onClick={() => {
 										setActiveTab(tabKey);
-										if (isTakesTab) clearTakesNotification();
 									}}
```

```diff
-										{isTakesTab ? (
-											<TakesTabIcon status={takesStatus} />
-										) : (
-											<tab.icon />
-										)}
+										<tab.icon />
```

Also remove the comment right above (the one explaining `isTakesTab`) and,
further down the file, delete the whole `TakesTabIcon` function and the
`STAR_PATH` constant it uses (nothing else references either — confirm with
`grep -n "STAR_PATH\|TakesTabIcon" tabbar.tsx` before deleting, should only
be the definitions themselves).

**Step 6: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS

**Step 7: Lint**

Run: `cd apps/web && bun run lint`
Expected: PASS (biome will flag any leftover unused imports this task
missed — fix anything it reports)

**Step 8: Commit**

```bash
git add -A
git commit -m "feat(studio): remove the flat Takes tab, superseded by Board"
```

---

## Task 7: Repo-wide sweep for stragglers

**Files:** none known yet — this task is a search-and-fix pass.

**Step 1: Search for anything still referencing the removed surfaces**

```bash
grep -rn "starred-takes\|take-card\|takes-notification-store\|StarredTakesView\|TakeCard\b\|pinToBoard\|\"Pin to board\"" apps/web/src --include="*.ts*"
```

**Step 2: For each hit, fix in place**

Expected remaining hits and what to do:
- `use-studio-generation.ts` still exports `pinToBoard` (used internally by
  nothing now that `TakeCard` is gone, and Task 1 didn't route through it —
  it called the board POST directly). Remove the now-dead `pinToBoard`
  `useCallback` and drop it from `UseStudioGenerationReturn`'s return type
  and the returned object, unless something in Task 1/2 still calls it (it
  shouldn't — Task 1's `routeCompletedTake` posts to `/api/studio/board`
  directly, not via `pinToBoard`).
- Any test file mocking/importing the deleted modules — update or delete
  the test alongside its subject (check
  `apps/web/src/stores/__tests__/*.test.ts` and any `*.test.tsx` under
  `panels/assets` for references to `starred-takes`/`takes-notification-store`).

**Step 3: Typecheck + lint one more time**

```bash
cd apps/web && bun run typecheck && bun run lint
```
Expected: PASS on both.

**Step 4: Run the full test suite**

Run: `cd apps/web && bun test`
Expected: same 11 pre-existing failures as the baseline (proxy-encoder
worker-mocking tests + the route-protection classification test — all
unrelated to this feature, confirmed failing before this branch existed)
and otherwise 0 new failures. If anything beyond that baseline list fails,
stop and investigate before continuing.

**Step 5: Commit (only if Step 2 changed anything)**

```bash
git add -A
git commit -m "chore(studio): sweep dead references to the removed Takes tab"
```

---

## Task 8: Browser verification

**Step 1: Start the dev server for this worktree**

Use the `run` skill or `preview_start` pointed at this worktree's
`apps/web` (see `.claude/launch.json` conventions from prior sessions —
memory note `local_setup.md` documents a `--cwd` override pattern for
worktrees).

**Step 2: Drive the golden paths**

1. Generate 1 image (count=1 preset) → confirm it lands directly in the
   Assets tab with no Board involvement and a quiet "Added to Assets" toast.
2. Generate 3 images in one batch → confirm none land in Assets
   automatically, a toast appears ("3 images ready — pick your favorite")
   with an "Open Board" action, and clicking it opens Board showing all 3
   as pending drafts.
3. In Board, star one image → confirm it appears in Assets and disappears
   from Board; confirm the other two remain in Board untouched.
4. Dismiss one of the remaining Board drafts → confirm it disappears from
   Board and never appears in Assets.
5. Repeat steps 1–4 for video generation (1 take → Assets directly; 2+
   takes → Board; star/dismiss behave the same).
6. Confirm the "Takes" tab/icon is gone from the Assets panel's left rail
   entirely.
7. Confirm the editor header's "Board" toggle still opens/closes the same
   modal as before (unchanged entry point).

**Step 3: Report results**

Summarize pass/fail for each of the 7 checks above with a screenshot of the
Board grid mid-review (step 2/3) as evidence.

---

## Task 9: Wrap up

**Step 1: Update the design doc's status** (optional) — no action needed
unless verification in Task 8 surfaced a scoped-down deviation worth
recording.

**Step 2: Hand off via `finishing-a-development-branch`**

Once Task 8 passes, use the superpowers:finishing-a-development-branch
skill to decide how this branch (`feat/board-takes-unification`) integrates
back into `main` (merge, PR, or otherwise) — do not merge automatically
without walking through that skill's options with the user.
