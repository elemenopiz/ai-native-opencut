import { describe, expect, it } from "bun:test";
import { middleTruncate } from "./draggable-item";

describe("middleTruncate (BUG10: doubled asset-label fragments)", () => {
	it("returns a short name unchanged", () => {
		expect(middleTruncate("Title")).toBe("Title");
	});

	it("returns a 9-char preset name unchanged — no doubled fragment", () => {
		// The old logic rendered "Body Text" (9 chars) as "Body Text...ext":
		// slice(0, 16) already covered the whole name, then appended
		// "..." plus the name's own last 3 chars again.
		expect(middleTruncate("Body Text")).toBe("Body Text");
	});

	it("returns names in the previously-broken 9–19 char range unchanged", () => {
		expect(middleTruncate("Section Heading")).toBe("Section Heading");
		expect(middleTruncate("clip-take-02.mp4")).toBe("clip-take-02.mp4");
	});

	it("returns an exactly-20-char name unchanged (boundary: head + ellipsis + tail)", () => {
		const name = "abcdefghijklmnop.mov";
		expect(name).toHaveLength(20);
		expect(middleTruncate(name)).toBe(name);
	});

	it("middle-truncates a 21-char name (first length that truncates)", () => {
		const name = "abcdefghijklmnopq.mov";
		expect(name).toHaveLength(21);
		expect(middleTruncate(name)).toBe("abcdefghijklmnop...mov");
	});

	it("middle-truncates a long filename and keeps the extension visible", () => {
		const name = "holiday-beach-sunset-take-07.mp4";
		expect(middleTruncate(name)).toBe("holiday-beach-su...mp4");
	});

	it("respects custom head/tail widths", () => {
		expect(middleTruncate("holiday-beach-sunset.mp4", 8, 3)).toBe(
			"holiday-...mp4",
		);
		expect(middleTruncate("short.mp4", 8, 3)).toBe("short.mp4");
	});
});
