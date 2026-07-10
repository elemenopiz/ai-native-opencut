import { describe, expect, it } from "bun:test";
import {
	buildIntakeUserBlocks,
	parseReferenceDerivation,
	styleBibleToBriefLine,
	styleHasContent,
} from "./reference-intake";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("parseReferenceDerivation", () => {
	it("derives a StyleBible from a clean JSON reply (no persona for a mood board)", () => {
		const d = parseReferenceDerivation(
			JSON.stringify({
				style: {
					palette: "bleached teal + sun-faded orange",
					lensMood: "16mm grain, handheld, nostalgic",
					setting: "empty coastal boardwalk, golden hour",
				},
				summary: "a sun-bleached seaside film look",
			}),
			2,
		);
		expect(d.style).toEqual({
			palette: "bleached teal + sun-faded orange",
			lensMood: "16mm grain, handheld, nostalgic",
			setting: "empty coastal boardwalk, golden hour",
		});
		expect(d.persona).toBeUndefined();
		expect(d.summary).toBe("a sun-bleached seaside film look");
	});

	it("derives a persona (descriptor + clamped anchorIndex) from a character photo", () => {
		const d = parseReferenceDerivation(
			JSON.stringify({
				style: { lensMood: "soft studio portrait light" },
				persona: {
					name: "Mara",
					descriptor:
						"woman, early 30s, warm brown skin, tight dark curls, silver hoop earrings",
					anchorIndex: 9, // out of range → clamped to last valid index
				},
				summary: "a studio portrait of Mara",
			}),
			3,
		);
		expect(d.persona).toEqual({
			name: "Mara",
			descriptor:
				"woman, early 30s, warm brown skin, tight dark curls, silver hoop earrings",
			anchorIndex: 2, // clamped into [0, imageCount-1] = [0,2]
		});
		expect(d.style.lensMood).toBe("soft studio portrait light");
	});

	it("drops a persona that has no descriptor (a name alone is not lockable identity)", () => {
		const d = parseReferenceDerivation(
			JSON.stringify({
				style: { palette: "muted pastels" },
				persona: { name: "Someone", anchorIndex: 0 },
			}),
			1,
		);
		expect(d.persona).toBeUndefined();
		expect(d.style.palette).toBe("muted pastels");
	});

	it("tolerates a fenced code block and lens/mood/location synonyms", () => {
		const d = parseReferenceDerivation(
			"```json\n" +
				JSON.stringify({
					style: { lens: "anamorphic flare", location: "neon night market" },
				}) +
				"\n```",
			1,
		);
		expect(d.style.lensMood).toBe("anamorphic flare");
		expect(d.style.setting).toBe("neon night market");
	});

	it("fails SAFE on unparseable output — empty style, no persona, never fabricates", () => {
		const d = parseReferenceDerivation("sorry, I can't see any images", 2);
		expect(d.style).toEqual({});
		expect(d.persona).toBeUndefined();
		expect(styleHasContent(d.style)).toBe(false);
	});

	it("fails SAFE on malformed JSON", () => {
		const d = parseReferenceDerivation('{"style": {palette: unquoted}}', 1);
		expect(d.style).toEqual({});
		expect(d.persona).toBeUndefined();
	});

	it("clamps a negative / non-numeric anchorIndex to 0", () => {
		const base = { descriptor: "a person" };
		expect(
			parseReferenceDerivation(
				JSON.stringify({ persona: { ...base, anchorIndex: -4 } }),
				3,
			).persona?.anchorIndex,
		).toBe(0);
		expect(
			parseReferenceDerivation(
				JSON.stringify({ persona: { ...base, anchorIndex: "x" } }),
				3,
			).persona?.anchorIndex,
		).toBe(0);
	});
});

describe("styleHasContent / styleBibleToBriefLine", () => {
	it("reports content only when a field is set", () => {
		expect(styleHasContent({})).toBe(false);
		expect(styleHasContent({ palette: "  " })).toBe(false);
		expect(styleHasContent({ setting: "a rooftop" })).toBe(true);
		expect(
			styleHasContent({ characters: [{ name: "X", descriptor: "y" }] }),
		).toBe(true);
	});

	it("joins the derived look into one compact brief line", () => {
		expect(
			styleBibleToBriefLine({
				palette: "warm amber",
				lensMood: "anamorphic, dreamy",
				setting: "coffee farm at dawn",
			}),
		).toBe("warm amber; anamorphic, dreamy; coffee farm at dawn");
		expect(styleBibleToBriefLine({})).toBe("");
	});
});

describe("buildIntakeUserBlocks", () => {
	it("puts the hint first, then each decodable reference as an image block", () => {
		const blocks = buildIntakeUserBlocks([PNG, PNG], "match this grade");
		expect(blocks[0].type).toBe("text");
		expect((blocks[0] as { text: string }).text).toContain("match this grade");
		expect((blocks[0] as { text: string }).text).toContain("2 reference image");
		expect(blocks.slice(1).every((b) => b.type === "image")).toBe(true);
		expect(blocks).toHaveLength(3);
	});

	it("silently drops references that aren't decodable image data URLs", () => {
		const blocks = buildIntakeUserBlocks(
			[PNG, "https://example.com/not-a-data-url.png"],
			undefined,
		);
		// text block + only the one decodable image
		expect(blocks).toHaveLength(2);
		expect(blocks[1].type).toBe("image");
	});
});
