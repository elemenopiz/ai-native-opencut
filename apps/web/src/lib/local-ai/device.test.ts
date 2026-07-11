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
	it("requires Worker support", () => {
		expect(typeof isLocalAISupported()).toBe("boolean");
	});
});
