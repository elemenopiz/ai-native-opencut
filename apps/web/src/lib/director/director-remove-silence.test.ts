/**
 * The `removeSilence` verb: catalog shape + handler arg-coercion/delegation.
 *
 * The analysis engine is NEVER called here — the handler is exercised against a
 * hand-rolled director stub whose `removeSilence` records its args, so this
 * tests the catalog wiring (schema, mutating flag, scope, coercion) in
 * isolation from the browser-bound engine. The apply layer's timeline math and
 * single-undo behavior are covered in `lib/auto-cut/apply.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import type { DirectorApi } from "./director-api";
import type { DirectorResult } from "./types";
import { scopeForTool, toolCatalog } from "./tool-catalog";

function catalogEntry(name: string) {
	return toolCatalog().find((t) => t.name === name);
}

describe("removeSilence catalog shape", () => {
	it("is a mutating, write-scoped verb requiring slotId", () => {
		const entry = catalogEntry("removeSilence");
		expect(entry).toBeDefined();
		expect(entry?.mutating).toBe(true);
		expect(scopeForTool("removeSilence")).toBe("reel:write");
		expect(entry?.inputSchema.required).toEqual(["slotId"]);
		// The optional knobs are all declared.
		const props = entry?.inputSchema.properties ?? {};
		for (const k of [
			"slotId",
			"threshold",
			"marginBefore",
			"marginAfter",
			"minKeep",
			"minCut",
		]) {
			expect(props).toHaveProperty(k);
		}
	});
});

describe("removeSilence handler delegation", () => {
	it("coerces args and delegates to director.removeSilence", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const director = {
			removeSilence: (input: Record<string, unknown>) => {
				calls.push(input);
				return {
					ok: true,
					message: "ok",
					data: { removedCount: 2, removedSeconds: 1.5, appliedAs: "cut" },
				} as DirectorResult<unknown>;
			},
		} as unknown as DirectorApi;

		const entry = catalogEntry("removeSilence");
		const res = await entry?.handler(director, {
			slotId: "s1",
			threshold: 0.05,
			marginBefore: 0.1,
			marginAfter: "0.4", // stringy number → coerced
			minKeep: 0.3,
			minCut: 0.5,
		});

		expect(res?.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			slotId: "s1",
			threshold: 0.05,
			marginBefore: 0.1,
			marginAfter: 0.4,
			minKeep: 0.3,
			minCut: 0.5,
		});
	});

	it("omits unset optional knobs (undefined, not 0) so engine defaults win", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const director = {
			removeSilence: (input: Record<string, unknown>) => {
				calls.push(input);
				return { ok: true, message: "ok" } as DirectorResult<unknown>;
			},
		} as unknown as DirectorApi;

		const entry = catalogEntry("removeSilence");
		await entry?.handler(director, { slotId: "s1" });

		expect(calls[0]).toEqual({
			slotId: "s1",
			threshold: undefined,
			marginBefore: undefined,
			marginAfter: undefined,
			minKeep: undefined,
			minCut: undefined,
		});
	});
});
