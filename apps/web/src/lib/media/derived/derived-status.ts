/**
 * `derived` readiness status — the answer to "has anyone looked at this
 * asset yet, and what did they find?" for every kind of analysis Byorn can
 * derive from a media asset.
 *
 * Before this, "no transcript record" meant four very different things with
 * no way to tell them apart: not attempted, in flight, failed, or "this
 * browser can't do it." Those lead to OPPOSITE editorial decisions — e.g. the
 * Director must never treat "nobody has listened yet" (state "absent") the
 * same as "this footage is genuinely silent" (state "empty"). `DerivedStatus`
 * makes that distinction explicit and persisted per asset, per kind.
 *
 * `reason` is USER-VISIBLE (standing product directive: customers never see
 * technical errors). It must always be plain language — never a stack trace,
 * provider/vendor name, env var, or file path. "Couldn't read the audio in
 * this clip", not "ffmpeg exited 1" or "ANTHROPIC_API_KEY missing".
 */

/** One kind of thing that can be derived from a media asset. */
export type DerivedKind =
	| "transcript"
	| "understanding"
	| "embedding"
	| "beats"
	| "loudness"
	| "silence"
	| "shots"
	| "proxy";

/** All kinds this module directly produces (owned by lib/media/derived). */
export const OWNED_DERIVED_KINDS = [
	"beats",
	"loudness",
	"silence",
	"shots",
] as const satisfies readonly DerivedKind[];

export interface DerivedStatus {
	/**
	 * - "absent": never attempted.
	 * - "queued": picked up for analysis, not started yet.
	 * - "running": analysis in progress (see `progress`/`etaSec`).
	 * - "ready": analysis completed and produced a usable result.
	 * - "empty": analysis completed but found nothing (e.g. a silent audio
	 *   track, a single unbroken shot, no rhythmic pulse) — a REAL finding,
	 *   not a missing one.
	 * - "failed": analysis was attempted and threw/errored.
	 * - "unsupported": this asset type or this browser structurally can't
	 *   produce this kind (e.g. "shots" on an audio-only asset).
	 */
	state:
		| "absent"
		| "queued"
		| "running"
		| "ready"
		| "empty"
		| "failed"
		| "unsupported";
	/** 0-1 fraction complete, only meaningful while "running". */
	progress?: number;
	/** Estimated seconds remaining, only meaningful while "running". */
	etaSec?: number;
	/** Generic, non-identifying descriptor of what produced the result (e.g. "on-device"). Never a vendor/provider name. */
	engine?: string;
	/** Plain-language, user-safe explanation — see module doc. Never technical. */
	reason?: string;
	/** Epoch ms this status was last set. */
	at?: number;
}

export type AssetDerived = Record<DerivedKind, DerivedStatus>;

const ABSENT: DerivedStatus = { state: "absent" };

/**
 * A structural "this kind cannot ever apply to this media type" map, used to
 * pre-seed new assets so the UI never has to guess "absent" vs "N/A". Only
 * covers combinations that are ALWAYS unsupported regardless of browser —
 * e.g. an image has no audio track, ever. Browser-capability unsupported
 * cases (e.g. no OfflineAudioContext) are set at analysis time instead.
 */
const STRUCTURALLY_UNSUPPORTED: Partial<
	Record<"video" | "audio" | "image", DerivedKind[]>
> = {
	image: ["beats", "loudness", "silence", "shots", "transcript"],
	audio: ["shots", "embedding"],
};

/** Build the starting `AssetDerived` for a freshly-ingested asset. */
export function createInitialDerived(
	mediaType: "video" | "audio" | "image",
): AssetDerived {
	const unsupported = new Set(STRUCTURALLY_UNSUPPORTED[mediaType] ?? []);
	const kinds: DerivedKind[] = [
		"transcript",
		"understanding",
		"embedding",
		"beats",
		"loudness",
		"silence",
		"shots",
		"proxy",
	];
	const derived = {} as AssetDerived;
	for (const kind of kinds) {
		derived[kind] = unsupported.has(kind)
			? {
					state: "unsupported",
					reason: "not applicable to this media type",
					at: Date.now(),
				}
			: ABSENT;
	}
	return derived;
}

/** Immutably set one kind's status, leaving the rest of the record untouched. */
export function withStatus(
	derived: AssetDerived,
	kind: DerivedKind,
	status: Omit<DerivedStatus, "at"> & { at?: number },
): AssetDerived {
	return {
		...derived,
		[kind]: { ...status, at: status.at ?? Date.now() },
	};
}

export function queued(engine?: string): DerivedStatus {
	return { state: "queued", engine, at: Date.now() };
}

export function running(progress?: number, engine?: string): DerivedStatus {
	return { state: "running", progress, engine, at: Date.now() };
}

export function ready(engine?: string): DerivedStatus {
	return { state: "ready", engine, at: Date.now() };
}

export function empty(reason: string, engine?: string): DerivedStatus {
	return { state: "empty", reason, engine, at: Date.now() };
}

export function failed(reason: string, engine?: string): DerivedStatus {
	return { state: "failed", reason, engine, at: Date.now() };
}

export function unsupported(reason: string): DerivedStatus {
	return { state: "unsupported", reason, at: Date.now() };
}
