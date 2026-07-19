/**
 * Vendors the ONNX-runtime WebAssembly files that on-device Whisper/CLIP need
 * into `public/onnx/`, so the browser fetches them SAME-ORIGIN instead of from
 * jsDelivr at runtime.
 *
 * Why: `@huggingface/transformers` defaults `onnxruntime-web`'s `wasmPaths` to
 * `https://cdn.jsdelivr.net/npm/@huggingface/transformers@<version>/dist/`. That
 * makes transcription depend on a third-party CDN being reachable at run time —
 * when jsDelivr is slow, rate-limited, blocked (corporate/regional networks), or
 * down, the worker throws a bare "network error" and transcription fails. The
 * workers override `wasmPaths` to `/onnx/` (see whisper.worker.ts / clip.worker.ts);
 * this script makes sure the files are actually there for both `next dev` and
 * `next build`. The copied files are the EXACT build shipped inside the installed
 * transformers package, so the ORT version always matches.
 *
 * Idempotent: skips files that are already present with the same size.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public", "onnx");

// The runtime files onnxruntime-web loads from wasmPaths. The .wasm is the ORT
// binary; the .mjs is its JSEP (WebGPU) glue, dynamically imported from the same
// directory. Both must sit next to each other under /onnx/.
const FILES = [
	"ort-wasm-simd-threaded.jsep.wasm",
	"ort-wasm-simd-threaded.jsep.mjs",
];

function transformersDistDir() {
	// package.json isn't in the exports map, so resolve the package entry and
	// walk up to its dist directory instead.
	const entry = require.resolve("@huggingface/transformers");
	return path.dirname(entry);
}

function main() {
	const dist = transformersDistDir();
	fs.mkdirSync(publicDir, { recursive: true });

	let copied = 0;
	for (const name of FILES) {
		const src = path.join(dist, name);
		if (!fs.existsSync(src)) {
			throw new Error(
				`[copy-onnx-runtime] expected ${name} in ${dist} but it was not found. ` +
					`Did @huggingface/transformers change its dist layout?`,
			);
		}
		const dest = path.join(publicDir, name);
		const srcSize = fs.statSync(src).size;
		if (fs.existsSync(dest) && fs.statSync(dest).size === srcSize) continue;
		fs.copyFileSync(src, dest);
		copied++;
	}
	console.log(
		`[copy-onnx-runtime] ${copied} file(s) copied to public/onnx/ (${FILES.length} total).`,
	);
}

main();
