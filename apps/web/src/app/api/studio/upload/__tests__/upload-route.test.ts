import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Size-cap coverage for the studio reference-upload route. The whole file is
 * buffered in memory before rehosting, so oversized uploads must be rejected
 * with 413 BEFORE the bytes are buffered:
 *   - reference images cap at 20 MB, reference videos at 100 MB;
 *   - an oversized content-length is rejected before the multipart body is
 *     even parsed.
 *
 * The route binds `auth` / media-storage at import time, so the mocks are
 * registered BEFORE the handler is dynamically imported (same pattern as
 * vc-routes.test.ts). `@/lib/studio/media-storage` is stubbed so no R2/cloud
 * config is needed and rehostToR2 throws if a cap check ever lets an
 * oversized file through.
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const state = {
	session: null as { user: { id: string } } | null,
	rehosted: 0,
};

mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/studio/media-storage", () => ({
	canRehost: () => true,
	rehostToR2: async () => {
		state.rehosted += 1;
		return "https://r2.example/ref/abc";
	},
}));

const { POST: uploadPOST } = await import("../route");

/** A real File whose reported size is spoofed so the tests never allocate
 *  hundreds of MB. arrayBuffer() stays tiny — the route must reject on the
 *  reported size before buffering matters. */
function fileOfSize(size: number, type: string): File {
	const file = new File([new Uint8Array(8)], "ref", { type });
	Object.defineProperty(file, "size", { value: size });
	return file;
}

function uploadRequest(file: File | null, headers = new Headers()) {
	const form = {
		get: (field: string) => (field === "file" ? file : null),
	};
	return {
		url: "http://localhost/api/studio/upload",
		headers,
		formData: async () => form,
	} as unknown as Request;
}

beforeEach(() => {
	state.session = { user: { id: `uploader-${Math.random()}` } };
	state.rehosted = 0;
});

describe("studio upload POST — per-kind size caps", () => {
	it("413s an oversized image (20 MB cap) without rehosting", async () => {
		const res = await uploadPOST(
			uploadRequest(fileOfSize(MAX_IMAGE_BYTES + 1, "image/png")),
		);
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string; maxBytes: number };
		expect(body.error).toBe("File too large");
		expect(body.maxBytes).toBe(MAX_IMAGE_BYTES);
		expect(state.rehosted).toBe(0);
	});

	it("413s an oversized video (100 MB cap) without rehosting", async () => {
		const res = await uploadPOST(
			uploadRequest(fileOfSize(MAX_VIDEO_BYTES + 1, "video/mp4")),
		);
		expect(res.status).toBe(413);
		const body = (await res.json()) as { maxBytes: number };
		expect(body.maxBytes).toBe(MAX_VIDEO_BYTES);
		expect(state.rehosted).toBe(0);
	});

	it("allows a video-sized image ONLY up to the image cap", async () => {
		// 50 MB image: under the video cap, over the image cap → still 413.
		const res = await uploadPOST(
			uploadRequest(fileOfSize(50 * 1024 * 1024, "image/png")),
		);
		expect(res.status).toBe(413);
		expect(state.rehosted).toBe(0);
	});

	it("413s (via content-length pre-check) before parsing the multipart body", async () => {
		const req = {
			url: "http://localhost/api/studio/upload",
			headers: new Headers({
				"content-length": String(MAX_VIDEO_BYTES + 10 * 1024 * 1024),
			}),
			formData: async () => {
				throw new Error("formData() must not be called past the pre-check");
			},
		} as unknown as Request;
		const res = await uploadPOST(req);
		expect(res.status).toBe(413);
	});

	it("rehosts a file under the cap", async () => {
		const res = await uploadPOST(uploadRequest(fileOfSize(1024, "image/png")));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { url: string; kind: string };
		expect(body.url).toBe("https://r2.example/ref/abc");
		expect(body.kind).toBe("image");
		expect(state.rehosted).toBe(1);
	});

	it("401s when unauthenticated", async () => {
		state.session = null;
		const res = await uploadPOST(uploadRequest(fileOfSize(1024, "image/png")));
		expect(res.status).toBe(401);
	});
});
