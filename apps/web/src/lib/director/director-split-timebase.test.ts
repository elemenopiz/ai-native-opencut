import { describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import { toolCatalog } from "./tool-catalog";

/**
 * The `split` verb's TIMEBASE contract.
 *
 * `split.atTime` is TIMELINE-ABSOLUTE; `getTranscript` reports ASSET-RELATIVE
 * seconds (the same timebase as `trim`'s trimStart/trimEnd). An agent that
 * reads a transcript and feeds the number straight to `atTime` used to cut in
 * the wrong place with nothing to warn it — the schema didn't say which
 * timebase it wanted, and an out-of-range `atTime` silently did nothing.
 *
 * Two defences are pinned here:
 *   1. `atSourceTime` converts an asset-relative number through the slot's own
 *      placement, so the agent never does the arithmetic.
 *   2. An `atTime` outside the slot's timeline span is REFUSED, with the valid
 *      window and the asset-relative reading of the number it was given.
 */

/** A slot showing source 4s–10s at timeline 10s–16s (offset +6). */
function trimmedSlotAt10() {
	const fake = makeFakeEditor();
	const d = createDirectorApi(fake.editor);
	const slotId = d.reserveSlot({ prompt: "talking head", duration: 10 }).data
		?.slotId as string;
	d.trim({ slotId, trimStart: 4, startTime: 10, duration: 6 });
	return { d, slotId };
}

function slotSpan(
	d: ReturnType<typeof createDirectorApi>,
	slotId: string,
): { start: number; duration: number } {
	const slot = d.getSlot(slotId).data as
		| { start: number; duration: number }
		| undefined;
	if (!slot) throw new Error(`slot ${slotId} vanished`);
	return { start: slot.start, duration: slot.duration };
}

describe("split — atSourceTime converts asset-relative seconds", () => {
	it("cuts at the TIMELINE point the transcript timestamp actually maps to", () => {
		const { d, slotId } = trimmedSlotAt10();
		// A transcript says the sentence ends at asset time 7s. On this clip
		// that is timeline 13s — not 7s.
		const res = d.split({ slotId, atSourceTime: 7 });

		expect(res.ok).toBe(true);
		expect(res.message).toContain("13.00s");
		// Left piece keeps its start and now ends at the cut.
		expect(slotSpan(d, slotId)).toEqual({ start: 10, duration: 3 });
		const rightId = (res.data?.newSlotIds ?? [])[0];
		expect(rightId).toBeDefined();
		expect(slotSpan(d, rightId)).toEqual({ start: 13, duration: 3 });
	});

	it("refuses an asset time that is trimmed off this slot", () => {
		const { d, slotId } = trimmedSlotAt10();
		// Asset 0s–4s is trimmed off the head, so there is nothing to cut there.
		const res = d.split({ slotId, atSourceTime: 2 });

		expect(res.ok).toBe(false);
		// The argument was right, so the message talks about the SOURCE window
		// rather than lecturing about timebases.
		expect(res.message).toContain("trimmed out of slot");
		expect(res.message).toContain("shows source 4.00s–10.00s");
		// The slot is untouched.
		expect(slotSpan(d, slotId)).toEqual({ start: 10, duration: 6 });
	});
});

describe("split — atTime is timeline-absolute and range-guarded", () => {
	it("cuts at a timeline point inside the slot", () => {
		const { d, slotId } = trimmedSlotAt10();
		const res = d.split({ slotId, atTime: 13 });

		expect(res.ok).toBe(true);
		expect(slotSpan(d, slotId)).toEqual({ start: 10, duration: 3 });
	});

	it("REGRESSION: a raw transcript timestamp in atTime is refused, not silently ignored", () => {
		const { d, slotId } = trimmedSlotAt10();
		// 7 is the asset-relative number an agent would read from getTranscript.
		// As a timeline time it falls before the slot entirely.
		const res = d.split({ slotId, atTime: 7 });

		expect(res.ok).toBe(false);
		// The error has to be self-correcting: valid window, the timebase rule,
		// and what the number means if it really was asset-relative.
		expect(res.message).toContain("10.00s–16.00s");
		expect(res.message).toContain("TIMELINE");
		expect(res.message).toContain("asset-relative");
		expect(res.message).toContain("atSourceTime");
		expect(res.message).toContain("13.00s");
		expect(slotSpan(d, slotId)).toEqual({ start: 10, duration: 6 });
	});

	it("refuses a point past the end of the slot", () => {
		const { d, slotId } = trimmedSlotAt10();
		const res = d.split({ slotId, atTime: 99 });
		expect(res.ok).toBe(false);
		expect(res.message).toContain("outside slot");
	});

	it("refuses a point exactly on either edge (a no-op cut)", () => {
		const { d, slotId } = trimmedSlotAt10();
		expect(d.split({ slotId, atTime: 10 }).ok).toBe(false);
		expect(d.split({ slotId, atTime: 16 }).ok).toBe(false);
		expect(slotSpan(d, slotId)).toEqual({ start: 10, duration: 6 });
	});

	it("asks for one of the two arguments when neither is given", () => {
		const { d, slotId } = trimmedSlotAt10();
		const res = d.split({ slotId });
		expect(res.ok).toBe(false);
		expect(res.message).toContain("atTime");
		expect(res.message).toContain("atSourceTime");
	});

	it("still reports a missing slot before any timebase complaint", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);
		const res = d.split({ slotId: "ghost", atTime: 3 });
		expect(res.ok).toBe(false);
		expect(res.code).toBe("SLOT_NOT_FOUND");
	});

	it("an untrimmed slot at timeline 0 behaves identically either way — the case that hid the bug", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);
		const a = d.reserveSlot({ prompt: "a", duration: 10 }).data
			?.slotId as string;
		const b = d.reserveSlot({ prompt: "b", duration: 10 }).data
			?.slotId as string;
		d.trim({ slotId: a, startTime: 0 });
		d.trim({ slotId: b, startTime: 0 });

		expect(d.split({ slotId: a, atTime: 4 }).ok).toBe(true);
		expect(d.split({ slotId: b, atSourceTime: 4 }).ok).toBe(true);
		expect(slotSpan(d, a)).toEqual(slotSpan(d, b));
	});
});

describe("split — catalog wiring", () => {
	const entry = toolCatalog().find((t) => t.name === "split");

	it("accepts either time argument and requires neither at the schema level", () => {
		expect(entry?.inputSchema.required).toEqual(["slotId"]);
		const props = entry?.inputSchema.properties ?? {};
		expect(props).toHaveProperty("atTime");
		expect(props).toHaveProperty("atSourceTime");
	});

	it("passes both through as undefined-when-unset, so the API can tell them apart", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const director = {
			split: (input: Record<string, unknown>) => {
				calls.push(input);
				return { ok: true, message: "ok" };
			},
		} as unknown as Parameters<NonNullable<typeof entry>["handler"]>[0];

		await entry?.handler(director, { slotId: "s1", atSourceTime: "7" });
		expect(calls[0]).toEqual({
			slotId: "s1",
			atTime: undefined,
			atSourceTime: 7,
		});

		await entry?.handler(director, { slotId: "s1", atTime: 0 });
		// 0 is a legitimate timeline time and must NOT be coerced away.
		expect(calls[1]).toEqual({
			slotId: "s1",
			atTime: 0,
			atSourceTime: undefined,
		});
	});
});
