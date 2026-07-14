/**
 * FIX-E worker-compositor GO/NO-GO bench driver.
 *
 * Adapted from $BENCH/axis-2/bench.js (same fixture construction, same
 * validity rules: channel:'chrome' headed, anti-throttling flags, real HTTP
 * fixture server, rAF-rate probe). Differences:
 *   - Runs against the fix-e worktree's OWN prod-e2e build (worker compositor
 *     code lives there, not on main/axis-2's build).
 *   - Takes a `mode` arg: "off" | "on". "on" seeds
 *     localStorage["byorn-worker-compositor"]="1" via addInitScript BEFORE
 *     the app loads, so ONE build serves both conditions (no second build).
 *   - Forces playbackQuality="full" in BOTH modes (matches res4k's seeding
 *     trick) so neither path benefits from an auto-downscale the other
 *     lacks — the worker-compositor prototype doesn't port the
 *     playback-quality-while-playing scaling, so this keeps the comparison
 *     apples-to-apples.
 *   - Reads window.__byornPerf (main-thread perfStats) AND, when present,
 *     window.__byornPerfWorker (worker-side perfStats, via the new
 *     WorkerCompositor controller) and reports whichever is the real
 *     compositor loop for that mode.
 *
 * Usage: node bench.js <base|heavy> <off|on> [port]
 */
const { chromium } = require(
	"/Users/zsha/Documents/ai-native-opencut-fix-e/apps/web/node_modules/@playwright/test",
);
const path = require("path");
const fs = require("fs");

const SCENARIO = process.argv[2] || "base";
const MODE = process.argv[3] || "off";
const PORT = process.argv[4] || process.env.FIXE_PORT || "3115";
const BASE_URL = `http://localhost:${PORT}`;

const FIXTURE_DIR =
	"/private/tmp/claude-501/-Users-zsha-Documents-ai-native-opencut/12567616-f85c-43f3-a463-aa9f3d4af4a4/scratchpad/fixtures";
const FIX_1080P = path.join(FIXTURE_DIR, "fixture-1080p30-h264.mp4");
const FIX_4K = path.join(FIXTURE_DIR, "fixture-4k-hevc.mp4");
const FIX_AUDIO = path.join(FIXTURE_DIR, "fixture-audio-3min.wav");

const OUT_DIR = __dirname;

function initScript({ mode }) {
	// Skip onboarding.
	window.localStorage.setItem("hasSeenOnboarding-v3", "true");
	// Force full-res compositing in BOTH modes (apples-to-apples: the worker
	// path doesn't implement playback-quality downscale-while-playing yet).
	const raw = window.localStorage.getItem("preview-settings");
	const parsed = raw ? JSON.parse(raw) : { state: {}, version: 4 };
	parsed.state = { ...(parsed.state || {}), playbackQuality: "full" };
	parsed.version = 4;
	window.localStorage.setItem("preview-settings", JSON.stringify(parsed));

	if (mode === "on") {
		window.localStorage.setItem("byorn-worker-compositor", "1");
	}
}

async function main() {
	const browser = await chromium.launch({
		channel: "chrome",
		headless: false,
		args: [
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
		],
	});
	const context = await browser.newContext({
		viewport: { width: 1500, height: 950 },
	});
	const page = await context.newPage();
	page.on("crash", () => console.error(`[fixe:${MODE}] !!! PAGE CRASHED`));
	page.on("pageerror", (e) =>
		console.error(`[fixe:${MODE}] pageerror:`, e.message),
	);
	page.on("console", (msg) => {
		if (msg.type() === "error" || msg.type() === "warning") {
			console.log(`[page:${msg.type()}]`, msg.text().slice(0, 300));
		}
	});
	await page.addInitScript(initScript, { mode: MODE });

	const http = require("http");
	const FIXTURE_MAP = {
		"/clip-a.mp4": FIX_1080P,
		"/clip-b.mp4": FIX_1080P,
		"/clip-c.mp4": FIX_1080P,
		"/clip-d.mp4": FIX_1080P,
		"/gopro.mp4": FIX_4K,
		"/audio.wav": FIX_AUDIO,
	};
	const fixtureServer = http.createServer((req, res) => {
		const filePath = FIXTURE_MAP[req.url.split("?")[0]];
		if (!filePath) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const stat = fs.statSync(filePath);
		const type = filePath.endsWith(".wav") ? "audio/wav" : "video/mp4";
		res.writeHead(200, {
			"Content-Type": type,
			"Content-Length": stat.size,
			"Access-Control-Allow-Origin": "*",
		});
		fs.createReadStream(filePath).pipe(res);
	});
	const FIXTURE_PORT = 8890 + (SCENARIO === "heavy" ? 1 : 0) + (MODE === "on" ? 10 : 0);
	await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, resolve));
	console.log(`[fixe:${MODE}] fixture server on :${FIXTURE_PORT}`);

	const projectId = `fixe-${SCENARIO}-${MODE}-${Date.now()}`;
	console.log(`[fixe:${MODE}] navigating to /editor/${projectId}`);
	await page.goto(`${BASE_URL}/editor/${projectId}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 60_000,
	});
	console.log(`[fixe:${MODE}] editor ready`);

	await page.waitForURL(/\/editor\/.+/);
	await page.waitForTimeout(1500);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 30_000,
	});

	await page.evaluate(() => {
		const editor = window.__BYORN_E2E__.editor;
		const projectId = editor.project.getActive().id;

		async function fetchFile(url, name, type) {
			const res = await fetch(url);
			const blob = await res.blob();
			return new File([blob], name, { type });
		}

		window.__fixeAddVideoAsset = async (url, name) => {
			const file = await fetchFile(url, name, "video/mp4");
			const objUrl = URL.createObjectURL(file);
			const video = document.createElement("video");
			video.preload = "metadata";
			video.src = objUrl;
			await new Promise((resolve, reject) => {
				video.onloadedmetadata = () => resolve();
				video.onerror = () => reject(new Error("metadata load failed: " + name));
			});
			const duration = video.duration;
			const width = video.videoWidth;
			const height = video.videoHeight;
			video.src = "";
			const mediaId = await editor.media.addMediaAsset({
				projectId,
				asset: { name, type: "video", file, url: objUrl, duration, width, height, fps: 30 },
			});
			return { mediaId, duration };
		};

		window.__fixeAddAudioAsset = async (url, name) => {
			const file = await fetchFile(url, name, "audio/wav");
			const objUrl = URL.createObjectURL(file);
			const audio = document.createElement("audio");
			audio.preload = "metadata";
			audio.src = objUrl;
			await new Promise((resolve, reject) => {
				audio.onloadedmetadata = () => resolve();
				audio.onerror = () => reject(new Error("metadata load failed: " + name));
			});
			const duration = audio.duration;
			audio.src = "";
			const mediaId = await editor.media.addMediaAsset({
				projectId,
				asset: { name, type: "audio", file, url: objUrl, duration },
			});
			return { mediaId, duration };
		};
	});

	const heavy = SCENARIO === "heavy";
	const fixtureBase = `http://localhost:${FIXTURE_PORT}`;
	const clipNames = ["clip-a.mp4", "clip-b.mp4", "clip-c.mp4", "clip-d.mp4"];
	const assets = [];
	for (const name of clipNames) {
		const a = await page.evaluate(
			({ url, name }) => window.__fixeAddVideoAsset(url, name),
			{ url: `${fixtureBase}/${name}`, name },
		);
		assets.push(a);
		console.log(`[fixe:${MODE}] added ${name} (${a.duration.toFixed(1)}s)`);
	}
	if (heavy) {
		for (let i = 0; i < 8; i++) {
			const src = clipNames[i % clipNames.length];
			const a = await page.evaluate(
				({ url, name }) => window.__fixeAddVideoAsset(url, name),
				{ url: `${fixtureBase}/${src}`, name: `clip-extra-${i}.mp4` },
			);
			assets.push(a);
			console.log(`[fixe:${MODE}] added clip-extra-${i}`);
		}
	}
	const goproAsset = await page.evaluate(
		({ url }) => window.__fixeAddVideoAsset(url, "gopro.mp4"),
		{ url: `${fixtureBase}/gopro.mp4` },
	);
	console.log(`[fixe:${MODE}] added gopro (${goproAsset.duration.toFixed(1)}s)`);
	const audioAsset = await page.evaluate(
		({ url }) => window.__fixeAddAudioAsset(url, "audio.wav"),
		{ url: `${fixtureBase}/audio.wav` },
	);
	console.log(`[fixe:${MODE}] added audio (${audioAsset.duration.toFixed(1)}s)`);

	const buildResult = await page.evaluate(
		async ({ scenario, assets, goproAsset, audioAsset }) => {
			const editor = window.__BYORN_E2E__.editor;
			const heavy = scenario === "heavy";

			const videoTrack1 = editor.timeline.addTrack({ type: "video" });
			const videoTrack2 = editor.timeline.addTrack({ type: "video" });
			const textTrack = editor.timeline.addTrack({ type: "text" });
			const audioTrack = editor.timeline.addTrack({ type: "audio" });

			const clipDuration = 6;
			const starts = [0, 3, 6, 11];
			for (let i = 0; i < 4; i++) {
				const trackId = i % 2 === 0 ? videoTrack1 : videoTrack2;
				const effects =
					i === 0
						? [
								{ id: "fx-color", type: "color-adjust", params: { brightness: 0.12, contrast: 1.3 }, enabled: true },
								{ id: "fx-grain", type: "film-grain", params: { intensity: 25 }, enabled: true },
							]
						: undefined;
				const transitionOut =
					i === 0 ? { type: "cross-dissolve", duration: 0.8 } : undefined;
				editor.timeline.insertElement({
					element: {
						type: "video",
						name: `clip-${i}`,
						mediaId: assets[i].mediaId,
						duration: clipDuration,
						startTime: starts[i],
						trimStart: 0,
						trimEnd: Math.max(0, assets[i].duration - clipDuration),
						effects,
						transitionOut,
					},
					placement: { mode: "explicit", trackId },
				});
			}

			if (heavy) {
				let cursor = 20;
				for (let i = 4; i < assets.length; i++) {
					const trackId = i % 2 === 0 ? videoTrack1 : videoTrack2;
					editor.timeline.insertElement({
						element: {
							type: "video",
							name: `clip-extra-${i}`,
							mediaId: assets[i].mediaId,
							duration: clipDuration,
							startTime: cursor,
							trimStart: 0,
							trimEnd: Math.max(0, assets[i].duration - clipDuration),
						},
						placement: { mode: "explicit", trackId },
					});
					cursor += clipDuration + 0.5;
				}
			}

			const goproTrack = editor.timeline.addTrack({ type: "video" });
			editor.timeline.insertElement({
				element: {
					type: "video",
					name: "gopro",
					mediaId: goproAsset.mediaId,
					duration: 8,
					startTime: 2,
					trimStart: 0,
					trimEnd: Math.max(0, goproAsset.duration - 8),
				},
				placement: { mode: "explicit", trackId: goproTrack },
			});

			editor.timeline.insertElement({
				element: {
					type: "text",
					name: "Title",
					content: "FIX-E BENCH",
					fontSize: 64,
					fontFamily: "Arial",
					color: "#ffffff",
					background: {
						enabled: false,
						color: "#000000",
						cornerRadius: 0,
						paddingX: 30,
						paddingY: 42,
						offsetX: 0,
						offsetY: 0,
					},
					textAlign: "center",
					fontWeight: "normal",
					fontStyle: "normal",
					textDecoration: "none",
					letterSpacing: 0,
					lineHeight: 1.2,
					duration: 10,
					startTime: 0,
					trimStart: 0,
					trimEnd: 0,
				},
				placement: { mode: "explicit", trackId: textTrack },
			});

			editor.timeline.insertElement({
				element: {
					type: "audio",
					name: "audio-bed",
					mediaId: audioAsset.mediaId,
					duration: 30,
					startTime: 0,
					trimStart: 0,
					trimEnd: Math.max(0, audioAsset.duration - 30),
					volume: 0.5,
				},
				placement: { mode: "explicit", trackId: audioTrack },
			});

			const tracks = editor.timeline.getTracks();
			const totalClips = tracks.reduce((n, t) => n + t.elements.length, 0);
			return { totalClips, tracks: tracks.length, assetCount: assets.length + 2 };
		},
		{ scenario: SCENARIO, assets, goproAsset, audioAsset },
	);
	console.log(`[fixe:${MODE}] build result:`, JSON.stringify(buildResult));

	await page.waitForTimeout(1500);

	await page.evaluate(() => {
		window.__byornPerf.setEnabled({ enabled: true });
	});

	await page.bringToFront();
	const rafProbe = await page.evaluate(
		() =>
			new Promise((resolve) => {
				let n = 0;
				const t0 = performance.now();
				function tick() {
					n++;
					if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
					else resolve({ rafPerSec: n, visibility: document.visibilityState });
				}
				requestAnimationFrame(tick);
			}),
	);
	console.log(`[fixe:${MODE}] rAF probe:`, JSON.stringify(rafProbe));
	if (rafProbe.rafPerSec < 30) {
		console.error(`[fixe:${MODE}] rAF THROTTLED — numbers would be invalid`);
	}

	console.log(`[fixe:${MODE}] COLD playback 10s...`);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.play());
	await page.waitForTimeout(10_000);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.pause());
	const coldStats = await page.evaluate(() => window.__byornPerf.getStats());
	const coldWorkerStats = await page.evaluate(() =>
		window.__byornPerfWorker ? window.__byornPerfWorker.getLatestStats() : null,
	);
	console.log(`[fixe:${MODE}] cold main stats:`, JSON.stringify(coldStats));
	console.log(`[fixe:${MODE}] cold worker stats:`, JSON.stringify(coldWorkerStats));

	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.seek({ time: 0 }));
	await page.waitForTimeout(2000);
	await page.evaluate(() => window.__byornPerf.reset());
	// Reset the worker-side collector too (setEnabled false->true resets the
	// window — PerfStatsCollector.setEnabled). Without this the warm snapshot's
	// 120-frame window spans cold frames + the pause/seek gap and deflates fps.
	await page.evaluate(() => {
		if (window.__byornPerfWorker) {
			window.__byornPerfWorker.setPerfEnabled({ enabled: false });
			window.__byornPerfWorker.setPerfEnabled({ enabled: true });
		}
	});
	await page.waitForTimeout(600); // let one stats push land post-reset

	console.log(`[fixe:${MODE}] WARM playback 10s...`);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.play());
	const warmT0 = Date.now();
	await page.waitForTimeout(10_000);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.pause());
	const warmElapsedMs = Date.now() - warmT0;

	const stats = await page.evaluate(() => window.__byornPerf.getStats());
	// Same exact-throughput number for the main-thread path (its collector was
	// reset right before warm too).
	stats.warmThroughputFps = (stats.framesRendered * 1000) / warmElapsedMs;
	const workerStats = await page.evaluate(() =>
		window.__byornPerfWorker ? window.__byornPerfWorker.getLatestStats() : null,
	);
	if (workerStats) {
		// Post-reset counters are warm-pass-only: exact throughput independent
		// of the rolling window.
		workerStats.warmThroughputFps =
			(workerStats.framesRendered * 1000) / warmElapsedMs;
	}
	const hasWorker = await page.evaluate(() => !!window.__byornPerfWorker);

	console.log(`[fixe:${MODE}] main perfStats:`, JSON.stringify(stats, null, 2));
	console.log(`[fixe:${MODE}] worker perfStats:`, JSON.stringify(workerStats, null, 2));

	const report = {
		scenario: SCENARIO,
		mode: MODE,
		port: PORT,
		rafProbe,
		hasWorker,
		mainStatsCold: coldStats,
		mainStats: stats,
		workerStatsCold: coldWorkerStats,
		workerStats,
		buildResult,
	};
	fs.writeFileSync(
		path.join(OUT_DIR, `result-${SCENARIO}-${MODE}.json`),
		JSON.stringify(report, null, 2),
	);
	console.log(`[fixe:${MODE}] wrote result-${SCENARIO}-${MODE}.json`);

	await browser.close();
	fixtureServer.close();
}

main().catch((err) => {
	console.error(`[fixe:${MODE}] FAILED`, err);
	process.exit(1);
});
