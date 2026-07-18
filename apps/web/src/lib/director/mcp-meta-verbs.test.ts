import { describe, expect, it } from "bun:test";
import { toolCatalog, scopeForTool } from "./tool-catalog";
import type { DirectorApi } from "./director-api";

// Both verbs are self-contained read utilities that ignore the director arg.
// A minimal stub keeps the handler signature honest without a real DirectorApi.
const noDirector = null as unknown as DirectorApi;

function descriptor(name: string) {
	const tool = toolCatalog().find((t) => t.name === name);
	if (!tool) throw new Error(`missing catalog verb: ${name}`);
	return tool;
}

describe("readPlaybook verb", () => {
	it("returns the full body + title for a valid id", async () => {
		const result = await descriptor("readPlaybook").handler(noDirector, {
			id: "ugc-photo-prompts",
		});
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			id: "ugc-photo-prompts",
			title: "UGC-Style Photo Prompts",
		});
		expect(typeof (result.data as { content: string }).content).toBe("string");
		expect((result.data as { content: string }).content.length).toBeGreaterThan(
			0,
		);
	});

	it("resolves the video playbook too", async () => {
		const result = await descriptor("readPlaybook").handler(noDirector, {
			id: "ugc-video-prompts",
		});
		expect(result.ok).toBe(true);
		expect((result.data as { title: string }).title).toBe(
			"UGC-Style Video Prompts",
		);
	});

	it("returns ok:false listing valid ids for an unknown id", async () => {
		const result = await descriptor("readPlaybook").handler(noDirector, {
			id: "does-not-exist",
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("ugc-photo-prompts");
		expect(result.message).toContain("ugc-video-prompts");
		expect(result.data).toBeUndefined();
	});

	it("is a non-mutating read-scope verb with no delta", async () => {
		expect(descriptor("readPlaybook").mutating).toBe(false);
		expect(scopeForTool("readPlaybook")).toBe("reel:read");
		const result = await descriptor("readPlaybook").handler(noDirector, {
			id: "ugc-photo-prompts",
		});
		expect(result.delta).toBeUndefined();
	});
});

describe("reportLimitation verb", () => {
	it("echoes category + summary in data and is ok with no delta", async () => {
		const result = await descriptor("reportLimitation").handler(noDirector, {
			category: "missing-verb",
			summary: "needed a way to crossfade audio and had none",
		});
		expect(result.ok).toBe(true);
		expect(result.data).toEqual({
			category: "missing-verb",
			summary: "needed a way to crossfade audio and had none",
		});
		expect(result.delta).toBeUndefined();
	});

	it("is a non-mutating read-scope verb", () => {
		expect(descriptor("reportLimitation").mutating).toBe(false);
		expect(scopeForTool("reportLimitation")).toBe("reel:read");
	});
});

describe("both meta verbs are wired into the catalog", () => {
	it("appear exactly once in toolCatalog()", () => {
		const names = toolCatalog().map((t) => t.name);
		expect(names.filter((n) => n === "readPlaybook")).toHaveLength(1);
		expect(names.filter((n) => n === "reportLimitation")).toHaveLength(1);
	});
});
