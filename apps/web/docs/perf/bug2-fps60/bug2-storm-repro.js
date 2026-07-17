/**
 * BUG2 repro/bench: fps60 decode-starvation re-seek storm.
 *
 * 4 stacked 1080p60 layers at project fps 60 (full overlap, same start/end)
 * vs a 1-layer control. Drives real playback through the __BYORN_E2E__
 * bridge (real editor singleton, real videoCache/renderer), polls
 * window.__byornPerf.getStats() every 500ms, and derives "stall episodes":
 * consecutive polls where framesRendered does not advance WHILE isPlaying is
 * true (a natural clip-end pause is not a wedge). Max stall episode length
 * is the headline metric.
 *
 * Adapted from apps/web/docs/perf/fix-e-worker-compositor/bench.js (fixture
 * server + rAF-throttle probe pattern) and a since-orphaned bug2-repro.js
 * found in scratchpad (auth-stub route + evalBridge retry pattern) — the
 * original was pinned to a worktree (agent-a8e51b3cb1e147a6e) that no longer
 * exists, and its "stacked" scenario round-robin-assigned 4 assets across
 * only 3 tracks (so two clips landed on the same track/time and could not
 * both render), which is likely why it never observed a wedge. This version
 * gives each layer its OWN track so all 4 genuinely composite concurrently.
 *
 * Fixture: a 30s 1080p60 h264 clip minted with
 *   ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=30" \
 *     -vf "noise=alls=10:allf=t+u" -c:v libx264 -preset veryfast -crf 26 \
 *     -g 30 -pix_fmt yuv420p -movflags +faststart fixture-1080p60-h264-small.mp4
 * (~21MB — an earlier crf18 mint was 814MB and blew the browser's per-origin
 * IndexedDB storage quota on the very first stacked-scenario asset add).
 *
 * Prerequisite server: from apps/web, `NEXT_PUBLIC_E2E=1 next dev --turbopack
 * -p 3120` (needs a `.env.local` with DATABASE_URL/BETTER_AUTH_SECRET set —
 * copy from the main checkout's apps/web/.env.local — or the env schema
 * parse throws at module eval and every route 500s). A `bun run build:e2e`
 * prod build is the more representative target per the axis-* perf docs
 * convention, but was abandoned here after 25+ minutes stuck at ~5% CPU
 * under this machine's concurrent-session contention (see caveats in the
 * committed result JSON / final report) — prod numbers were not collected.
 *
 * Usage: node bug2-storm-repro.js <stacked|single> [port] [cpuThrottle]
 *   cpuThrottle: CDP Emulation.setCPUThrottlingRate multiplier (default 1 =
 *   off). Needed on a noisy shared machine — see CPU_THROTTLE comment below.
 */
const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const http = require("http");

const SCENARIO = process.argv[2] || "stacked";
const PORT = process.argv[3] || process.env.BUG2_PORT || "3120";
// CDP Emulation.setCPUThrottlingRate multiplier. This shared machine's
// ambient host-level CPU contention (other concurrent sessions building/
// typechecking) swamps any signal from the fix itself — even the 1-layer
// control shows multi-second stalls purely from host scheduling noise.
// Throttling the renderer's main thread in-browser creates decode/composite
// pressure that is reproducible independent of that ambient noise.
const CPU_THROTTLE = Number(process.argv[4] || process.env.BUG2_THROTTLE || "1");
const BASE_URL = `http://localhost:${PORT}`;

// Not committed (binary, and easy to regenerate) — mint with the ffmpeg
// command in the header comment above if this path doesn't exist.
const FIXTURE_DIR =
	process.env.BUG2_FIXTURE_DIR ||
	"/private/tmp/claude-501/-Users-zsha-Documents-ai-native-opencut/ada6718e-31b3-48f8-beaf-a62c82a8253e/scratchpad/fixtures";
const FIX_1080P60 = path.join(FIXTURE_DIR, "fixture-1080p60-h264-small.mp4");

// Results are written next to this script.
const OUT_DIR = __dirname;

// Kept safely inside the per-clip 25s duration (below) so playback never
// naturally pauses mid-measurement — an earlier run showed a false "stall"
// signature for the last several polls that was really isPlaying flipping
// to false at clip end, not a decode wedge.
const PLAY_MS = 22_000;
const POLL_MS = 500;

function initScript() {
	window.localStorage.setItem("hasSeenOnboarding-v3", "true");
	const raw = window.localStorage.getItem("preview-settings");
	const parsed = raw ? JSON.parse(raw) : { state: {}, version: 4 };
	parsed.state = { ...(parsed.state || {}), playbackQuality: "full" };
	parsed.version = 4;
	window.localStorage.setItem("preview-settings", JSON.stringify(parsed));
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
		viewport: { width: 1600, height: 1000 },
	});
	const page = await context.newPage();
	page.on("crash", () => console.error(`[bug2:${SCENARIO}] !!! PAGE CRASHED`));
	page.on("pageerror", (e) =>
		console.error(`[bug2:${SCENARIO}] pageerror:`, e.message),
	);
	page.on("console", (msg) => {
		if (msg.type() === "error" || msg.type() === "warning") {
			console.log(`[page:${msg.type()}]`, msg.text().slice(0, 300));
		}
	});
	await page.addInitScript(initScript);

	if (CPU_THROTTLE > 1) {
		const cdp = await context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
		console.log(`[bug2:${SCENARIO}] CPU throttling engaged: ${CPU_THROTTLE}x`);
	}

	// The repro needs no server API (project/media live in IndexedDB); stub
	// every non-auth /api/* with an empty 200 so a client-side 401 doesn't
	// redirect the page away from /editor mid-run.
	await page.route("**/api/**", async (route) => {
		const url = route.request().url();
		if (url.includes("/api/auth/")) {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: "{}",
		});
	});

	const FIXTURE_MAP = {
		"/clip.mp4": FIX_1080P60,
	};
	const fixtureServer = http.createServer((req, res) => {
		const filePath = FIXTURE_MAP[req.url.split("?")[0]];
		if (!filePath) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const stat = fs.statSync(filePath);
		res.writeHead(200, {
			"Content-Type": "video/mp4",
			"Content-Length": stat.size,
			"Access-Control-Allow-Origin": "*",
		});
		fs.createReadStream(filePath).pipe(res);
	});
	const FIXTURE_PORT = SCENARIO === "single" ? 8941 : 8940;
	await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, resolve));
	console.log(`[bug2:${SCENARIO}] fixture server on :${FIXTURE_PORT}`);

	async function evalBridge(fn, arg) {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await page.waitForFunction(
					() => window.__BYORN_E2E__?.ready === true,
					null,
					{ timeout: 90_000 },
				);
			} catch {
				const diag = await page
					.evaluate(() => ({
						url: location.href,
						hasBridge: !!window.__BYORN_E2E__,
						bodySnippet: document.body.innerText.slice(0, 300),
					}))
					.catch(() => null);
				console.log(`[bug2:${SCENARIO}] bridge-wait timeout diag:`, JSON.stringify(diag));
				await page.reload();
				continue;
			}
			try {
				return await page.evaluate(fn, arg);
			} catch (e) {
				if (!String(e).includes("Cannot read properties of undefined")) {
					throw e;
				}
				console.log(`[bug2:${SCENARIO}] bridge remounted mid-evaluate, retrying (${attempt + 1})`);
				await page.waitForTimeout(1000);
			}
		}
		throw new Error("bridge never stabilized");
	}

	const projectId = `bug2-${SCENARIO}-${Date.now()}`;
	console.log(`[bug2:${SCENARIO}] navigating to /editor/${projectId}`);
	await page.goto(`${BASE_URL}/editor/${projectId}`, { timeout: 120_000 });
	let ready = false;
	for (let i = 0; i < 4 && !ready; i++) {
		try {
			await page.waitForFunction(
				() => window.__BYORN_E2E__?.ready === true,
				null,
				{ timeout: 90_000 },
			);
			ready = true;
		} catch {
			console.log(`[bug2:${SCENARIO}] bridge not ready, url=${page.url()} — re-navigating`);
			await page.goto(`${BASE_URL}/editor/${projectId}-r${i}`, { timeout: 120_000 });
		}
	}
	if (!ready) throw new Error("editor bridge never became ready");
	console.log(`[bug2:${SCENARIO}] editor ready`);
	await page.waitForURL(/\/editor\/.+/);
	await page.waitForTimeout(1500);

	// Project fps 60 — required condition per BUG2 characterization.
	await evalBridge(async () => {
		const editor = window.__BYORN_E2E__.editor;
		await editor.project.updateSettings({
			settings: { fps: 60 },
			pushHistory: false,
		});
	});
	console.log(`[bug2:${SCENARIO}] project fps set to 60`);

	await evalBridge(() => {
		const editor = window.__BYORN_E2E__.editor;
		const projectId = editor.project.getActive().id;

		async function fetchFile(url, name, type) {
			const res = await fetch(url);
			const blob = await res.blob();
			return new File([blob], name, { type });
		}

		window.__bug2AddVideoAsset = async (url, name) => {
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
				asset: { name, type: "video", file, url: objUrl, duration, width, height, fps: 60 },
			});
			return { mediaId, duration };
		};
	});

	const fixtureBase = `http://localhost:${FIXTURE_PORT}`;
	const layerCount = SCENARIO === "single" ? 1 : 4;
	const assets = [];
	for (let i = 0; i < layerCount; i++) {
		const a = await page.evaluate(
			({ url, name }) => window.__bug2AddVideoAsset(url, name),
			{ url: `${fixtureBase}/clip.mp4`, name: `clip-${i}.mp4` },
		);
		assets.push(a);
		console.log(`[bug2:${SCENARIO}] added layer ${i} (${a.duration.toFixed(1)}s)`);
	}

	const buildResult = await evalBridge(
		async ({ assets }) => {
			const editor = window.__BYORN_E2E__.editor;
			const clipDuration = 25; // fixture is 30s; leave margin

			assets.forEach((asset, i) => {
				// One dedicated video track per layer — every layer must fully
				// overlap (same startTime/duration) so all decoders are hit on
				// every render frame, not just N.
				const trackId = editor.timeline.addTrack({ type: "video" });
				editor.timeline.insertElement({
					element: {
						type: "video",
						name: `clip-${i}`,
						mediaId: asset.mediaId,
						duration: clipDuration,
						startTime: 0,
						trimStart: 0,
						trimEnd: Math.max(0, asset.duration - clipDuration),
					},
					placement: { mode: "explicit", trackId },
				});
			});

			const tracks = editor.timeline.getTracks();
			const totalClips = tracks.reduce((n, t) => n + t.elements.length, 0);
			return { totalClips, tracks: tracks.length, assetCount: assets.length };
		},
		{ assets },
	);
	console.log(`[bug2:${SCENARIO}] build result:`, JSON.stringify(buildResult));

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
	console.log(`[bug2:${SCENARIO}] rAF probe:`, JSON.stringify(rafProbe));
	if (rafProbe.rafPerSec < 30) {
		console.error(`[bug2:${SCENARIO}] rAF THROTTLED — numbers would be invalid`);
	}

	// COLD pass: warm decoders / first seeks, not measured.
	console.log(`[bug2:${SCENARIO}] COLD playback 5s (warmup, not measured)...`);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.play());
	await page.waitForTimeout(5_000);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.pause());

	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.seek({ time: 0 }));
	await page.waitForTimeout(1000);
	await page.evaluate(() => window.__byornPerf.reset());
	await page.waitForTimeout(300);

	// WARM measured pass.
	console.log(`[bug2:${SCENARIO}] WARM playback ${PLAY_MS}ms, polling every ${POLL_MS}ms...`);
	const pollLog = [];
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.play());
	const warmT0 = Date.now();
	let lastFramesRendered = -1;
	let lastChangeAtMs = 0;

	while (Date.now() - warmT0 < PLAY_MS) {
		await page.waitForTimeout(POLL_MS);
		const snapshot = await page.evaluate(() => {
			const stats = window.__byornPerf.getStats();
			const isPlaying = window.__BYORN_E2E__.editor.playback.getIsPlaying
				? window.__BYORN_E2E__.editor.playback.getIsPlaying()
				: null;
			return { stats, isPlaying };
		});
		const tMs = Date.now() - warmT0;
		pollLog.push({ tMs, ...snapshot });
		console.log(
			`[bug2:${SCENARIO}] t=${tMs}ms framesRendered=${snapshot.stats.framesRendered} fps=${snapshot.stats.fps.toFixed(1)} avgDecodeMs=${snapshot.stats.avgDecodeMs.toFixed(1)} renderErrors=${snapshot.stats.renderErrors} isPlaying=${snapshot.isPlaying}`,
		);
		if (snapshot.stats.framesRendered === lastFramesRendered) {
			// stalled since lastChangeAtMs
		} else {
			lastFramesRendered = snapshot.stats.framesRendered;
			lastChangeAtMs = tMs;
		}
	}
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.pause());
	const warmElapsedMs = Date.now() - warmT0;
	const finalStats = await page.evaluate(() => window.__byornPerf.getStats());
	console.log(`[bug2:${SCENARIO}] final stats:`, JSON.stringify(finalStats));

	// Derive stall episodes: consecutive polls with no framesRendered advance
	// WHILE isPlaying is true (a natural clip-end pause is not a wedge).
	const episodes = [];
	let episodeStartMs = null;
	let prevFrames = null;
	let prevT = 0;
	for (const p of pollLog) {
		const playing = p.isPlaying !== false;
		if (playing && prevFrames !== null && p.stats.framesRendered === prevFrames) {
			if (episodeStartMs === null) episodeStartMs = prevT;
		} else {
			if (episodeStartMs !== null) {
				episodes.push({ startMs: episodeStartMs, endMs: prevT, lengthMs: prevT - episodeStartMs });
				episodeStartMs = null;
			}
		}
		if (playing) {
			prevFrames = p.stats.framesRendered;
			prevT = p.tMs;
		} else {
			prevFrames = null;
		}
	}
	if (episodeStartMs !== null) {
		episodes.push({ startMs: episodeStartMs, endMs: prevT, lengthMs: prevT - episodeStartMs });
	}
	const maxEpisodeMs = episodes.reduce((m, e) => Math.max(m, e.lengthMs), 0);

	const report = {
		scenario: SCENARIO,
		layerCount,
		rafProbe,
		finalStats,
		warmElapsedMs,
		episodes,
		maxEpisodeMs,
		pollLog,
		buildResult,
	};
	fs.mkdirSync(OUT_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(OUT_DIR, `result-${SCENARIO}.json`),
		JSON.stringify(report, null, 2),
	);
	console.log(`[bug2:${SCENARIO}] wrote result-${SCENARIO}.json`);
	console.log(
		`[bug2:${SCENARIO}] SUMMARY: maxEpisodeMs=${maxEpisodeMs} episodeCount=${episodes.length} framesRendered=${finalStats.framesRendered} fps=${finalStats.fps.toFixed(1)} avgDecodeMs=${finalStats.avgDecodeMs.toFixed(1)} renderErrors=${finalStats.renderErrors}`,
	);

	await browser.close();
	fixtureServer.close();
}

main().catch((err) => {
	console.error(`[bug2:${SCENARIO}] FAILED`, err);
	process.exit(1);
});
