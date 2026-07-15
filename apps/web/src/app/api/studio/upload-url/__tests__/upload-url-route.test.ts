import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Coverage for the presigned direct-to-R2 upload route — mirrors
 * `../../upload/__tests__/upload-route.test.ts`'s mocking pattern (mocks
 * registered before the handler is dynamically imported). This route never
 * touches file bytes, so the request body is always tiny JSON
 * (`{ mimeType, sizeBytes }`) — it only mints a presigned URL.
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const state = {
	session: null as { user: { id: string } } | null,
	rehostConfigured: true,
	presigned: 0,
};

mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/studio/media-storage", () => ({
	canRehost: () => state.rehostConfigured,
	presignDirectUpload: async (ownerId: string) => {
		state.presigned += 1;
		return {
			uploadUrl: `https://r2.example/presigned-put/${ownerId}`,
			publicUrl: `https://r2.example/refs/${ownerId}/abc`,
		};
	},
	MAX_REFERENCE_IMAGE_BYTES: MAX_IMAGE_BYTES,
	MAX_REFERENCE_VIDEO_BYTES: MAX_VIDEO_BYTES,
}));

const { POST: uploadUrlPOST } = await import("../route");

function presignRequest(body: unknown) {
	return {
		json: async () => body,
	} as unknown as Request;
}

beforeEach(() => {
	state.session = { user: { id: `uploader-${Math.random()}` } };
	state.rehostConfigured = true;
	state.presigned = 0;
});

describe("studio upload-url POST — presigned direct upload", () => {
	it("mints a presigned URL for a valid video request", async () => {
		const res = await uploadUrlPOST(
			presignRequest({
				mimeType: "video/quicktime",
				sizeBytes: 20 * 1024 * 1024,
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			available: boolean;
			uploadUrl: string;
			publicUrl: string;
			kind: string;
		};
		expect(body.available).toBe(true);
		expect(body.kind).toBe("video");
		expect(body.uploadUrl).toContain("presigned-put");
		expect(state.presigned).toBe(1);
	});

	it("413s an oversized video without presigning", async () => {
		const res = await uploadUrlPOST(
			presignRequest({
				mimeType: "video/quicktime",
				sizeBytes: MAX_VIDEO_BYTES + 1,
			}),
		);
		expect(res.status).toBe(413);
		const body = (await res.json()) as { maxBytes: number };
		expect(body.maxBytes).toBe(MAX_VIDEO_BYTES);
		expect(state.presigned).toBe(0);
	});

	it("413s an oversized image against the (lower) image cap", async () => {
		const res = await uploadUrlPOST(
			presignRequest({ mimeType: "image/png", sizeBytes: MAX_IMAGE_BYTES + 1 }),
		);
		expect(res.status).toBe(413);
		expect(state.presigned).toBe(0);
	});

	it("rejects an unsupported mime type", async () => {
		const res = await uploadUrlPOST(
			presignRequest({ mimeType: "application/pdf", sizeBytes: 1024 }),
		);
		expect(res.status).toBe(400);
		expect(state.presigned).toBe(0);
	});

	it("400s a malformed body", async () => {
		const res = await uploadUrlPOST(presignRequest({ mimeType: "video/mp4" }));
		expect(res.status).toBe(400);
	});

	it("returns available:false (not an error) when cloud storage isn't configured", async () => {
		state.rehostConfigured = false;
		const res = await uploadUrlPOST(
			presignRequest({ mimeType: "image/png", sizeBytes: 1024 }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { available: boolean };
		expect(body.available).toBe(false);
		expect(state.presigned).toBe(0);
	});

	it("401s when unauthenticated", async () => {
		state.session = null;
		const res = await uploadUrlPOST(
			presignRequest({ mimeType: "image/png", sizeBytes: 1024 }),
		);
		expect(res.status).toBe(401);
	});
});
