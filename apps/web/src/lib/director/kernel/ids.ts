/**
 * The kernel's single id space.
 *
 * WHY THIS EXISTS. Today the Director addresses the same clip two different
 * ways — a reel `slotId` and a timeline `elementId` — and every verb picks one.
 * That split is not cosmetic: it is the direct cause of the "Director cannot
 * trim its own uploaded footage" bug class, because a verb that resolves only
 * slots simply cannot see an element that was never generated. One id space
 * makes that bug unspellable rather than fixed.
 *
 * A kernel id is `kind:raw` — self-typed, so a single polymorphic verb can
 * dispatch on it without being told what it was handed. `raw` is whatever the
 * owning manager already calls the thing (a uuid, a slot id, a commit sha); we
 * do not renumber anything.
 *
 * TOLERANT ON THE WAY IN, STRICT ON THE WAY OUT. {@link coerceId} accepts a
 * bare id from a model that forgot the prefix and, given a `hint`, returns the
 * qualified form. Everything this module HANDS BACK is always fully qualified,
 * so the ids a model sees in a `read` are always the ids it can pass to
 * `update` — the round trip is closed by construction.
 */

export const KERNEL_KINDS = [
	"project",
	"asset",
	"track",
	"element",
	"take",
	"effect",
	"keyframe",
	"marker",
	"scene",
	"commit",
	"branch",
	"selection",
	"playhead",
	"history",
	"brief",
	"bible",
	"budget",
	"consent",
] as const;

export type KernelKind = (typeof KERNEL_KINDS)[number];

/** `kind:raw`, e.g. `element:9f1c…`. Branded only by convention — see {@link parseId}. */
export type KernelId = `${KernelKind}:${string}`;

const KIND_SET = new Set<string>(KERNEL_KINDS);

export function isKernelKind(value: string): value is KernelKind {
	return KIND_SET.has(value);
}

export function formatId(kind: KernelKind, raw: string): KernelId {
	return `${kind}:${raw}` as KernelId;
}

export interface ParsedId {
	kind: KernelKind;
	raw: string;
}

/**
 * Split a qualified id, or throw a message that TEACHES. A bare uuid is the
 * single most likely thing a model sends here, so that case names the fix
 * rather than restating the grammar.
 */
export function parseId(id: string): ParsedId {
	const colon = id.indexOf(":");
	if (colon === -1) {
		throw new KernelIdError(
			`"${id}" is missing its kind prefix. Ids are "kind:raw" — e.g. "element:${id}". Valid kinds: ${KERNEL_KINDS.join(", ")}.`,
		);
	}
	const kind = id.slice(0, colon);
	const raw = id.slice(colon + 1);
	if (!isKernelKind(kind)) {
		const near = nearestKind(kind);
		throw new KernelIdError(
			`"${kind}" is not an addressable kind${near ? ` — did you mean "${near}"?` : ""}. Valid kinds: ${KERNEL_KINDS.join(", ")}.`,
		);
	}
	if (!raw) {
		throw new KernelIdError(`"${id}" has a kind but no id after the colon.`);
	}
	return { kind, raw };
}

/** Accept an unqualified id when the caller already knows what it must be. */
export function coerceId(value: string, hint: KernelKind): KernelId {
	return value.includes(":") ? (value as KernelId) : formatId(hint, value);
}

export class KernelIdError extends Error {
	readonly name = "KernelIdError";
}

/** Levenshtein, capped — only ever run against the 18 kind names. */
export function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	let prev = Array.from({ length: cols }, (_, i) => i);
	for (let i = 1; i < rows; i += 1) {
		const next = [i];
		for (let j = 1; j < cols; j += 1) {
			next[j] = Math.min(
				prev[j] + 1,
				next[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = next;
	}
	return prev[cols - 1];
}

/** The closest kind name within a small edit budget, or null when nothing is close. */
export function nearestKind(attempted: string): KernelKind | null {
	let best: KernelKind | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	const budget = attempted.length <= 4 ? 1 : 3;
	for (const kind of KERNEL_KINDS) {
		const score = editDistance(attempted.toLowerCase(), kind);
		if (score < bestScore) {
			bestScore = score;
			best = kind;
		}
	}
	return bestScore <= budget ? best : null;
}
