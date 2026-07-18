import { describe, expect, test } from "bun:test";
import {
	ensureVisualElementDefaults,
	isPlausibleTimelineElement,
	requiresMediaIdButMissing,
} from "../element-normalize";
import {
	DEFAULT_TEXT_BACKGROUND,
	DEFAULT_TEXT_ELEMENT,
} from "@/constants/text-constants";
import type { TextElement, TimelineElement } from "@/types/timeline";

/** A well-formed text element, as the UI's buildTextElement would produce. */
function completeTextElement(): TextElement {
	return {
		...DEFAULT_TEXT_ELEMENT,
		id: "text-1",
		blendMode: "normal",
	};
}

/** The malformed shape the perf audit's B1 crash was built from: a text
 *  element inserted through the public API with no background (nor the other
 *  optional-at-runtime text fields). */
function malformedTextElement(): TimelineElement {
	return {
		id: "text-broken",
		type: "text",
		name: "Fixture title",
		content: "AXIS-1 fixture project",
		duration: 5,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		fontSize: 64,
		fontFamily: "Inter",
		color: "#ffffff",
		textAlign: "center",
		fontWeight: "bold",
	} as unknown as TimelineElement;
}

describe("ensureVisualElementDefaults — text heal (B1 crash class)", () => {
	test("fills a missing background with DEFAULT_TEXT_BACKGROUND", () => {
		const healed = ensureVisualElementDefaults({
			element: malformedTextElement(),
		}) as TextElement;

		expect(healed.background).toEqual(DEFAULT_TEXT_BACKGROUND);
		// The exact reads that crashed the editor must now be defined:
		expect(healed.background.paddingX).toBe(DEFAULT_TEXT_BACKGROUND.paddingX);
		expect(healed.background.color).toBe(DEFAULT_TEXT_BACKGROUND.color);
	});

	test("fills the other missing required text fields", () => {
		const healed = ensureVisualElementDefaults({
			element: malformedTextElement(),
		}) as TextElement;

		expect(healed.fontStyle).toBe(DEFAULT_TEXT_ELEMENT.fontStyle);
		expect(healed.textDecoration).toBe(DEFAULT_TEXT_ELEMENT.textDecoration);
		// Provided fields are preserved:
		expect(healed.content).toBe("AXIS-1 fixture project");
		expect(healed.fontSize).toBe(64);
		expect(healed.fontFamily).toBe("Inter");
		expect(healed.fontWeight).toBe("bold");
	});

	test("still heals transform/opacity/blendMode on the same element", () => {
		const healed = ensureVisualElementDefaults({
			element: malformedTextElement(),
		}) as TextElement;

		expect(healed.transform).toBeDefined();
		expect(healed.transform.position).toEqual({ x: 0, y: 0 });
		expect(healed.opacity).toBeDefined();
		expect(healed.blendMode).toBeDefined();
	});

	test("merges a partial background over the defaults", () => {
		const element = {
			...malformedTextElement(),
			background: { enabled: true, color: "#ff0000" },
		} as unknown as TimelineElement;

		const healed = ensureVisualElementDefaults({ element }) as TextElement;

		expect(healed.background.enabled).toBe(true);
		expect(healed.background.color).toBe("#ff0000");
		expect(healed.background.paddingX).toBe(DEFAULT_TEXT_BACKGROUND.paddingX);
		expect(healed.background.paddingY).toBe(DEFAULT_TEXT_BACKGROUND.paddingY);
	});

	test("heals content to an empty string when missing", () => {
		const { content: _dropped, ...withoutContent } =
			malformedTextElement() as unknown as Record<string, unknown>;

		const healed = ensureVisualElementDefaults({
			element: withoutContent as unknown as TimelineElement,
		}) as TextElement;

		expect(healed.content).toBe("");
	});

	test("returns a complete text element unchanged (same reference)", () => {
		const element = completeTextElement();
		const healed = ensureVisualElementDefaults({ element });
		expect(healed).toBe(element);
	});

	test("leaves non-visual elements untouched (same reference)", () => {
		const audio = {
			id: "audio-1",
			type: "audio",
			name: "clip",
			startTime: 0,
			duration: 3,
			trimStart: 0,
			trimEnd: 0,
		} as unknown as TimelineElement;

		expect(ensureVisualElementDefaults({ element: audio })).toBe(audio);
	});
});

// BUG129 — structural gate ahead of ensureVisualElementDefaults: catches
// shapes that aren't "an element with missing fields" but aren't an element
// at all (null, id-less, type-less/unrecognized-type), which used to crash
// downstream id-keyed lookups and type switches on every load.
describe("isPlausibleTimelineElement — BUG129 structural gate", () => {
	test("rejects null and non-object values", () => {
		expect(isPlausibleTimelineElement(null)).toBe(false);
		expect(isPlausibleTimelineElement(undefined)).toBe(false);
		expect(isPlausibleTimelineElement("not an object")).toBe(false);
		expect(isPlausibleTimelineElement(42)).toBe(false);
	});

	test("rejects an element missing `id`", () => {
		expect(isPlausibleTimelineElement({ type: "video" })).toBe(false);
	});

	test("rejects an element with an empty-string `id`", () => {
		expect(isPlausibleTimelineElement({ id: "", type: "video" })).toBe(false);
	});

	test("rejects a non-string `type`", () => {
		expect(isPlausibleTimelineElement({ id: "el-1", type: 7 })).toBe(false);
	});

	test("rejects an unrecognized `type` string", () => {
		expect(isPlausibleTimelineElement({ id: "el-1", type: "hologram" })).toBe(
			false,
		);
	});

	test("accepts every known element type with a valid id", () => {
		for (const type of [
			"video",
			"image",
			"text",
			"audio",
			"sticker",
			"effect",
		]) {
			expect(isPlausibleTimelineElement({ id: "el-1", type })).toBe(true);
		}
	});
});

// BUG129 — a video/image/upload-audio element can never render without a
// resolvable mediaId; this only catches the structurally-absent case (see
// the function's doc comment for the full-orphan case, filed as BUG130).
describe("requiresMediaIdButMissing — BUG129 unrenderable-media gate", () => {
	test("flags a video element with no mediaId", () => {
		const el = { id: "v1", type: "video" } as unknown as TimelineElement;
		expect(requiresMediaIdButMissing(el)).toBe(true);
	});

	test("flags a video element with an empty-string mediaId", () => {
		const el = {
			id: "v1",
			type: "video",
			mediaId: "",
		} as unknown as TimelineElement;
		expect(requiresMediaIdButMissing(el)).toBe(true);
	});

	test("does not flag a video element with a mediaId", () => {
		const el = {
			id: "v1",
			type: "video",
			mediaId: "media-1",
		} as unknown as TimelineElement;
		expect(requiresMediaIdButMissing(el)).toBe(false);
	});

	test("flags an image element with no mediaId", () => {
		const el = { id: "i1", type: "image" } as unknown as TimelineElement;
		expect(requiresMediaIdButMissing(el)).toBe(true);
	});

	test("flags an upload audio element with no mediaId", () => {
		const el = {
			id: "a1",
			type: "audio",
			sourceType: "upload",
		} as unknown as TimelineElement;
		expect(requiresMediaIdButMissing(el)).toBe(true);
	});

	test("does not flag a library audio element with no mediaId (uses sourceUrl instead)", () => {
		const el = {
			id: "a1",
			type: "audio",
			sourceType: "library",
			sourceUrl: "https://example.com/s.mp3",
		} as unknown as TimelineElement;
		expect(requiresMediaIdButMissing(el)).toBe(false);
	});

	test("treats an audio element with a corrupt/missing sourceType as requiring mediaId", () => {
		const el = { id: "a1", type: "audio" } as unknown as TimelineElement;
		expect(requiresMediaIdButMissing(el)).toBe(true);
	});

	test("never flags text/sticker/effect elements (no mediaId concept)", () => {
		expect(
			requiresMediaIdButMissing({
				id: "t1",
				type: "text",
			} as unknown as TimelineElement),
		).toBe(false);
		expect(
			requiresMediaIdButMissing({
				id: "s1",
				type: "sticker",
			} as unknown as TimelineElement),
		).toBe(false);
		expect(
			requiresMediaIdButMissing({
				id: "e1",
				type: "effect",
			} as unknown as TimelineElement),
		).toBe(false);
	});
});
