import { describe, expect, it } from "bun:test";
import { computeMediaIdentity, mediaSignature } from "./media-identity";

describe("computeMediaIdentity", () => {
	it("hashes identical bytes to the SAME sha256 identity (stable across re-import)", async () => {
		const bytes = new TextEncoder().encode("the same clip bytes");
		const a = await computeMediaIdentity(bytes);
		const b = await computeMediaIdentity(bytes.slice());
		expect(a).toBe(b);
		expect(a.startsWith("sha256:")).toBe(true);
	});

	it("gives DIFFERENT identities for different content", async () => {
		const a = await computeMediaIdentity(new TextEncoder().encode("clip A"));
		const b = await computeMediaIdentity(new TextEncoder().encode("clip B"));
		expect(a).not.toBe(b);
	});

	it("hashes a Blob and a matching byte array to the same identity", async () => {
		const text = "shared bytes";
		const fromBytes = await computeMediaIdentity(
			new TextEncoder().encode(text),
		);
		const fromBlob = await computeMediaIdentity(new Blob([text]));
		expect(fromBlob).toBe(fromBytes);
	});

	it("falls back to a namespaced signature for a bare metadata triple", async () => {
		const id = await computeMediaIdentity({
			name: "Hero.mp4",
			size: 1234,
			lastModified: 42,
		});
		expect(id).toBe("sig:hero.mp4:1234:42");
	});
});

describe("mediaSignature", () => {
	it("is stable and normalized (case-insensitive name)", () => {
		expect(
			mediaSignature({ name: "Clip.MP4", size: 10, lastModified: 5 }),
		).toBe("sig:clip.mp4:10:5");
	});
	it("tolerates missing metadata", () => {
		expect(mediaSignature({})).toBe("sig::0:0");
	});
});
