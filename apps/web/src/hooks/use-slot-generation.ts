"use client";

import { useCallback } from "react";
import { useEditor } from "@/hooks/use-editor";
import { generateTakeMedia } from "@/lib/studio/generate-take";
import { generateUUID } from "@/utils/id";
import type { GenerationSpec, TimelineElement } from "@/types/timeline";

/** A generative slot located on the timeline. */
interface SlotRef {
	elementId: string;
	spec: GenerationSpec;
}

/**
 * The generation orchestrator — turns a generation job into stacked **takes** on
 * a generative slot (Phase 1), and fans out across every slot in one shot
 * (Phase 4 "Generate all"). The provider pipeline itself lives in
 * `lib/studio/generate-take.ts` (shared with the Director's executor); this hook
 * owns the timeline/take bookkeeping.
 *
 * Per take: add a `queued` take → mark `generating` → run the shared engine →
 * patch to `ready`/`failed` → auto-select the slot's first ready take
 * (non-destructive; alternates are preserved).
 */
export function useSlotGeneration() {
	const editor = useEditor();

	const getActiveProjectId = useCallback((): string | null => {
		try {
			return editor.project.getActive().metadata.id;
		} catch {
			return null;
		}
	}, [editor]);

	/** Generate one take for a slot and fold the result into its `takes`.
	 *  Returns the take's id alongside whether it succeeded — callers running
	 *  many of these concurrently (Promise.all) need the id back to decide,
	 *  after everything settles, which take (if any) to auto-select. */
	const runOneTake = useCallback(
		async (params: {
			elementId: string;
			spec: GenerationSpec;
			projectId: string;
		}): Promise<{ takeId: string; success: boolean }> => {
			const { elementId, spec, projectId } = params;
			const takeId = generateUUID();
			editor.timeline.addTakeToElement({
				elementId,
				take: { id: takeId, status: "queued", spec, createdAt: Date.now() },
			});
			editor.timeline.updateTake({
				elementId,
				takeId,
				patch: { status: "generating" },
			});

			const result = await generateTakeMedia({ editor, projectId, spec });
			if (result.status === "failed") {
				editor.timeline.updateTake({
					elementId,
					takeId,
					patch: { status: "failed", error: result.error },
				});
				return { takeId, success: false };
			}

			editor.timeline.updateTake({
				elementId,
				takeId,
				patch: {
					status: "ready",
					mediaId: result.mediaId,
					thumbnailUrl: result.thumbnailUrl,
					seed: result.seed,
					provenance: result.provenance,
					cost: result.cost,
				},
			});
			return { takeId, success: true };
		},
		[editor],
	);

	/** True if the slot has no active take chosen yet. */
	const slotHasNoActiveTake = useCallback(
		(elementId: string): boolean => {
			const element = editor.timeline
				.getTracks()
				.flatMap((track) => track.elements as TimelineElement[])
				.find((el) => el.id === elementId);
			const generative = element as { activeTakeId?: string } | undefined;
			return !generative?.activeTakeId;
		},
		[editor],
	);

	/** Generate `alternatives` takes for a single slot. */
	const generateIntoSlot = useCallback(
		async (params: {
			elementId: string;
			spec: GenerationSpec;
			alternatives?: number;
		}): Promise<{ ok: number; failed: number }> => {
			const projectId = getActiveProjectId();
			if (!projectId) return { ok: 0, failed: 0 };
			const n = Math.max(1, params.alternatives ?? 1);

			// Run every take concurrently — none of them auto-select on their own
			// anymore, since with all takes racing there's no meaningful "first"
			// until they've all settled.
			const results = await Promise.all(
				Array.from({ length: n }, () =>
					runOneTake({
						elementId: params.elementId,
						spec: params.spec,
						projectId,
					}),
				),
			);

			const ok = results.filter((r) => r.success).length;
			const failed = results.length - ok;

			// Auto-select the first successful take, in original request order, so
			// the slot fills immediately — mirrors the previous "first success
			// becomes the active take" behavior, but only if nothing is active yet
			// (e.g. a prior generation already filled this slot).
			if (slotHasNoActiveTake(params.elementId)) {
				const firstSuccess = results.find((r) => r.success);
				if (firstSuccess) {
					editor.timeline.selectTake({
						elementId: params.elementId,
						takeId: firstSuccess.takeId,
					});
				}
			}

			return { ok, failed };
		},
		[getActiveProjectId, runOneTake, slotHasNoActiveTake, editor],
	);

	/** Collect every generative slot on the timeline that has a prompt. */
	const listPromptedSlots = useCallback((): SlotRef[] => {
		const slots: SlotRef[] = [];
		for (const track of editor.timeline.getTracks()) {
			for (const el of track.elements as TimelineElement[]) {
				if (
					(el.type === "video" || el.type === "image") &&
					el.generation &&
					el.generation.prompt?.trim()
				) {
					slots.push({ elementId: el.id, spec: el.generation });
				}
			}
		}
		return slots;
	}, [editor]);

	/** Phase 4 — generate every prompted slot at once, `alternatives` each. */
	const generateAllSlots = useCallback(
		async (params: {
			alternatives?: number;
		}): Promise<{ slots: number; ok: number; failed: number }> => {
			const slots = listPromptedSlots();
			const results = await Promise.all(
				slots.map((slot) =>
					generateIntoSlot({
						elementId: slot.elementId,
						spec: slot.spec,
						alternatives: params.alternatives,
					}),
				),
			);
			const { ok, failed } = results.reduce(
				(acc, r) => ({ ok: acc.ok + r.ok, failed: acc.failed + r.failed }),
				{ ok: 0, failed: 0 },
			);
			return { slots: slots.length, ok, failed };
		},
		[listPromptedSlots, generateIntoSlot],
	);

	return {
		generateIntoSlot,
		generateAllSlots,
		listPromptedSlots,
	};
}
