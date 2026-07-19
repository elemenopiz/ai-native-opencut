import { describe, expect, it } from "bun:test";
import { registerDefaultEffects } from "@/lib/effects";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";

/**
 * Structured recovery-error contract (poach plan item #1,
 * `docs/poach/vyra-poach-plan.md` §1): the highest-traffic NOT-FOUND lookup
 * paths (slot/effect/media, plus item via `updateText`) now return a
 * machine-readable `code` + `error` alongside the STILL-POPULATED `message`
 * (which additionally names the recovery verb), and — on a bad-enum lookup —
 * an `available` list of valid options. This file pins the new shape
 * additively: every assertion here is ADDITIONAL to what `message`/`ok`
 * already guaranteed, never a replacement.
 */

registerDefaultEffects();

describe("structured lookup-failure contract", () => {
	it("slot-not-found (getSlot): code, error, coaching message naming getReel()", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.getSlot("nonexistent_slot");

		expect(result.ok).toBe(false);
		expect(result.code).toBe("SLOT_NOT_FOUND");
		expect(result.error).toBe('No slot with id "nonexistent_slot".');
		// message is STILL populated (legacy {ok,message} consumers keep working)
		// and additionally names the recovery verb.
		expect(result.message).toBe(
			'No slot with id "nonexistent_slot". Use getReel() to see current slot ids.',
		);
		expect(result.message.startsWith(result.error as string)).toBe(true);
		expect(result.available).toBeUndefined();
	});

	it("slot-not-found is consistent across other findSlot-based verbs (setPrompt)", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.setPrompt({ slotId: "ghost_slot", prompt: "a shot" });

		expect(result.ok).toBe(false);
		expect(result.code).toBe("SLOT_NOT_FOUND");
		expect(result.error).toBe('No slot with id "ghost_slot".');
	});

	it("media-not-found (addClip): code, error, coaching message naming searchMedia()", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.addClip({ mediaId: "media_missing" });

		expect(result.ok).toBe(false);
		expect(result.code).toBe("MEDIA_NOT_FOUND");
		expect(result.error).toBe('No media asset with id "media_missing".');
		expect(result.message).toContain("searchMedia()");
		expect(result.available).toBeUndefined();
	});

	it("effect-not-found (applyEffect): code, error, and available inlines valid effect types", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);
		const shot = d.reserveSlot({ prompt: "shot", duration: 5 });
		const slotId = shot.data?.slotId as string;

		const result = d.applyEffect({
			slotId,
			effectType: "not-a-real-effect",
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("EFFECT_NOT_FOUND");
		expect(result.error).toBe('Unknown effect type "not-a-real-effect".');
		expect(result.message).toContain("getAllEffects()");
		expect(Array.isArray(result.available)).toBe(true);
		expect((result.available as string[]).length).toBeGreaterThan(0);
		// A real registered effect type shows up in the inlined list.
		expect(result.available).toContain("blur");
	});

	it("applyEffect on a missing slot returns SLOT_NOT_FOUND (not EFFECT_NOT_FOUND) — slot resolves first", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.applyEffect({
			slotId: "ghost_slot",
			effectType: "blur",
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("SLOT_NOT_FOUND");
	});

	it("item-not-found (updateText): code ITEM_NOT_FOUND, coaching message", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.updateText({
			elementId: "no_such_element",
			content: "hello",
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("ITEM_NOT_FOUND");
		expect(result.error).toBe('No element with id "no_such_element".');
		expect(result.message).toContain("getReel()");
	});

	it("a successful result carries no code/error/available (additive fields stay absent on success)", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.reserveSlot({ prompt: "a shot", duration: 5 });

		expect(result.ok).toBe(true);
		expect(result.code).toBeUndefined();
		expect(result.error).toBeUndefined();
		expect(result.available).toBeUndefined();
	});

	it("an UNCONVERTED failure path (legacy shape) still returns ok:false + populated message, no code", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		// storyboard requires >= 1 shot — a plain validation failure, not a
		// lookup, deliberately left on the legacy `fail()` shape.
		const result = d.storyboard({ shots: [] });

		expect(result.ok).toBe(false);
		expect(result.message.length).toBeGreaterThan(0);
		expect(result.code).toBeUndefined();
	});
});
