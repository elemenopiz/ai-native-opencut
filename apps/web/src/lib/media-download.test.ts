import { describe, expect, test } from "bun:test";
import { assetDownloadFilename } from "./media-download";

const file = (name: string, type: string) =>
	new File([new Uint8Array(4)], name, { type });

describe("assetDownloadFilename", () => {
	test("display name with an extension is used as-is", () => {
		expect(
			assetDownloadFilename({
				name: "beach-run.mp4",
				file: file("original.mov", "video/quicktime"),
			}),
		).toBe("beach-run.mp4");
	});

	test("extension-less display name borrows the file's extension", () => {
		expect(
			assetDownloadFilename({
				name: "Take 3",
				file: file("gen-88f2.mp4", "video/mp4"),
			}),
		).toBe("Take 3.mp4");
	});

	test("falls back to the MIME type when the file name has no extension", () => {
		expect(
			assetDownloadFilename({
				name: "Take 3",
				file: file("blob", "video/webm"),
			}),
		).toBe("Take 3.webm");
	});

	test("empty display name falls back to the file name", () => {
		expect(
			assetDownloadFilename({
				name: "  ",
				file: file("clip.wav", "audio/wav"),
			}),
		).toBe("clip.wav");
	});

	test("unknown MIME and no extensions anywhere → bare base name", () => {
		expect(
			assetDownloadFilename({
				name: "mystery",
				file: file("blob", "application/octet-stream"),
			}),
		).toBe("mystery");
	});
});
