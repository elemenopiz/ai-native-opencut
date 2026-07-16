import { chromium } from "@playwright/test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const FIXTURE_DIR = path.join(__dirname, "fixtures");
export const WEBM_FIXTURE = path.join(FIXTURE_DIR, "take.webm");
/** A/V twin of `WEBM_FIXTURE` — same minting approach, but with a real audio
 *  track (oscillator → MediaStreamDestination, merged with the canvas video
 *  track) so a real-export spec can assert on an actual audio stream in the
 *  produced file, not just video. Used only by `golden-path-export.e2e.ts`;
 *  every other spec keeps using `WEBM_FIXTURE`. ~2.6s long — comfortably
 *  longer than the generation duration the golden-path spec requests, so
 *  trims/splits in that test never run past the real source media. */
export const AV_WEBM_FIXTURE = path.join(FIXTURE_DIR, "take-av.webm");
/** Nominal duration (seconds) the mint loop targets for `AV_WEBM_FIXTURE`.
 *  Exported so the spec that consumes it can size its generation/trim/split
 *  math with margin below the real source length instead of guessing. */
export const AV_WEBM_FIXTURE_TARGET_SECONDS = 2.6;

/**
 * Mint `AV_WEBM_FIXTURE`: same MediaRecorder approach as the video-only
 * fixture above, but the captured `MediaStream` also carries a real audio
 * track — an `OscillatorNode` routed through a `MediaStreamAudioDestinationNode`,
 * merged with the canvas's video track. Chromium encodes it with an Opus
 * audio track alongside VP9/VP8 video, so the golden-path real-export spec
 * has genuine audio to mix down and probe for, not just video.
 */
async function mintAvFixture(
	page: Awaited<
		ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>
	>,
): Promise<Buffer> {
	const base64 = await page.evaluate(async (targetMs: number) => {
		const canvas = document.createElement("canvas");
		canvas.width = 128;
		canvas.height = 128;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		const videoStream = canvas.captureStream(30);

		const audioCtx = new AudioContext();
		const oscillator = audioCtx.createOscillator();
		oscillator.frequency.value = 440;
		const destination = audioCtx.createMediaStreamDestination();
		oscillator.connect(destination);
		oscillator.start();

		const combined = new MediaStream([
			...videoStream.getVideoTracks(),
			...destination.stream.getAudioTracks(),
		]);

		const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
			? "video/webm;codecs=vp9,opus"
			: MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
				? "video/webm;codecs=vp8,opus"
				: "video/webm";
		const rec = new MediaRecorder(combined, { mimeType: mime });
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
				if (t < targetMs) requestAnimationFrame(draw);
				else resolve();
			};
			draw();
		});
		rec.stop();
		await stopped;
		oscillator.stop();
		await audioCtx.close();

		const blob = new Blob(chunks, { type: "video/webm" });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		const CHUNK = 0x8000;
		for (let i = 0; i < bytes.length; i += CHUNK) {
			binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
		}
		return btoa(binary);
	}, AV_WEBM_FIXTURE_TARGET_SECONDS * 1000);

	const buffer = Buffer.from(base64, "base64");
	if (buffer.byteLength < 512) {
		throw new Error(
			`Minted A/V WebM fixture is implausibly small (${buffer.byteLength} bytes)`,
		);
	}
	return buffer;
}

/**
 * Mint the fixtures Playwright's Chromium can decode, and stash them as
 * files under `FIXTURE_DIR`. Specs serve these bytes from the mocked
 * `/api/studio/proxy` so the *real* media-processing pipeline (mediabunny probe
 * + WebCodecs decode + canvas thumbnail) runs deterministically — no proprietary
 * H.264 codec (absent in headless builds) and no checked-in binary. Producing the
 * clips with Chromium's own MediaRecorder guarantees Chromium can later decode them.
 */
export default async function globalSetup() {
	await mkdir(FIXTURE_DIR, { recursive: true });

	let needsVideoOnly = true;
	try {
		const s = await stat(WEBM_FIXTURE);
		if (s.size > 512) needsVideoOnly = false;
	} catch {
		// fall through and mint it
	}

	let needsAv = true;
	try {
		const s = await stat(AV_WEBM_FIXTURE);
		if (s.size > 512) needsAv = false;
	} catch {
		// fall through and mint it
	}

	if (!needsVideoOnly && !needsAv) return;

	const browser = await chromium.launch();
	const page = await browser.newPage();

	if (needsVideoOnly) {
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

		const buffer = Buffer.from(base64, "base64");
		if (buffer.byteLength < 512) {
			throw new Error(
				`Minted WebM fixture is implausibly small (${buffer.byteLength} bytes)`,
			);
		}
		await writeFile(WEBM_FIXTURE, buffer);
	}

	if (needsAv) {
		const buffer = await mintAvFixture(page);
		await writeFile(AV_WEBM_FIXTURE, buffer);
	}

	await browser.close();
}
