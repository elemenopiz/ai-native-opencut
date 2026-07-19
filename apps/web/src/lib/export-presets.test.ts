import { describe, expect, test } from "bun:test";
import { createQueueItem, PLATFORM_PRESETS } from "./export-presets";

describe("PLATFORM_PRESETS — podcast-audio", () => {
	const podcast = PLATFORM_PRESETS.find((p) => p.id === "podcast-audio");

	test("exists and is flagged audioOnly", () => {
		expect(podcast).toBeDefined();
		expect(podcast?.audioOnly).toBe(true);
	});

	test("description no longer claims a bitrate the encoder doesn't produce", () => {
		// Previously: "Audio only, 320kbps" — pure fiction, since nothing in
		// the export pipeline ever encoded at 320kbps, and (combined with the
		// batch-export includeAudio bug) the preset produced a SILENT video,
		// the opposite of "audio only".
		expect(podcast?.description).not.toMatch(/320kbps/i);
	});

	test("every other preset is NOT audioOnly", () => {
		const others = PLATFORM_PRESETS.filter((p) => p.id !== "podcast-audio");
		expect(others.length).toBeGreaterThan(0);
		for (const preset of others) {
			expect(preset.audioOnly).not.toBe(true);
		}
	});
});

describe("createQueueItem", () => {
	test("carries the preset's audioOnly flag through into the queue item", () => {
		const podcast = PLATFORM_PRESETS.find((p) => p.id === "podcast-audio")!;
		const item = createQueueItem(podcast);
		expect(item.preset.audioOnly).toBe(true);
		expect(item.status).toBe("queued");
	});
});
