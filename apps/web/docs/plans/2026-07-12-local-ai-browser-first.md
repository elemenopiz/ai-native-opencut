# Browser-First Local AI Implementation Plan

> **FROZEN 2026-07-12 per ADR-004** (`docs/decisions/ADR-004-park-local-ai-migration.md`): Tasks 1–9
> (incl. amendments 3.5/5.5 + freeze-completeness gates) are DONE on `feat/local-ai-browser-first`,
> reviewed (spec + quality per task, final whole-branch integration review: READY TO LAND, all four
> freeze criteria PASS), battery green (unit/typecheck/prod build), and browser-verified. Tasks 10–13
> (engagement rehome, `services/` deletion sweep, bookkeeping) are PARKED until after beta — the
> Python stack stays in-repo untouched by design (delete-last). Resume here post-beta.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Repo rules apply on top of this plan: run `impact` before editing symbols, `detect_changes()` before
> committing (see root CLAUDE.md). Multi-session repo — do all work in a dedicated worktree, merge atomically.

**Goal:** Regular users get local AI with zero install: understanding models run in-browser, generation runs on cloud APIs, and the entire `services/` Python stack is deleted.

**Architecture:** Generalize the shipped in-browser Whisper pattern (`lib/transcription/whisper.worker.ts` + `local-whisper.ts`) into `lib/local-ai/` with a CLIP worker; repoint all embedding consumers to it. Build a cloud TTS route and repoint voiceover. Feature-gate everything whose only implementation was the Python stack. Then delete `services/` last, behind a git tag.

**Tech Stack:** `@huggingface/transformers` (Transformers.js, already a dependency — verify version supports `zero-shot-image-classification`/CLIP dual encoders), Next.js 15 route handlers, existing house patterns (`fetchWithTimeout`, RATE_LIMITS, gateOn402, reportError).

**Design doc:** `apps/web/docs/plans/2026-07-12-local-ai-browser-first-design.md`

**Deviation from design doc (approved-pending-owner-glance):** the design listed a *face worker* as a
new component. Recon shows `aiClient.analyzeFaces` (`ai-client.ts:1337` → `/api/analyze/faces`) has **no
production callers** — persona/face reconciliation already runs through the cloud understanding pass
(`asset-understanding-service.ts`, credit-gated). So face-service is deleted with no replacement; an
in-browser ArcFace worker is a post-beta privacy upgrade (license-clean weights still unresolved).

---

## Phase 1 — In-browser CLIP (visual search goes zero-install)

### Task 1: Shared device detection in `lib/local-ai/`

**Files:**
- Create: `apps/web/src/lib/local-ai/device.ts`
- Test: `apps/web/src/lib/local-ai/device.test.ts`
- Modify (consume, no behavior change): `apps/web/src/lib/transcription/local-whisper.ts:58-70`

**Step 1: Write the failing test**

```ts
// apps/web/src/lib/local-ai/device.test.ts
import { describe, expect, it } from "bun:test";
import { pickDevice, isLocalAISupported } from "./device";

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
```

**Step 2: Run it — expect FAIL (module not found)**

Run: `cd apps/web && bun test src/lib/local-ai/device.test.ts`

**Step 3: Implement**

Extract the exact logic currently inlined in `local-whisper.ts` (`pickDevice`, lines 67–70; the Worker
check from `isLocalWhisperSupported`, lines 58–65) into `device.ts`, parameterizing `navigator` for
testability:

```ts
// apps/web/src/lib/local-ai/device.ts
/**
 * Shared device selection for in-browser AI workers (Whisper, CLIP).
 * WebGPU is preferred but never required — every worker has a WASM fallback.
 */
export type LocalAIDevice = "webgpu" | "wasm";

export function pickDevice(nav: Navigator = navigator): LocalAIDevice {
	// biome-ignore lint/suspicious/noExplicitAny: navigator.gpu missing from older lib.dom.
	return (nav as any).gpu ? "webgpu" : "wasm";
}

export function isLocalAISupported(): boolean {
	if (typeof window === "undefined") return false;
	return typeof Worker !== "undefined";
}
```

**Step 4: Repoint `local-whisper.ts`** to import `pickDevice` from `@/lib/local-ai/device` (keep
`isLocalWhisperSupported` where it is — it additionally checks Web Audio, which is Whisper-specific).
Run the existing whisper/transcription tests to prove no regression.

**Step 5: Run tests + commit**

Run: `cd apps/web && bun test src/lib/local-ai src/lib/transcription`
`git add -A && git commit -m "feat(local-ai): shared device detection module"`

---

### Task 2: CLIP worker + main-thread client

**Files:**
- Create: `apps/web/src/lib/local-ai/clip.worker.ts`
- Create: `apps/web/src/lib/local-ai/local-clip.ts`
- Test: `apps/web/src/lib/local-ai/local-clip.test.ts`

Model: `Xenova/clip-vit-base-patch32` (~340MB total, browser-cached after first load). Follow the
messaging contract style of `whisper.worker.ts` exactly (load-progress / result / error message types,
pipeline cached across requests, `env.allowLocalModels = false`).

**Step 1: Failing test for the main-thread client.** Mock the Worker seam the same way the
transcription tests do (constructor-injected worker factory). Assert: `embedTexts(["a dog"])`
posts a `{ kind: "texts" }` message and resolves vectors from the `result` message; a worker `error`
message rejects; vectors are L2-normalized `Float32Array`s.

```ts
// apps/web/src/lib/local-ai/local-clip.test.ts (shape — adapt to house mock style)
import { describe, expect, it } from "bun:test";
import { LocalClip } from "./local-clip";

function fakeWorker(reply: (msg: any) => any) {
	const listeners: Record<string, Function[]> = { message: [], error: [] };
	return {
		addEventListener: (t: string, fn: Function) => listeners[t].push(fn),
		removeEventListener: () => {},
		postMessage: (msg: any) => {
			queueMicrotask(() => {
				for (const fn of listeners.message) fn({ data: reply(msg) });
			});
		},
	} as unknown as Worker;
}

it("embedTexts resolves vectors from the worker", async () => {
	const clip = new LocalClip({
		createWorker: () =>
			fakeWorker((msg) => ({
				type: "result",
				payload: { vectors: msg.payload.texts.map(() => [1, 0, 0]) },
			})),
	});
	const [vec] = await clip.embedTexts(["a dog"]);
	expect(vec).toBeInstanceOf(Float32Array);
	expect(vec.length).toBe(3);
});
```

**Step 2: Run — FAIL.** `bun test src/lib/local-ai/local-clip.test.ts`

**Step 3: Implement the worker:**

```ts
// apps/web/src/lib/local-ai/clip.worker.ts
/**
 * On-device CLIP worker (Transformers.js). Text and image embeddings for
 * visual search — footage never leaves the device; only the one-time,
 * browser-cached model download touches the network.
 *
 * in : { kind: "texts", payload: { texts: string[] }, modelId, device }
 *      { kind: "images", payload: { blobs: Blob[] }, modelId, device }
 * out: { type: "load-progress", payload } | { type: "result", payload: { vectors: number[][] } }
 *      | { type: "error", message }
 */
import {
	AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection,
	CLIPVisionModelWithProjection, RawImage, env,
} from "@huggingface/transformers";

env.allowLocalModels = false;

const ctx = self as unknown as {
	postMessage(m: unknown): void;
	onmessage: ((e: MessageEvent) => void) | null;
};

let loaded: {
	key: string;
	tokenizer: any; processor: any; textModel: any; visionModel: any;
} | null = null;

async function ensure(modelId: string, device: "webgpu" | "wasm") {
	const key = `${modelId}@${device}`;
	if (loaded?.key === key) return loaded;
	const progress_callback = (payload: unknown) =>
		ctx.postMessage({ type: "load-progress", payload });
	const opts = { device, dtype: "q8", progress_callback } as any;
	loaded = {
		key,
		tokenizer: await AutoTokenizer.from_pretrained(modelId, { progress_callback }),
		processor: await AutoProcessor.from_pretrained(modelId, { progress_callback }),
		textModel: await CLIPTextModelWithProjection.from_pretrained(modelId, opts),
		visionModel: await CLIPVisionModelWithProjection.from_pretrained(modelId, opts),
	};
	return loaded;
}

function normalize(rows: number[][]): number[][] {
	return rows.map((v) => {
		const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
		return v.map((x) => x / n);
	});
}

ctx.onmessage = async (event: MessageEvent) => {
	const req = event.data as {
		kind: "texts" | "images";
		payload: { texts?: string[]; blobs?: Blob[] };
		modelId: string; device: "webgpu" | "wasm";
	};
	try {
		const m = await ensure(req.modelId, req.device);
		let vectors: number[][];
		if (req.kind === "texts") {
			const inputs = m.tokenizer(req.payload.texts, { padding: true, truncation: true });
			const out = await m.textModel(inputs);
			vectors = out.text_embeds.tolist();
		} else {
			const images = await Promise.all(
				(req.payload.blobs ?? []).map((b) => RawImage.fromBlob(b)),
			);
			const inputs = await m.processor(images);
			const out = await m.visionModel(inputs);
			vectors = out.image_embeds.tolist();
		}
		ctx.postMessage({ type: "result", payload: { vectors: normalize(vectors) } });
	} catch (err) {
		ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
	}
};

export {};
```

And the client (`local-clip.ts`): mirror `local-whisper.ts` — singleton warm worker
(`createWorker` injectable for tests), one in-flight request queue (serialize; the worker is
single-threaded anyway), `onProgress` callback with `{ stage: "loading-model" | "embedding", progress }`,
public API:

```ts
export const LOCAL_CLIP_MODEL_ID = "Xenova/clip-vit-base-patch32";
export const LOCAL_CLIP_MODEL_NAME = "clip-vit-b32-web"; // stored on embeddings; MUST differ from "ViT-B-32"
export class LocalClip {
	embedTexts(texts: string[], onProgress?): Promise<Float32Array[]>
	embedImages(blobs: Blob[], onProgress?): Promise<Float32Array[]>
}
export const localClip = new LocalClip(); // module singleton
```

**Step 4: tests pass.** **Step 5: Commit** `feat(local-ai): in-browser CLIP worker + client`.

---

### Task 3: Repoint the indexing pipeline (image side)

**Files:**
- Modify: `apps/web/src/services/search/embedding-service.ts` (`embedBatches`, ~line 129; the
  `modelName` default `"ViT-B-32"` in `indexMedia`, ~line 172; any zero-shot-tag `embedTexts` call)
- Test: extend the existing `embedding-service` tests (mock `localClip` instead of `aiClient`)

Replace the FormData/`aiClient.embedFrames` batch with `localClip.embedImages(slice.map(f => f.blob))`.
Change the default `modelName` to `LOCAL_CLIP_MODEL_NAME` — the existing "already indexed for the
current model" check (`existing.modelName === modelName`) then re-indexes every asset automatically,
which is REQUIRED: the old backend used open_clip laion2b weights, a different vector space from the
OpenAI CLIP weights. Do not attempt to mix old and new vectors.

Steps: failing test (embedBatches uses localClip; modelName recorded as `clip-vit-b32-web`) → run FAIL
→ implement → run PASS → `bun test src/services/search` → commit
`feat(local-ai): index media through in-browser CLIP`.

### Task 3.5 (AMENDMENT, design revision 2026-07-12): swappable embedding seam

The revised design doc requires consumers to call an embedding *interface*, never the worker
client directly, so a hosted-API backend can slot in later (face excluded from any flip —
biometric). Introduce `apps/web/src/lib/local-ai/embeddings.ts`:

```ts
export interface EmbeddingBackend {
	embedTexts(texts: string[], onProgress?): Promise<Float32Array[]>;
	embedImages(blobs: Blob[], onProgress?): Promise<Float32Array[]>;
	/** Provenance tag stored on embeddings; distinct per vector space. */
	readonly modelName: string;
}
export const embeddings: EmbeddingBackend = /* localClip-backed adapter */;
```

Repoint `embedding-service.ts` (Task 3 wired it straight to `localClip`) to `embeddings`.
TDD the seam (adapter delegates + exposes `LOCAL_CLIP_MODEL_NAME`). YAGNI: do NOT build the
hosted backend — just the interface + local adapter.
Commit: `feat(local-ai): backend-swappable embedding seam`.

### Task 4: Repoint query-side embeds

**Files:**
- Modify: `apps/web/src/hooks/use-visual-search.ts:107` (`aiClient.embedText` → `embeddings.embedTexts([trimmed])` via the Task 3.5 seam)
- Modify: `apps/web/src/lib/director/director-api.ts:1014` (same swap)
- **AMENDMENT (Task 3 quality review Important #2):** filter record-side reads to the current
  vector space — `use-visual-search`'s `refreshIndex` (`getAllEmbeddings()`) and
  `embedding-service.ts`'s `findDuplicates` must skip records whose
  `modelName !== LOCAL_CLIP_MODEL_NAME`, otherwise stale laion2b vectors pollute search
  rankings and duplicate detection during the re-index window.
- Tests: adjust the two files' existing tests/mocks; add a mixed-model-records test proving
  stale records are excluded.

Note `use-visual-search` already computes `dotProduct` locally — with normalized vectors both sides,
scores stay cosine-compatible; the `threshold = 0.18` default was tuned for laion2b scores, so
re-verify it empirically in Task 5 and adjust the constant if hits look starved or noisy.
Run full search-related tests, commit `feat(local-ai): visual search queries embed in-browser`.

### Task 5: Browser verification (gate for Phase 1)

Start the dev server (Browser pane, launch.json config). In a project with a video asset:
1. trigger indexing (Insights/Library X-Ray view) — expect model-download progress UI, then indexed state;
2. search a visual phrase in the search view — expect ranked hits; verify via `read_console_messages`
   there are no worker errors; confirm NO network request to `localhost:8420` (read_network_requests).
3. Repeat with WebGPU disabled if feasible (WASM fallback) or at minimum assert `pickDevice` fallback
   path is unit-covered.
Fix-forward until green, then commit any threshold tuning.

### Task 5.5 (AMENDMENT, design revision 2026-07-12): editor-priority scheduler + idle unload

The revised design doc adds two framework behaviors to `lib/local-ai/` (in-browser models share
the GPU with the WebGL compositor and CPU with video decode; playback fps is the top-priority
workload):

1. **Editor-has-priority scheduler:** understanding inference runs only while the editor is idle
   or paused — active playback, scrubbing, or export pauses (or heavily throttles) worker
   inference. Implement as a gate the `LocalClip` queue (and Whisper orchestrator) awaits before
   dispatching each request: a small `lib/local-ai/scheduler.ts` subscribing to the playback
   store's play state + export state (find the exact stores; playback state lives in the
   timeline/playback store — verify with the codebase, and note `getCurrentTime` readers freeze
   during playback BY DESIGN, so subscribe to play/pause events, not time). Batch boundaries are
   the natural pause points (requests are already serialized).
2. **Idle unload:** after N minutes (default ~5) with no requests, terminate the warm worker so
   model memory is released (reload from browser cache is cheap). Applies to BOTH the CLIP
   client and the Whisper worker (`local-whisper.ts` keeps its worker warm forever today).
   Implement in one place (shared helper or base class) — not copy-pasted.

TDD with fake timers/fake stores. Deferred WASM-runtime-fallback from Task 2 review can ride
along here if browser verification surfaced it. Commit:
`feat(local-ai): editor-priority scheduling + idle model unload`.

**As-built deviations (recorded post-review, both approved):** (1) Whisper is NOT gated on the
scheduler — transcription is an explicit user action with a visible progress bar (holding it up
to the starvation cap behind a stuck UI is worse than the contention it avoids); Whisper does get
idle unload + crash recycle via the shared WorkerSlot. (2) Follow-up on backlog (Task 13): the
Whisper worker protocol has no request correlation, so overlapping transcribes on the shared
worker cross-resolve — serialize like CLIP or add request IDs before any UI allows concurrent
transcription.

---

## Phase 2 — Cloud TTS + rehoming + feature gates

### Task 6: OWNER CHECKPOINTS (blocking decisions, ask before building)

1. **TTS metering:** new `/api/tts` is a paid provider call. Meter now (reserve/settle like takes)
   or un-metered-for-beta like `/api/llm/enhance-prompt` (its precedent: auth + rate-limit, no credits)?
   Money paths are hard-gated per house rules — get explicit approval. **Default proposal: un-metered
   beta, RATE_LIMITS `tts:generate` 10/min, revisit with credit LOW-findings batch.**
2. **YouTube import:** host a yt-dlp route (ToS/abuse surface) or hide the YouTube panels for beta?
   **Default proposal: hide for beta.**
3. Which cloud TTS provider (OpenAI TTS via existing provider-key plumbing is the least new surface).

### Task 7: Cloud TTS route

**Files:**
- Create: `apps/web/src/app/api/tts/route.ts`
- Test: `apps/web/src/app/api/tts/route.test.ts` (or house route-test location — mirror
  `api/llm/enhance-prompt`'s test placement)
- Modify: `apps/web/src/lib/rate-limit` RATE_LIMITS table (add `tts:generate`)

Copy the `enhance-prompt` route skeleton exactly: session check → 401; rate limit → 429; zod-validate
`{ text, language?, voice? }` (cap text at 4k chars); call provider with `fetchWithTimeout`; return
`audio/mpeg` bytes. TDD: failing tests for 401 / 429 / happy-path (provider fetch mocked) → implement
→ pass → commit `feat(tts): cloud TTS route (auth + rate-limited)`.

### Task 8: Flip voiceover to the cloud route

**Files:**
- Modify: `apps/web/src/lib/ai-client.ts:679` — `generateSpeechBlob` fetches `/api/tts` (relative,
  same-origin) instead of `${this.baseUrl}/api/tts/generate`; drop `speakerWav` from the request.
- Modify: `apps/web/src/lib/studio/generate-voiceover-take.ts` — remove `DEFAULT_TTS_MODEL` (xtts);
  when `spec.voiceRef` (cloned voice) is set, fail the take early with "Voice cloning is unavailable
  in beta" (keep `assertReferenceUsable` consent gate in place ahead of it).
- Modify: `apps/web/src/components/editor/panels/assets/views/voiceover.tsx:345` — same call, hide
  clone-voice picker UI behind the Task 9 gate.
- Tests: update voiceover-take tests; add one asserting the clone-ref early-fail.

Commit `feat(tts): voiceover generates via cloud route; voice cloning gated for beta`.

### Task 9: Feature-gate module + hide orphaned features

**Files:**
- Create: `apps/web/src/lib/local-ai/retired-features.ts`:

```ts
/**
 * Features whose only implementation was the retired Python AI stack
 * (services/*). Each is hidden — not broken — until it gets a new home.
 * Flip to true only when a browser/cloud implementation lands.
 */
export const RETIRED_FEATURES = {
	dubbing: false,          // use-ai-dubbing (pyannote + local TTS)
	musicGen: false,         // use-music-gen (local TTS backend)
	scriptToVideo: false,    // use-script-to-video (local TTS)
	denoise: false,          // use-noise-reduction (audio-properties panel)
	speakerLabels: false,    // podcast-clips diarization labels
	youtubeImport: false,    // youtube panels (yt-dlp) — pending Task 6 decision
	voiceClone: false,       // XTTS speaker_wav path
	engagementScore: false,  // podcast-clips/engagement-panel scoring — see Task 10
} as const;
```

- Modify (hide entry points, render nothing or the existing "unavailable" affordance — NO dead buttons):
  `components/editor/panels/properties/audio-properties.tsx` (denoise section),
  `components/editor/panels/assets/views/podcast-clips.tsx` (speaker labels + engagement columns),
  `components/editor/youtube/engagement-panel.tsx`, `components/editor/youtube/export-panel.tsx`,
  `components/editor/ai/quick-actions-bar.tsx` (any actions invoking retired aiClient methods),
  `components/editor/ai/text-editing-panel.tsx`, voiceover clone-picker (Task 8),
  hooks `use-ai-dubbing.ts` / `use-music-gen.ts` / `use-script-to-video.ts` / `use-noise-reduction.ts`
  (early-return unavailable state when flag off).
- **Coordination:** `settings.tsx`, `insights.tsx`, `director.tsx`, `ai-panel-wrapper.tsx` carry
  uncommitted WIP from a concurrent session — touch them last, rebase-check `git status` first, and
  keep edits minimal/atomic.

TDD: per-surface test that the gated control does not render when the flag is off. Commit
`feat(local-ai): retire-gate features pending new homes`.

### Task 10: Engagement scoring → LLM route (keep, per serious-editor decision the infra stays)

**Files:**
- Create: `apps/web/src/app/api/llm/engagement/route.ts` (LLM-judge: takes clip transcript+metadata,
  returns the `EngagementScoreResult` shape from `ai-client.ts:2099` so consumers don't change)
- Modify: `ai-client.ts` `engagementScore`/`engagementScoreBatch` to call it
- Tests: route 401/429/shape tests; consumer tests unchanged (shape-stable)

If this proves > ~1 day, flip `engagementScore` gate off for beta instead and log a backlog row.
Commit `feat(engagement): scoring via LLM route, local-backend-free`.

---

## Phase 3 — Deletion sweep (LAST, atomic)

### Task 11: Tag, then delete

1. `git tag pre-local-ai-sweep` on the branch base.
2. Delete: `services/` (entire directory, all 9 services).
3. Trim `docker-compose.yml`: keep `db`, `redis`, `serverless-redis-http`, `web`; delete all AI
   services, their volumes (`ollama_data`, `ai_models`, `ai_generated`, `whisper_models`, `tts_models`,
   `image_models`, `speaker_models`, `face_models`, `turboquant_models`, `image_generated`,
   `clip_models`), and the `web` service's `NEXT_PUBLIC_AI_BACKEND_URL` / `*_SERVICE_URL` env lines +
   `ai-backend` depends_on. Delete `docker-compose.gpu.yml`.
4. Delete web-app surfaces: `components/editor/ai/ai-setup-guide.tsx`, `hooks/use-service-health.ts`,
   `hooks/use-ai-status.ts` (verify no other consumers first — `impact` each),
   `components/editor/panels/assets/views/turboquant-model-manager.tsx`, `app/models/page.tsx`,
   `lib/reframe/smartcrop-fallback.ts`'s backend call if present (verify), and every now-dead
   `aiClient` method + interface in `lib/ai-client.ts` (embedText/embedTexts/embedFrames, tts,
   analyzeFaces, findClips, youtube*, denoise, dubbing, engagement passthroughs, services status).
   `types/ai.ts` prune to what survives.
5. Env cleanup: remove `NEXT_PUBLIC_AI_BACKEND_URL` (`packages/env/src/web.ts:12`) and any
   `NEXT_PUBLIC_WHISPER/TTS/IMAGE_SERVICE_URL` reads; purge from `.env.example` with its
   what-breaks notes; remove from `apps/web/Dockerfile` args if present.
6. Docs truth pass: `apps/web/docs/DEPLOY.md` (delete the "local FastAPI AI backend is optional"
   paragraph + AI env rows), onboarding copy (`components/editor/onboarding.tsx` "Local-AI honesty"
   step → new story: "AI runs in your browser and via your provider keys"), `empty-editor-guide` if
   it references local AI, root `README.md`.

### Task 12: Prove it's gone

- `grep -rn "8420\|8421\|8422\|8423\|8424\|8425\|8426\|8430\|11434\|ai-backend\|AI_BACKEND" apps/web/src packages` → **zero hits** (allow historical mentions under `apps/web/docs/`).
- Full battery: `bun run typecheck && bun run test && bun run build && bun run build:e2e && bun run test:e2e` — all green.
- `detect_changes({scope: "compare", base_ref: "main"})` — affected symbols match this plan's file list only.
- Browser smoke: boot, index+search (Phase 1 flow), generate a voiceover take (Phase 2 flow), confirm
  gated features render their unavailable states, 0 console errors.

Commit `chore(local-ai): delete services/ Python stack — browser-first cutover complete`, then merge
per house flow (atomic, check `git log origin/main..main` before any push; pushes are owner-gated).

### Task 13: Post-merge bookkeeping

- Update `apps/web/docs/PROD-READINESS.md` (new row/notes: local-AI story = browser-first; docker AI
  stack deleted).
- Backlog rows: in-browser face/ArcFace worker (license-clean weights), in-browser denoise DSP,
  diarization new home, TTS metering (if beta shipped un-metered), YouTube import decision outcome.
