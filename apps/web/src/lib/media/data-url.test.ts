import { describe, expect, it } from "bun:test";
import { dataUrlToBlob, dataUrlToFile } from "@/lib/media/data-url";

// "Hi" base64-encoded.
const PNG = "data:image/png;base64,SGk=";
const JPG = "data:image/jpeg;base64,SGk=";

describe("dataUrlToBlob", () => {
	it("decodes the base64 payload with the declared MIME type", async () => {
		const blob = dataUrlToBlob(PNG);
		expect(blob.type).toBe("image/png");
		expect(await blob.text()).toBe("Hi");
	});

	it("rejects non-data URLs", () => {
		expect(() => dataUrlToBlob("https://example.com/x.png")).toThrow();
	});
});

describe("dataUrlToFile", () => {
	it("names the file with a png extension for image/png", () => {
		const file = dataUrlToFile(PNG, "shot — last frame");
		expect(file.type).toBe("image/png");
		expect(file.name).toBe("shot — last frame.png");
		expect(file.size).toBe(2);
	});

	it("uses a jpg extension for image/jpeg", () => {
		expect(dataUrlToFile(JPG, "clip").name).toBe("clip.jpg");
	});

	it("sanitizes path-hostile characters in the base name", () => {
		expect(dataUrlToFile(PNG, "a/b:c").name).toBe("a_b_c.png");
	});

	it("keeps an existing extension instead of doubling it", () => {
		expect(dataUrlToFile(PNG, "frame.png").name).toBe("frame.png");
	});
});
