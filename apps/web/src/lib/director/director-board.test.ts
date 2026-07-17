/**
 * Coverage for the Board verbs (`getBoard`/`promoteBoardItem`/
 * `discardBoardItem`) — the read/star/dismiss surface over the pending
 * multi-take/-image drafts a generation batch parks on the Board (see
 * `apps/web/src/hooks/use-board-items.ts`).
 *
 * Two invariants matter, mirroring the rest of the catalog's contract:
 *  1. Every path is GUARDED — a missing/malformed `itemId`, or the injected
 *     `board` deps being absent entirely (a server-side / MCP context with no
 *     browser wiring), returns a graceful `{ ok: false, message }` and NEVER
 *     throws a raw TypeError (the bug class BUG13 is sweeping for).
 *  2. The catalog descriptors are registered with valid draft-07 schemas and
 *     the correct `mutating` flag (read for getBoard, write for the other
 *     two), and their handlers perform the SAME arg-coercion + single-verb
 *     dispatch every other catalog handler does.
 */
import { describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import { scopeForTool, toolCatalog } from "./tool-catalog";
import type { BoardItemSnapshot, BoardMutationResult } from "./types";

function fakeBoardItems(): BoardItemSnapshot[] {
	return [
		{
			id: "b1",
			kind: "take",
			status: "ready",
			prompt: "a boat at sunset",
			resolution: "720p",
			createdAt: "2026-07-17T00:00:00.000Z",
		},
		// A minimal item — no status/prompt/resolution/notes — to exercise the
		// "omit null/absent fields" convention.
		{
			id: "b2",
			kind: "image",
			createdAt: "2026-07-17T00:05:00.000Z",
		},
	];
}

// ── getBoard (verb level) ────────────────────────────────────────────────────

describe("director getBoard", () => {
	it("returns the injected board's pending items", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { fetch: async () => fakeBoardItems() },
		});
		const result = await director.getBoard();
		expect(result.ok).toBe(true);
		expect(result.data).toEqual(fakeBoardItems());
		expect(result.message).toContain("2 pending Board item(s)");
	});

	it("reports an empty board distinctly from an unavailable one", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { fetch: async () => [] },
		});
		const result = await director.getBoard();
		expect(result.ok).toBe(true);
		expect(result.data).toEqual([]);
		expect(result.message).toBe("Board is empty — no pending drafts.");
	});

	it("fails gracefully (never throws) when board.fetch is not wired", async () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		const result = await director.getBoard();
		expect(result.ok).toBe(false);
		expect(result.message).toBe("Board is unavailable in this context.");
	});

	it("fails gracefully when the injected fetch rejects", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				fetch: async () => {
					throw new Error("network down");
				},
			},
		});
		const result = await director.getBoard();
		expect(result.ok).toBe(false);
		expect(result.message).toContain("network down");
	});
});

// ── promoteBoardItem (verb level) ───────────────────────────────────────────

describe("director promoteBoardItem", () => {
	it("stars a resolved item via the injected promote fn", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				promote: async (itemId): Promise<BoardMutationResult> => {
					expect(itemId).toBe("b1");
					return { ok: true };
				},
			},
		});
		const result = await director.promoteBoardItem({ itemId: "b1" });
		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ itemId: "b1" });
		expect(result.message).toContain("b1");
	});

	it("surfaces the injected promote fn's error message on a resolved failure", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				promote: async () => ({
					ok: false,
					error: 'Board item "missing" not found.',
				}),
			},
		});
		const result = await director.promoteBoardItem({ itemId: "missing" });
		expect(result.ok).toBe(false);
		expect(result.message).toBe('Board item "missing" not found.');
	});

	it("rejects an empty-object arg without throwing", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { promote: async () => ({ ok: true }) },
		});
		const result = await director.promoteBoardItem(
			{} as unknown as { itemId: string },
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("itemId");
	});

	it("rejects a non-string itemId without throwing", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { promote: async () => ({ ok: true }) },
		});
		const result = await director.promoteBoardItem({
			itemId: 42,
		} as unknown as { itemId: string });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("itemId");
	});

	it("rejects a blank itemId without throwing", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { promote: async () => ({ ok: true }) },
		});
		const result = await director.promoteBoardItem({ itemId: "   " });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("itemId");
	});

	it("fails gracefully when board.promote is not wired", async () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		const result = await director.promoteBoardItem({ itemId: "b1" });
		expect(result.ok).toBe(false);
		expect(result.message).toBe("Board is unavailable in this context.");
	});

	it("fails gracefully when the injected promote fn rejects", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				promote: async () => {
					throw new Error("save failed");
				},
			},
		});
		const result = await director.promoteBoardItem({ itemId: "b1" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("save failed");
	});
});

// ── discardBoardItem (verb level) ───────────────────────────────────────────

describe("director discardBoardItem", () => {
	it("dismisses a resolved item via the injected discard fn", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				discard: async (itemId): Promise<BoardMutationResult> => {
					expect(itemId).toBe("b2");
					return { ok: true };
				},
			},
		});
		const result = await director.discardBoardItem({ itemId: "b2" });
		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ itemId: "b2" });
	});

	it("surfaces the injected discard fn's error message on a resolved failure", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				discard: async () => ({ ok: false, error: "Board item not found" }),
			},
		});
		const result = await director.discardBoardItem({ itemId: "missing" });
		expect(result.ok).toBe(false);
		expect(result.message).toBe("Board item not found");
	});

	it("rejects a missing itemId without throwing", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { discard: async () => ({ ok: true }) },
		});
		const result = await director.discardBoardItem(
			{} as unknown as { itemId: string },
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("itemId");
	});

	it("fails gracefully when board.discard is not wired", async () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		const result = await director.discardBoardItem({ itemId: "b1" });
		expect(result.ok).toBe(false);
		expect(result.message).toBe("Board is unavailable in this context.");
	});
});

// ── tool-catalog wiring ──────────────────────────────────────────────────────

describe("board tool-catalog wiring", () => {
	it("registers getBoard as read-only with a valid empty draft-07 schema", () => {
		const entry = toolCatalog().find((t) => t.name === "getBoard");
		expect(entry).toBeDefined();
		expect(entry?.mutating).toBe(false);
		expect(entry?.inputSchema.type).toBe("object");
		expect(scopeForTool("getBoard")).toBe("reel:read");
	});

	it("registers promoteBoardItem/discardBoardItem as mutating with a required itemId schema", () => {
		for (const name of ["promoteBoardItem", "discardBoardItem"]) {
			const entry = toolCatalog().find((t) => t.name === name);
			expect(entry, `${name} missing from catalog`).toBeDefined();
			expect(entry?.mutating).toBe(true);
			expect(entry?.inputSchema.type).toBe("object");
			expect(entry?.inputSchema.required).toEqual(["itemId"]);
			expect(entry?.inputSchema.properties?.itemId?.type).toBe("string");
			expect(scopeForTool(name)).toBe("reel:write");
		}
	});

	it("getBoard handler round-trips through the injected fetch", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { fetch: async () => fakeBoardItems() },
		});
		const entry = toolCatalog().find((t) => t.name === "getBoard");
		const result = await entry?.handler(director, {});
		expect(result?.ok).toBe(true);
		expect(result?.data).toEqual(fakeBoardItems());
	});

	it("promoteBoardItem handler coerces itemId and routes to director.promoteBoardItem", async () => {
		let receivedId: string | undefined;
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				promote: async (itemId) => {
					receivedId = itemId;
					return { ok: true };
				},
			},
		});
		const entry = toolCatalog().find((t) => t.name === "promoteBoardItem");
		const result = await entry?.handler(director, { itemId: "b1" });
		expect(result?.ok).toBe(true);
		expect(receivedId).toBe("b1");
	});

	it("promoteBoardItem handler coerces a missing itemId to a graceful failure, not a throw", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { promote: async () => ({ ok: true }) },
		});
		const entry = toolCatalog().find((t) => t.name === "promoteBoardItem");
		const result = await entry?.handler(director, {});
		expect(result?.ok).toBe(false);
	});

	it("discardBoardItem handler coerces itemId and routes to director.discardBoardItem", async () => {
		let receivedId: string | undefined;
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: {
				discard: async (itemId) => {
					receivedId = itemId;
					return { ok: true };
				},
			},
		});
		const entry = toolCatalog().find((t) => t.name === "discardBoardItem");
		const result = await entry?.handler(director, { itemId: "b2" });
		expect(result?.ok).toBe(true);
		expect(receivedId).toBe("b2");
	});

	it("discardBoardItem handler coerces an empty-object arg to a graceful failure, not a throw", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			board: { discard: async () => ({ ok: true }) },
		});
		const entry = toolCatalog().find((t) => t.name === "discardBoardItem");
		const result = await entry?.handler(director, {});
		expect(result?.ok).toBe(false);
	});

	it("deps-not-injected: all three catalog handlers fail gracefully rather than throw", async () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		const getBoardEntry = toolCatalog().find((t) => t.name === "getBoard");
		const promoteEntry = toolCatalog().find(
			(t) => t.name === "promoteBoardItem",
		);
		const discardEntry = toolCatalog().find(
			(t) => t.name === "discardBoardItem",
		);

		const r1 = await getBoardEntry?.handler(director, {});
		const r2 = await promoteEntry?.handler(director, { itemId: "b1" });
		const r3 = await discardEntry?.handler(director, { itemId: "b1" });
		expect(r1?.ok).toBe(false);
		expect(r2?.ok).toBe(false);
		expect(r3?.ok).toBe(false);
	});
});
