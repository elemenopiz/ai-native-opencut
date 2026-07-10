import { chromium } from "@playwright/test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const FIXTURE_DIR = path.join(__dirname, "fixtures");
export const WEBM_FIXTURE = path.join(FIXTURE_DIR, "take.webm");

/**
 * Mint a tiny, real WebM that Playwright's Chromium can decode, and stash it as
 * a fixture. The happy-path spec serves these bytes from the mocked
 * `/api/studio/proxy` so the *real* media-processing pipeline (mediabunny probe
 * + WebCodecs decode + canvas thumbnail) runs deterministically — no proprietary
 * H.264 codec (absent in headless builds) and no checked-in binary. Producing the
 * clip with Chromium's own MediaRecorder guarantees Chromium can later decode it.
 */
export default async function globalSetup() {
	await mkdir(FIXTURE_DIR, { recursive: true });
	try {
		const s = await stat(WEBM_FIXTURE);
		if (s.size > 512) return; // already minted
	} catch {
		// fall through and mint it
	}

	const browser = await chromium.launch();
	const page = await browser.newPage();
	const base64 = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 128;
		canvas.height = 128;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		const stream = canvas.captureStream(30);
		const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
			? "video/webm;codecs=vp9"
			: "video/webm;codecs=vp8";
		const rec = new MediaRecorder(stream, { mimeType: mime });
		const chunks: Blob[] = [];
		rec.ondataavailable = (e) => {
			if (e.data.size) chunks.push(e.data);
		};
		const stopped = new Promise<void>((resolve) => {
			rec.onstop = () => resolve();
		});
		rec.start();
		const start = performance.now();
		await new Promise<void>((resolve) => {
			const draw = () => {
				const t = performance.now() - start;
				ctx.fillStyle = t % 400 < 200 ? "#38BDF8" : "#111827";
				ctx.fillRect(0, 0, 128, 128);
				if (t < 700) requestAnimationFrame(draw);
				else resolve();
			};
			draw();
		});
		rec.stop();
		await stopped;
		const blob = new Blob(chunks, { type: "video/webm" });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);
		return btoa(binary);
	});
	await browser.close();

	const buffer = Buffer.from(base64, "base64");
	if (buffer.byteLength < 512) {
		throw new Error(
			`Minted WebM fixture is implausibly small (${buffer.byteLength} bytes)`,
		);
	}
	await writeFile(WEBM_FIXTURE, buffer);
}
