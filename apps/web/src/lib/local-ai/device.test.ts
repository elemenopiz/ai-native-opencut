import { describe, expect, it } from "bun:test";
import { isLocalAISupported, pickDevice } from "./device";

describe("pickDevice", () => {
	it("prefers webgpu when navigator.gpu exists", () => {
		expect(pickDevice({ gpu: {} } as unknown as Navigator)).toBe("webgpu");
	});

	it("falls back to wasm without navigator.gpu", () => {
		expect(pickDevice({} as Navigator)).toBe("wasm");
	});
});

describe("isLocalAISupported", () => {
	it("is false without a window (server-side)", () => {
		expect(isLocalAISupported({ Worker: class {} })).toBe(false);
	});

	it("is false in a window without Worker support", () => {
		expect(isLocalAISupported({ window: {} })).toBe(false);
	});

	it("is true with both window and Worker", () => {
		expect(isLocalAISupported({ window: {}, Worker: class {} })).toBe(true);
	});
});
