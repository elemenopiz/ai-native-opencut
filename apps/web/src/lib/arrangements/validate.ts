import type { Arrangement, ArrangementSlot, ArrangementText } from "@/types/arrangement";
import { ARRANGEMENT_VERSION } from "@/types/arrangement";

/**
 * Runtime validation for an untrusted arrangement payload (e.g. arriving at the
 * public share endpoint or being loaded from a link). Returns a normalized,
 * media-free arrangement or throws. Kept intentionally strict and boring — it is
 * a trust boundary.
 */

const MAX_SLOTS = 100;
const MAX_OVERLAYS = 100;
const MAX_STR = 2000;

function str(v: unknown, max = MAX_STR): string {
	if (typeof v !== "string") throw new Error("expected string");
	if (v.length > max) throw new Error("string too long");
	return v;
}

function num(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("expected number");
	return v;
}

function optNum(v: unknown): number | undefined {
	return v === undefined || v === null ? undefined : num(v);
}

function normalizeSlot(raw: unknown): ArrangementSlot {
	if (typeof raw !== "object" || raw === null) throw new Error("slot must be an object");
	const s = raw as Record<string, unknown>;
	const kind = s.kind === "image" ? "image" : "video";

	let recipe: ArrangementSlot["recipe"];
	if (s.recipe && typeof s.recipe === "object") {
		const r = s.recipe as Record<string, unknown>;
		recipe = {
			prompt: str(r.prompt ?? ""),
			mode: r.mode === "image-to-video" ? "image-to-video" : "text-to-video",
			resolution: (["480p", "720p", "1080p"].includes(r.resolution as string)
				? r.resolution
				: "720p") as "480p" | "720p" | "1080p",
			orientation: (["landscape", "portrait", "square"].includes(
				r.orientation as string,
			)
				? r.orientation
				: "landscape") as "landscape" | "portrait" | "square",
			duration: num(r.duration ?? s.duration ?? 5),
			...(typeof r.provider === "string" ? { provider: str(r.provider, 100) } : {}),
			...(typeof r.model === "string" ? { model: str(r.model, 100) } : {}),
			...(typeof r.cameraPreset === "string"
				? { cameraPreset: str(r.cameraPreset, 100) }
				: {}),
			...(r.consistencyMode === "high" ||
			r.consistencyMode === "fast" ||
			r.consistencyMode === "durable"
				? { consistencyMode: r.consistencyMode }
				: {}),
		};
	}

	return {
		id: str(s.id ?? crypto.randomUUID(), 64),
		kind,
		lane: Math.max(0, Math.floor(num(s.lane ?? 0))),
		startTime: Math.max(0, num(s.startTime ?? 0)),
		duration: Math.max(0.1, num(s.duration ?? 5)),
		...(typeof s.label === "string" ? { label: str(s.label, 200) } : {}),
		...(recipe ? { recipe } : {}),
		...(s.transitionOut && typeof s.transitionOut === "object"
			? {
					transitionOut: {
						type: str((s.transitionOut as Record<string, unknown>).type ?? "fade", 40),
						duration: num((s.transitionOut as Record<string, unknown>).duration ?? 0.4),
					},
				}
			: {}),
		...(s.transform ? { transform: s.transform as ArrangementSlot["transform"] } : {}),
		...(s.opacity !== undefined ? { opacity: optNum(s.opacity) } : {}),
	};
}

function normalizeOverlay(raw: unknown): ArrangementText {
	if (typeof raw !== "object" || raw === null) throw new Error("overlay must be an object");
	const o = raw as Record<string, unknown>;
	return {
		id: str(o.id ?? crypto.randomUUID(), 64),
		lane: Math.max(0, Math.floor(num(o.lane ?? 0))),
		startTime: Math.max(0, num(o.startTime ?? 0)),
		duration: Math.max(0.1, num(o.duration ?? 5)),
		content: str(o.content ?? ""),
		fontSize: num(o.fontSize ?? 24),
		fontFamily: str(o.fontFamily ?? "Arial", 100),
		color: str(o.color ?? "#ffffff", 40),
		textAlign: (["left", "center", "right"].includes(o.textAlign as string)
			? o.textAlign
			: "center") as "left" | "center" | "right",
		fontWeight: o.fontWeight === "bold" ? "bold" : "normal",
		fontStyle: o.fontStyle === "italic" ? "italic" : "normal",
		...(o.background ? { background: o.background as ArrangementText["background"] } : {}),
		...(o.transform ? { transform: o.transform as ArrangementText["transform"] } : {}),
		...(o.opacity !== undefined ? { opacity: optNum(o.opacity) } : {}),
	};
}

export function validateArrangement(raw: unknown): Arrangement {
	if (typeof raw !== "object" || raw === null) {
		throw new Error("arrangement must be an object");
	}
	const a = raw as Record<string, unknown>;

	const slotsRaw = Array.isArray(a.slots) ? a.slots : [];
	const overlaysRaw = Array.isArray(a.overlays) ? a.overlays : [];
	if (slotsRaw.length > MAX_SLOTS) throw new Error("too many slots");
	if (overlaysRaw.length > MAX_OVERLAYS) throw new Error("too many overlays");

	const slots = slotsRaw.map(normalizeSlot);
	const overlays = overlaysRaw.map(normalizeOverlay);

	let canvas: Arrangement["canvas"];
	if (a.canvas && typeof a.canvas === "object") {
		const c = a.canvas as Record<string, unknown>;
		canvas = { width: num(c.width), height: num(c.height) };
	}

	return {
		version: ARRANGEMENT_VERSION,
		name: str(a.name ?? "Untitled arrangement", 200),
		...(typeof a.description === "string" ? { description: str(a.description) } : {}),
		...(canvas ? { canvas } : {}),
		...(a.fps !== undefined ? { fps: optNum(a.fps) } : {}),
		totalDuration: num(a.totalDuration ?? total(slots)),
		slots,
		overlays,
	};
}

function total(slots: ArrangementSlot[]): number {
	return slots.reduce((max, s) => Math.max(max, s.startTime + s.duration), 0);
}
