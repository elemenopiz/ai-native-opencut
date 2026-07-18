"use client";

import { useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import {
	getAllTransitions,
	getTransition,
	hasTransition,
	TRANSITION_ADJACENCY_EPSILON,
	type TransitionDefinition,
} from "@/lib/transitions";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import type { EditorCore } from "@/core";
import {
	AddTransitionCommand,
	RemoveTransitionCommand,
} from "@/lib/commands/timeline/element/transitions/add-transition";
import { isVisualElement } from "@/lib/timeline";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";

const CATEGORY_ICONS: Record<string, string> = {
	dissolve: "◐",
	slide: "▶",
	wipe: "▮",
	zoom: "⊕",
	dip: "◻",
	iris: "◉",
	morph: "≈",
	distortion: "∿",
	burn: "❋",
	peel: "◲",
	spin: "↻",
	cube: "▣",
	pattern: "▦",
};

const CATEGORY_LABELS: Record<string, string> = {
	dissolve: "Dissolve",
	slide: "Slide",
	wipe: "Wipe",
	zoom: "Zoom",
	dip: "Dip",
	iris: "Iris",
	morph: "Morph",
	distortion: "Distortion",
	burn: "Burn",
	peel: "Peel",
	spin: "Spin",
	cube: "3D",
	pattern: "Pattern",
};

/**
 * Duration bounds for the applied-transition slider. Generous enough to
 * cover every built-in defaultDuration (0.5–0.8s) with headroom, without
 * letting a transition run absurdly long on a short clip.
 */
const MIN_TRANSITION_DURATION = 0.1;
const MAX_TRANSITION_DURATION = 3;

export function TransitionsView() {
	const editor = useEditor();
	const transitions = getAllTransitions();
	const categories = Array.from(new Set(transitions.map((t) => t.category)));
	const applied = getAppliedTransition({ editor });

	return (
		<PanelView title="Transitions">
			<p className="text-[11px] text-muted-foreground px-1 pb-2">
				Select a clip on the timeline, then click a transition to apply it to
				the outgoing edge.
			</p>
			{applied && <AppliedTransitionPanel editor={editor} applied={applied} />}
			{categories.map((category) => (
				<div key={category} className="mb-3">
					<h3 className="text-[11px] font-medium text-muted-foreground mb-1.5 px-1">
						{CATEGORY_LABELS[category] ?? category}
					</h3>
					<div
						className="grid gap-2"
						style={{
							gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
						}}
					>
						{transitions
							.filter((t) => t.category === category)
							.map((transition) => (
								<TransitionItem
									key={transition.type}
									transition={transition}
									isApplied={applied?.transitionType === transition.type}
								/>
							))}
					</div>
				</div>
			))}
		</PanelView>
	);
}

function TransitionItem({
	transition,
	isApplied,
}: {
	transition: TransitionDefinition;
	isApplied: boolean;
}) {
	const editor = useEditor();

	const handleApply = useCallback(() => {
		const selected = editor.selection.getSelectedElements();
		if (selected.length === 0) {
			toast.error("Select a clip on the timeline first");
			return;
		}

		const { elementId, trackId } = selected[0];
		const tracks = editor.timeline.getTracks();
		const track = tracks.find((t) => t.id === trackId);
		if (!track) return;
		const element = track.elements.find((e) => e.id === elementId);
		if (!element || !isVisualElement(element)) return;

		if (element.type !== "video" && element.type !== "image") {
			toast.error("Transitions apply to video or image clips");
			return;
		}

		// A cut transition blends this clip into the next one — it needs an
		// adjacent video/image clip on the same track to blend into.
		const sorted = track.elements
			.filter((el) => !("hidden" in el && el.hidden))
			.slice()
			.sort((a, b) => a.startTime - b.startTime);
		const index = sorted.findIndex((el) => el.id === element.id);
		const next = index >= 0 ? sorted[index + 1] : undefined;

		if (!next) {
			toast.error(
				"This is the last clip on its track — transitions play across the cut into the next clip",
			);
			return;
		}
		if (next.type !== "video" && next.type !== "image") {
			toast.error("The next clip must be a video or image to transition into");
			return;
		}
		if (
			next.startTime - (element.startTime + element.duration) >
			TRANSITION_ADJACENCY_EPSILON
		) {
			toast.error(
				"There's a gap after this clip — snap the next clip against it, then apply the transition",
			);
			return;
		}

		editor.command.execute({
			command: new AddTransitionCommand({
				trackId,
				elementId,
				transitionType: transition.type,
			}),
		});
	}, [editor, transition.type]);

	return (
		<button
			type="button"
			onClick={handleApply}
			title={transition.name}
			className={cn(
				"flex flex-col items-center gap-1.5 rounded-md border p-2",
				"hover:bg-accent/50 transition-colors cursor-pointer",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				isApplied && "border-primary/60 ring-1 ring-primary/40",
			)}
		>
			<div className="relative size-12 shrink-0 overflow-hidden rounded bg-muted/50">
				<TransitionPreview transition={transition} />
			</div>
			<span className="text-[11px] text-center leading-tight truncate w-full">
				{transition.name}
			</span>
		</button>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// Applied-transition duration control
//
// The timeline element badge (timeline-element.tsx) shows *that* a transition
// is applied, but has no way to change its length. Since this panel is the
// natural place a user goes to think about transitions, surface the control
// here: when exactly one clip with an applied transition is selected, show
// its name plus a duration slider that live-updates the transition length.
// ─────────────────────────────────────────────────────────────────────────

interface AppliedTransition {
	trackId: string;
	elementId: string;
	transitionType: string;
	duration: number;
	definition: TransitionDefinition | null;
	maxDuration: number;
}

function getAppliedTransition({
	editor,
}: {
	editor: EditorCore;
}): AppliedTransition | null {
	const selected = editor.selection.getSelectedElements();
	if (selected.length !== 1) return null;

	const { trackId, elementId } = selected[0];
	const track = editor.timeline.getTracks().find((t) => t.id === trackId);
	if (!track) return null;
	const element = track.elements.find((e) => e.id === elementId);
	if (!element || !isVisualElement(element)) return null;

	const transitionOut =
		"transitionOut" in element ? element.transitionOut : undefined;
	if (!transitionOut) return null;

	const sorted = track.elements
		.filter((el) => !("hidden" in el && el.hidden))
		.slice()
		.sort((a, b) => a.startTime - b.startTime);
	const index = sorted.findIndex((el) => el.id === element.id);
	const next = index >= 0 ? sorted[index + 1] : undefined;

	const maxDuration = Math.max(
		MIN_TRANSITION_DURATION,
		Math.min(
			MAX_TRANSITION_DURATION,
			element.duration,
			next ? next.duration : MAX_TRANSITION_DURATION,
		),
	);

	return {
		trackId,
		elementId,
		transitionType: transitionOut.type,
		duration: transitionOut.duration,
		definition: hasTransition({ transitionType: transitionOut.type })
			? getTransition({ transitionType: transitionOut.type })
			: null,
		maxDuration,
	};
}

function AppliedTransitionPanel({
	editor,
	applied,
}: {
	editor: EditorCore;
	applied: AppliedTransition;
}) {
	const handleDurationChange = (value: number) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId: applied.trackId,
					elementId: applied.elementId,
					updates: {
						transitionOut: {
							type: applied.transitionType,
							duration: value,
						},
					},
				},
			],
		});
	};

	const handleRemove = () => {
		editor.command.execute({
			command: new RemoveTransitionCommand({
				trackId: applied.trackId,
				elementId: applied.elementId,
			}),
		});
	};

	return (
		<div className="mb-3 rounded-md border bg-muted/30 p-2.5">
			<div className="flex items-center gap-2">
				<div className="relative size-8 shrink-0 overflow-hidden rounded bg-muted/50">
					{applied.definition && (
						<TransitionPreview transition={applied.definition} />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[11px] font-medium">
						{applied.definition?.name ?? applied.transitionType}
					</div>
					<div className="text-[10px] text-muted-foreground">
						Applied to selected clip
					</div>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-[10px]"
					onClick={handleRemove}
				>
					Remove
				</Button>
			</div>
			<div className="mt-2.5 flex flex-col gap-1">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground">Duration</span>
					<span className="text-[10px] tabular-nums text-muted-foreground">
						{applied.duration.toFixed(2)}s
					</span>
				</div>
				<Slider
					value={[applied.duration]}
					min={MIN_TRANSITION_DURATION}
					max={applied.maxDuration}
					step={0.05}
					onValueChange={([value]) =>
						handleDurationChange(Math.round(value * 100) / 100)
					}
				/>
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-transition preview icons
//
// The old icon was a single glyph per *category* (CATEGORY_ICONS), so e.g.
// every "dissolve" transition (Cross Dissolve, Fade Grayscale, Color Phase,
// Perlin Dissolve, Linear Blur, Dissolve with Zoom) rendered the exact same
// "◐" glyph. These specs give each registered transition *type* its own
// small CSS/SVG preview that gestures at what it actually does, so the panel
// is scannable at a glance instead of a wall of identical tiles. Anything
// not covered here (e.g. a transition registered later) falls back to the
// old category glyph.
// ─────────────────────────────────────────────────────────────────────────

const CLIP_A = "#5b8def";
const CLIP_B = "#f0955a";

type PreviewSpec =
	| {
			kind: "blend";
			gradient: string;
			filter?: string;
			grain?: boolean;
	  }
	| { kind: "crossfade"; ring?: boolean }
	| {
			kind: "split";
			axis: "h" | "v" | "diag";
			soft?: boolean;
			/** Blurred trailing edge at the seam — reads as "panels sliding past
			 *  each other" rather than a clean wipe cut. */
			motion?: boolean;
			arrow?: "left" | "right" | "up" | "down" | "diag" | "chevron";
	  }
	| { kind: "iris"; variant: "wipe" | "reveal" | "open" | "crop" }
	| { kind: "zoom"; variant: "burst" | "simple" | "cross" | "dreamy" }
	| { kind: "wedge"; variant: "clock" | "hard" | "soft" }
	| { kind: "spin"; blades: number; vanish?: boolean }
	| { kind: "spiral" }
	| { kind: "kaleido" }
	| { kind: "glitch"; axis: "h" | "diag"; heavy?: boolean }
	| { kind: "burn"; variant: "leak" | "smooth" | "undulate" }
	| {
			kind: "grid";
			variant:
				| "checker"
				| "pixelize"
				| "mosaic"
				| "flip"
				| "random"
				| "wire"
				| "hex"
				| "hatch"
				| "dots"
				| "bars"
				| "vbars"
				| "blinds";
	  }
	| { kind: "melt" }
	| {
			kind: "warp";
			variant: "wave" | "stretch" | "smear" | "soft" | "facet" | "mirror";
	  }
	| { kind: "cube"; variant: "spin" | "static" | "doorway" | "swap" }
	| { kind: "peel" }
	| { kind: "bounce" }
	| { kind: "heart" }
	| { kind: "wind" }
	| { kind: "ripple"; drop?: boolean };

const GRAYSCALE_GRADIENT = `linear-gradient(90deg, ${CLIP_A}, #9ca3af)`;
const RAINBOW_GRADIENT =
	"linear-gradient(90deg, #ef4444, #f59e0b, #22c55e, #06b6d4, #6366f1, #ec4899)";

const PREVIEW_SPECS: Record<string, PreviewSpec> = {
	// ── dissolve ─────────────────────────────────────────────────────────
	"cross-dissolve": { kind: "crossfade" },
	"dissolve-zoom": { kind: "crossfade", ring: true },
	"fade-grayscale": { kind: "blend", gradient: GRAYSCALE_GRADIENT },
	"color-phase": { kind: "blend", gradient: RAINBOW_GRADIENT },
	perlin: { kind: "blend", gradient: GRAYSCALE_GRADIENT, grain: true },
	"linear-blur": {
		kind: "blend",
		gradient: `linear-gradient(135deg, ${CLIP_A}, ${CLIP_B})`,
		filter: "blur(2.5px)",
	},

	// ── dip ──────────────────────────────────────────────────────────────
	"dip-black": {
		kind: "blend",
		gradient: `linear-gradient(90deg, ${CLIP_A} 0%, #050505 50%, ${CLIP_B} 100%)`,
	},
	"fade-white": {
		kind: "blend",
		gradient: `linear-gradient(90deg, ${CLIP_A} 0%, #f8fafc 50%, ${CLIP_B} 100%)`,
	},
	"fade-color": {
		kind: "blend",
		gradient: `linear-gradient(90deg, ${CLIP_A} 0%, #ec4899 50%, ${CLIP_B} 100%)`,
	},

	// ── slide / push ─────────────────────────────────────────────────────
	"slide-left": { kind: "split", axis: "h", motion: true, arrow: "left" },
	"slide-right": { kind: "split", axis: "h", motion: true, arrow: "right" },
	push: { kind: "split", axis: "h", motion: true, arrow: "chevron" },
	"band-slide": { kind: "grid", variant: "bars" },
	bounce: { kind: "bounce" },

	// ── wipe ─────────────────────────────────────────────────────────────
	"wipe-left": { kind: "split", axis: "h", soft: false, arrow: "left" },
	"wipe-right": { kind: "split", axis: "h", soft: false, arrow: "right" },
	"wipe-up": { kind: "split", axis: "v", soft: false, arrow: "up" },
	"wipe-down": { kind: "split", axis: "v", soft: false, arrow: "down" },
	"directional-wipe": {
		kind: "split",
		axis: "diag",
		soft: true,
		arrow: "diag",
	},
	angular: { kind: "wedge", variant: "hard" },
	radial: { kind: "wedge", variant: "soft" },
	"clock-wipe": { kind: "wedge", variant: "clock" },
	wind: { kind: "wind" },
	"window-slice": { kind: "grid", variant: "vbars" },
	"window-blinds": { kind: "grid", variant: "blinds" },
	"doom-screen": { kind: "melt" },

	// ── zoom ─────────────────────────────────────────────────────────────
	zoom: { kind: "zoom", variant: "burst" },
	"simple-zoom": { kind: "zoom", variant: "simple" },
	"cross-zoom": { kind: "zoom", variant: "cross" },
	"dreamy-zoom": { kind: "zoom", variant: "dreamy" },

	// ── iris ─────────────────────────────────────────────────────────────
	"iris-wipe": { kind: "iris", variant: "wipe" },
	circle: { kind: "iris", variant: "reveal" },
	"circle-open": { kind: "iris", variant: "open" },
	"circle-crop": { kind: "iris", variant: "crop" },
	heart: { kind: "heart" },
	"polka-dots-curtain": { kind: "grid", variant: "dots" },

	// ── morph ────────────────────────────────────────────────────────────
	morph: { kind: "warp", variant: "wave" },
	"cross-warp": { kind: "warp", variant: "stretch" },
	"directional-warp": { kind: "warp", variant: "smear" },

	// ── distortion ───────────────────────────────────────────────────────
	glitch: { kind: "glitch", axis: "h" },
	"glitch-memories": { kind: "glitch", axis: "h", heavy: true },
	"glitch-displace": { kind: "glitch", axis: "diag" },
	ripple: { kind: "ripple" },
	"water-drop": { kind: "ripple", drop: true },
	swirl: { kind: "spiral" },
	dreamy: { kind: "warp", variant: "soft" },
	"fly-eye": { kind: "warp", variant: "facet" },
	"butterfly-wave": { kind: "warp", variant: "mirror" },
	kaleidoscope: { kind: "kaleido" },

	// ── burn ─────────────────────────────────────────────────────────────
	"film-burn": { kind: "burn", variant: "leak" },
	burn: { kind: "burn", variant: "smooth" },
	"undulating-burn-out": { kind: "burn", variant: "undulate" },

	// ── peel ─────────────────────────────────────────────────────────────
	"page-peel": { kind: "peel" },

	// ── spin ─────────────────────────────────────────────────────────────
	spin: { kind: "spin", blades: 4 },
	pinwheel: { kind: "spin", blades: 6 },
	"rotate-scale-vanish": { kind: "spin", blades: 4, vanish: true },

	// ── cube ─────────────────────────────────────────────────────────────
	"cube-spin": { kind: "cube", variant: "spin" },
	cube: { kind: "cube", variant: "static" },
	doorway: { kind: "cube", variant: "doorway" },
	swap: { kind: "cube", variant: "swap" },

	// ── pattern ──────────────────────────────────────────────────────────
	checkerboard: { kind: "grid", variant: "checker" },
	pixelize: { kind: "grid", variant: "pixelize" },
	mosaic: { kind: "grid", variant: "mosaic" },
	"grid-flip": { kind: "grid", variant: "flip" },
	"random-squares": { kind: "grid", variant: "random" },
	"squares-wire": { kind: "grid", variant: "wire" },
	hexagonalize: { kind: "grid", variant: "hex" },
	crosshatch: { kind: "grid", variant: "hatch" },
};

function TransitionPreview({
	transition,
}: {
	transition: TransitionDefinition;
}) {
	const spec = PREVIEW_SPECS[transition.type];
	if (!spec) {
		return (
			<div className="flex size-full items-center justify-center text-lg text-muted-foreground">
				{CATEGORY_ICONS[transition.category] ?? "◇"}
			</div>
		);
	}
	return <PreviewSwatch spec={spec} />;
}

function PreviewSwatch({ spec }: { spec: PreviewSpec }) {
	switch (spec.kind) {
		case "blend":
			return (
				<div
					className="absolute inset-0"
					style={{ background: spec.gradient, filter: spec.filter }}
				>
					{spec.grain && <GrainOverlay />}
				</div>
			);

		case "crossfade":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<div
						className="absolute size-[70%] rounded-full"
						style={{
							left: "2%",
							top: "18%",
							background: CLIP_A,
							opacity: 0.85,
							mixBlendMode: "screen",
						}}
					/>
					<div
						className="absolute size-[70%] rounded-full"
						style={{
							right: "2%",
							bottom: "18%",
							background: CLIP_B,
							opacity: 0.85,
							mixBlendMode: "screen",
						}}
					/>
					{spec.ring && <RingsOverlay count={2} />}
				</div>
			);

		case "split": {
			const gradientDirection =
				spec.axis === "v"
					? "180deg"
					: spec.axis === "diag"
						? "115deg"
						: "90deg";
			const trailOffset =
				spec.arrow === "left" ? "34%" : spec.arrow === "right" ? "48%" : "41%";
			return (
				<div
					className="absolute inset-0"
					style={{
						background: `linear-gradient(${gradientDirection}, ${CLIP_A} 50%, ${CLIP_B} 50%)`,
						filter: spec.soft ? "blur(1.5px)" : undefined,
					}}
				>
					{spec.motion && (
						<div
							className="absolute inset-y-0 w-[18%]"
							style={{
								left: trailOffset,
								background:
									"linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
								filter: "blur(2px)",
							}}
						/>
					)}
					{spec.arrow === "chevron" ? (
						<ChevronsOverlay />
					) : spec.arrow ? (
						<ArrowOverlay direction={spec.arrow} />
					) : null}
				</div>
			);
		}

		case "iris": {
			const inverted = spec.variant === "crop";
			const circleSize =
				spec.variant === "open"
					? "62%"
					: spec.variant === "wipe"
						? "50%"
						: "44%";
			return (
				<div
					className="absolute inset-0"
					style={{ background: inverted ? CLIP_A : "#111319" }}
				>
					<div
						className="absolute rounded-full"
						style={{
							left: "50%",
							top: "50%",
							width: circleSize,
							height: circleSize,
							transform: "translate(-50%, -50%)",
							background: inverted ? "#111319" : CLIP_B,
							boxShadow:
								spec.variant === "wipe"
									? `0 0 0 2px ${CLIP_A}66 inset`
									: undefined,
						}}
					/>
				</div>
			);
		}

		case "zoom": {
			const base =
				spec.variant === "dreamy"
					? "radial-gradient(circle, #d8b4fe, #6d28d9)"
					: spec.variant === "cross"
						? `radial-gradient(circle, ${CLIP_A}, ${CLIP_B})`
						: `radial-gradient(circle, ${CLIP_B}, #111319)`;
			return (
				<div
					className="absolute inset-0"
					style={{
						background: base,
						filter: spec.variant === "dreamy" ? "blur(1px)" : undefined,
					}}
				>
					{spec.variant === "simple" ? (
						<RingsOverlay count={1} />
					) : (
						<BurstOverlay />
					)}
				</div>
			);
		}

		case "wedge": {
			const stops =
				spec.variant === "hard"
					? `conic-gradient(${CLIP_A} 0deg 180deg, ${CLIP_B} 180deg 360deg)`
					: spec.variant === "clock"
						? `conic-gradient(${CLIP_B} 0deg 90deg, ${CLIP_A} 90deg 360deg)`
						: `conic-gradient(${CLIP_A}, ${CLIP_B}, ${CLIP_A})`;
			return (
				<div className="absolute inset-0" style={{ background: stops }}>
					{spec.variant === "clock" && <ClockHandOverlay />}
				</div>
			);
		}

		case "spin":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<PinwheelOverlay blades={spec.blades} faded={spec.vanish} />
				</div>
			);

		case "spiral":
			return (
				<div
					className="absolute inset-0"
					style={{
						background: `conic-gradient(from 0deg, ${CLIP_A}, ${CLIP_B}, ${CLIP_A}, ${CLIP_B}, ${CLIP_A})`,
					}}
				>
					<SpiralOverlay />
				</div>
			);

		case "kaleido":
			return (
				<div
					className="absolute inset-0"
					style={{
						background: `repeating-conic-gradient(${CLIP_A} 0deg 15deg, ${CLIP_B} 15deg 30deg)`,
					}}
				/>
			);

		case "glitch":
			return (
				<div className="absolute inset-0 bg-[#0a0a0a]">
					<GlitchOverlay axis={spec.axis} heavy={spec.heavy} />
				</div>
			);

		case "burn": {
			const glow =
				spec.variant === "leak"
					? "radial-gradient(circle at 25% 30%, #fde68a, #f97316 45%, #7c2d12 80%)"
					: spec.variant === "undulate"
						? "radial-gradient(circle, #fb923c, #991b1b 75%)"
						: "radial-gradient(circle, #fbbf24, #b91c1c 70%)";
			return (
				<div
					className="absolute inset-0 bg-[#1a0d05]"
					style={{
						clipPath:
							spec.variant === "undulate"
								? "polygon(50% 2%, 68% 10%, 82% 24%, 92% 42%, 96% 62%, 84% 82%, 64% 94%, 42% 96%, 22% 86%, 8% 66%, 6% 44%, 16% 22%, 32% 8%)"
								: undefined,
					}}
				>
					<div className="absolute inset-0" style={{ background: glow }} />
				</div>
			);
		}

		case "grid":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<GridOverlay variant={spec.variant} />
				</div>
			);

		case "melt":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<MeltOverlay />
				</div>
			);

		case "warp": {
			const base =
				spec.variant === "soft"
					? "linear-gradient(135deg, #c4b5fd, #7dd3fc)"
					: `linear-gradient(135deg, ${CLIP_A}, ${CLIP_B})`;
			return (
				<div
					className="absolute inset-0"
					style={{
						background: base,
						filter: spec.variant === "soft" ? "blur(2px)" : undefined,
						transform:
							spec.variant === "stretch"
								? "skewX(-10deg) scale(1.15)"
								: undefined,
					}}
				>
					{spec.variant === "facet" ? (
						<FacetOverlay />
					) : spec.variant === "mirror" ? (
						<ButterflyOverlay />
					) : (
						<WaveOverlay smear={spec.variant === "smear"} />
					)}
				</div>
			);
		}

		case "cube":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<CubeOverlay variant={spec.variant} />
				</div>
			);

		case "peel":
			return (
				<div className="absolute inset-0" style={{ background: CLIP_A }}>
					<div
						className="absolute"
						style={{
							right: 0,
							bottom: 0,
							width: "55%",
							height: "55%",
							background: CLIP_B,
							clipPath: "polygon(100% 0, 0 100%, 100% 100%)",
							boxShadow: "-4px -4px 6px -2px rgba(0,0,0,0.45) inset",
						}}
					/>
				</div>
			);

		case "bounce":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<BounceOverlay />
				</div>
			);

		case "heart":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<svg
						viewBox="0 0 100 100"
						className="absolute inset-0 size-full"
						aria-hidden="true"
					>
						<path
							d="M50 88 12 54a22 22 0 0 1 31-31l7 7 7-7a22 22 0 0 1 31 31Z"
							fill="#ec4899"
						/>
					</svg>
				</div>
			);

		case "wind":
			return (
				<div className="absolute inset-0 bg-[#111319]">
					<WindOverlay />
				</div>
			);

		case "ripple":
			return (
				<div className="absolute inset-0" style={{ background: CLIP_A }}>
					<RingsOverlay count={3} />
					{spec.drop && (
						<div
							className="absolute rounded-full"
							style={{
								left: "44%",
								top: "38%",
								width: "12%",
								height: "12%",
								background: "#f8fafc",
							}}
						/>
					)}
				</div>
			);

		default:
			return null;
	}
}

function GrainOverlay() {
	return (
		<svg className="absolute inset-0 size-full opacity-60" aria-hidden="true">
			<filter id="transition-grain">
				<feTurbulence
					type="fractalNoise"
					baseFrequency="0.9"
					numOctaves={2}
					seed={4}
					stitchTiles="stitch"
				/>
				<feColorMatrix type="saturate" values="0" />
			</filter>
			<rect width="100%" height="100%" filter="url(#transition-grain)" />
		</svg>
	);
}

function ArrowOverlay({
	direction,
}: {
	direction: "left" | "right" | "up" | "down" | "diag";
}) {
	const rotation = { left: 180, right: 0, up: -90, down: 90, diag: -45 }[
		direction
	];
	return (
		<svg
			viewBox="0 0 24 24"
			className="absolute inset-0 size-full p-2.5"
			style={{ transform: `rotate(${rotation}deg)` }}
			aria-hidden="true"
		>
			<path
				d="M3 12h14M11 5l7 7-7 7"
				stroke="white"
				strokeWidth={2.5}
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function ChevronsOverlay() {
	return (
		<svg
			viewBox="0 0 24 24"
			className="absolute inset-0 size-full p-2.5"
			aria-hidden="true"
		>
			<path
				d="M5 5l6 7-6 7"
				stroke="white"
				strokeWidth={2.5}
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M13 5l6 7-6 7"
				stroke="white"
				strokeWidth={2.5}
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function RingsOverlay({ count }: { count: number }) {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			{Array.from({ length: count }).map((_, i) => (
				<circle
					// biome-ignore lint/suspicious/noArrayIndexKey: static, count never changes for a given transition
					key={i}
					cx={50}
					cy={50}
					r={14 + i * 13}
					fill="none"
					stroke="white"
					strokeOpacity={0.85 - i * 0.22}
					strokeWidth={3}
				/>
			))}
		</svg>
	);
}

function BurstOverlay() {
	const lines = 8;
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			{Array.from({ length: lines }).map((_, i) => {
				const angle = (i / lines) * Math.PI * 2;
				const x1 = 50 + Math.cos(angle) * 16;
				const y1 = 50 + Math.sin(angle) * 16;
				const x2 = 50 + Math.cos(angle) * 46;
				const y2 = 50 + Math.sin(angle) * 46;
				return (
					<line
						// biome-ignore lint/suspicious/noArrayIndexKey: static geometry
						key={i}
						x1={x1}
						y1={y1}
						x2={x2}
						y2={y2}
						stroke="white"
						strokeOpacity={0.85}
						strokeWidth={3}
						strokeLinecap="round"
					/>
				);
			})}
		</svg>
	);
}

function ClockHandOverlay() {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			<line
				x1={50}
				y1={50}
				x2={50}
				y2={14}
				stroke="white"
				strokeWidth={3}
				strokeLinecap="round"
			/>
			<circle cx={50} cy={50} r={4} fill="white" />
		</svg>
	);
}

function PinwheelOverlay({
	blades,
	faded,
}: {
	blades: number;
	faded?: boolean;
}) {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			{Array.from({ length: blades }).map((_, i) => {
				const angle = (360 / blades) * i;
				return (
					<path
						// biome-ignore lint/suspicious/noArrayIndexKey: static geometry
						key={i}
						d="M50 50 L50 12 A38 38 0 0 1 76.9 23.1 Z"
						fill={i % 2 === 0 ? CLIP_A : CLIP_B}
						fillOpacity={faded ? 0.55 : 0.9}
						transform={`rotate(${angle} 50 50)`}
					/>
				);
			})}
			{faded && (
				<circle
					cx={50}
					cy={50}
					r={44}
					fill="none"
					stroke="white"
					strokeOpacity={0.3}
					strokeWidth={2}
					strokeDasharray="4 4"
				/>
			)}
		</svg>
	);
}

function SpiralOverlay() {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			<path
				d="M50 50 m0 -30 a30 30 0 1 1 -21 8.8 a19 19 0 1 1 13.8 5.7 a9 9 0 1 1 -6.5 2.6"
				fill="none"
				stroke="white"
				strokeWidth={4}
				strokeLinecap="round"
			/>
		</svg>
	);
}

function GlitchOverlay({
	axis,
	heavy,
}: {
	axis: "h" | "diag";
	heavy?: boolean;
}) {
	const skew = axis === "diag" ? "skewX(-14deg)" : undefined;
	const bars: Array<{
		left: string;
		top: string;
		width: string;
		color: string;
	}> = [
		{ left: "8%", top: "18%", width: "70%", color: "#ff003c" },
		{ left: "18%", top: "42%", width: "60%", color: "#00e5ff" },
		{ left: "4%", top: "66%", width: "80%", color: "#f8fafc" },
	];
	if (heavy)
		bars.push({ left: "28%", top: "84%", width: "45%", color: "#ff003c" });
	return (
		<>
			{bars.map((bar) => (
				<div
					key={`${bar.left}-${bar.top}`}
					className="absolute h-[12%] rounded-[1px]"
					style={{
						left: bar.left,
						top: bar.top,
						width: bar.width,
						background: bar.color,
						opacity: 0.85,
						transform: skew,
					}}
				/>
			))}
		</>
	);
}

function GridOverlay({
	variant,
}: {
	variant:
		| "checker"
		| "pixelize"
		| "mosaic"
		| "flip"
		| "random"
		| "wire"
		| "hex"
		| "hatch"
		| "dots"
		| "bars"
		| "vbars"
		| "blinds";
}) {
	switch (variant) {
		case "checker":
			return (
				<div
					className="absolute inset-0"
					style={{
						backgroundImage: `linear-gradient(45deg, ${CLIP_A} 25%, transparent 25%, transparent 75%, ${CLIP_A} 75%), linear-gradient(45deg, ${CLIP_A} 25%, transparent 25%, transparent 75%, ${CLIP_A} 75%)`,
						backgroundSize: "16px 16px",
						backgroundPosition: "0 0, 8px 8px",
						backgroundColor: CLIP_B,
					}}
				/>
			);
		case "pixelize":
			return (
				<div
					className="absolute inset-0 grid grid-cols-3 grid-rows-3"
					aria-hidden="true"
				>
					{[
						CLIP_A,
						CLIP_B,
						CLIP_A,
						CLIP_B,
						"#111319",
						CLIP_B,
						CLIP_A,
						CLIP_B,
						CLIP_A,
					].map((c, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static 3x3 pixel grid
						<div key={i} style={{ background: c }} />
					))}
				</div>
			);
		case "mosaic":
			return (
				<div className="absolute inset-0" style={{ background: CLIP_A }}>
					<div
						className="absolute left-0 top-0 h-1/2 w-1/2"
						style={{ background: CLIP_B }}
					/>
					<div
						className="absolute right-0 top-0 h-1/3 w-1/3"
						style={{ background: "#111319" }}
					/>
					<div
						className="absolute bottom-0 right-0 h-2/5 w-3/5"
						style={{ background: CLIP_B }}
					/>
				</div>
			);
		case "flip":
			return (
				<div
					className="absolute inset-0 grid grid-cols-3 grid-rows-3 gap-[2px] bg-black/40 p-[2px]"
					aria-hidden="true"
				>
					{Array.from({ length: 9 }).map((_, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: static 3x3 grid
							key={i}
							style={{ background: i === 4 ? CLIP_B : CLIP_A }}
						/>
					))}
				</div>
			);
		case "random":
			return (
				<svg
					viewBox="0 0 100 100"
					className="absolute inset-0 size-full"
					aria-hidden="true"
				>
					<rect width={100} height={100} fill="#111319" />
					{[
						[10, 15, 18],
						[45, 8, 12],
						[70, 30, 22],
						[20, 55, 14],
						[60, 65, 20],
						[85, 70, 10],
					].map(([x, y, s]) => (
						<rect
							key={`${x}-${y}`}
							x={x}
							y={y}
							width={s}
							height={s}
							fill={CLIP_A}
						/>
					))}
				</svg>
			);
		case "wire":
			return (
				<svg
					viewBox="0 0 100 100"
					className="absolute inset-0 size-full"
					aria-hidden="true"
				>
					<rect width={100} height={100} fill="#111319" />
					{[0, 1, 2].flatMap((row) =>
						[0, 1, 2].map((col) => (
							<rect
								key={`${row}-${col}`}
								x={8 + col * 30}
								y={8 + row * 30}
								width={24}
								height={24}
								fill="none"
								stroke={CLIP_A}
								strokeWidth={2.5}
							/>
						)),
					)}
				</svg>
			);
		case "hex":
			return (
				<svg
					viewBox="0 0 100 100"
					className="absolute inset-0 size-full"
					aria-hidden="true"
				>
					<rect width={100} height={100} fill="#111319" />
					{[
						[28, 30],
						[64, 30],
						[46, 58],
						[82, 58],
					].map(([cx, cy]) => (
						<polygon
							key={`${cx}-${cy}`}
							points={hexPoints(cx, cy, 16)}
							fill={CLIP_A}
							fillOpacity={0.85}
							stroke="#111319"
							strokeWidth={1.5}
						/>
					))}
				</svg>
			);
		case "hatch":
			return (
				<div
					className="absolute inset-0"
					style={{
						background: CLIP_A,
						backgroundImage:
							"repeating-linear-gradient(45deg, rgba(0,0,0,0.55) 0 2px, transparent 2px 8px), repeating-linear-gradient(-45deg, rgba(0,0,0,0.55) 0 2px, transparent 2px 8px)",
					}}
				/>
			);
		case "dots":
			return (
				<div
					className="absolute inset-0"
					style={{
						background: CLIP_A,
						backgroundImage: `radial-gradient(circle, ${CLIP_B} 30%, transparent 32%)`,
						backgroundSize: "14px 14px",
					}}
				/>
			);
		case "bars":
			return (
				<div
					className="absolute inset-0 flex flex-col gap-[3px] p-[3px]"
					aria-hidden="true"
				>
					{[0, 1, 2, 3, 4].map((i) => (
						<div
							key={i}
							className="flex-1"
							style={{
								background: i % 2 === 0 ? CLIP_A : CLIP_B,
								marginLeft: i % 2 === 0 ? "0%" : "18%",
							}}
						/>
					))}
				</div>
			);
		case "vbars":
			return (
				<div
					className="absolute inset-0"
					style={{
						background: CLIP_A,
						backgroundImage: `repeating-linear-gradient(90deg, ${CLIP_B} 0 6px, ${CLIP_A} 6px 12px)`,
					}}
				/>
			);
		case "blinds":
			return (
				<div className="absolute inset-0" style={{ background: CLIP_A }}>
					<div
						className="absolute inset-0"
						style={{
							backgroundImage: `repeating-linear-gradient(90deg, ${CLIP_B} 0 6px, transparent 6px 12px)`,
							opacity: 0.85,
						}}
					/>
				</div>
			);
		default:
			return null;
	}
}

function hexPoints(cx: number, cy: number, r: number): string {
	return Array.from({ length: 6 })
		.map((_, i) => {
			const angle = (Math.PI / 3) * i - Math.PI / 6;
			const x = cx + r * Math.cos(angle);
			const y = cy + r * Math.sin(angle);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}

function MeltOverlay() {
	const heights = [40, 65, 30, 80, 50, 70, 35, 60];
	return (
		<div
			className="absolute inset-0 flex items-end gap-[2px] px-[2px]"
			aria-hidden="true"
		>
			{heights.map((h, i) => (
				<div
					key={h}
					className="flex-1"
					style={{
						height: `${h}%`,
						background: i % 2 === 0 ? CLIP_A : CLIP_B,
					}}
				/>
			))}
		</div>
	);
}

function WaveOverlay({ smear }: { smear?: boolean }) {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			<path
				d="M0 50 Q 20 30, 40 50 T 80 50 T 120 50"
				fill="none"
				stroke="white"
				strokeOpacity={0.85}
				strokeWidth={4}
			/>
			{smear && (
				<path
					d="M0 65 Q 20 45, 40 65 T 80 65 T 120 65"
					fill="none"
					stroke="white"
					strokeOpacity={0.4}
					strokeWidth={4}
				/>
			)}
		</svg>
	);
}

function ButterflyOverlay() {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			<path
				d="M2 50 Q 26 20, 50 50 Q 26 80, 2 50 Z"
				fill="white"
				fillOpacity={0.35}
			/>
			<path
				d="M98 50 Q 74 20, 50 50 Q 74 80, 98 50 Z"
				fill="white"
				fillOpacity={0.55}
			/>
		</svg>
	);
}

function FacetOverlay() {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			{[
				[20, 22],
				[50, 20],
				[80, 24],
				[24, 55],
				[54, 58],
				[80, 60],
				[35, 85],
				[68, 84],
			].map(([cx, cy]) => (
				<polygon
					key={`${cx}-${cy}`}
					points={hexPoints(cx, cy, 12)}
					fill="none"
					stroke="white"
					strokeOpacity={0.6}
					strokeWidth={1.5}
				/>
			))}
			<circle cx={50} cy={50} r={5} fill="white" fillOpacity={0.85} />
		</svg>
	);
}

function CubeOverlay({
	variant,
}: {
	variant: "spin" | "static" | "doorway" | "swap";
}) {
	if (variant === "doorway") {
		return (
			<div className="absolute inset-0 flex" aria-hidden="true">
				<div
					className="h-full w-1/2 origin-left"
					style={{
						background: CLIP_A,
						transform: "perspective(80px) rotateY(25deg)",
					}}
				/>
				<div
					className="h-full w-1/2 origin-right"
					style={{
						background: CLIP_B,
						transform: "perspective(80px) rotateY(-25deg)",
					}}
				/>
			</div>
		);
	}
	if (variant === "swap") {
		return (
			<>
				<div
					className="absolute left-[10%] top-[18%] size-[60%] rounded-sm"
					style={{ background: CLIP_A, transform: "rotate(-8deg)" }}
				/>
				<div
					className="absolute right-[10%] bottom-[18%] size-[60%] rounded-sm shadow-md"
					style={{ background: CLIP_B, transform: "rotate(6deg)" }}
				/>
			</>
		);
	}
	// "spin" and "static" — a simple isometric cube built from three shaded
	// parallelogram faces; "spin" adds a motion-streak hint.
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			<polygon points="50,10 85,28 50,46 15,28" fill={CLIP_A} />
			<polygon points="15,28 50,46 50,90 15,72" fill="#3a3a3a" />
			<polygon points="85,28 50,46 50,90 85,72" fill={CLIP_B} />
			{variant === "spin" && (
				<path
					d="M8 50 h10 M8 60 h6"
					stroke="white"
					strokeOpacity={0.5}
					strokeWidth={2.5}
					strokeLinecap="round"
				/>
			)}
		</svg>
	);
}

function BounceOverlay() {
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			<path
				d="M10 30 Q 30 90, 50 30 T 90 30"
				fill="none"
				stroke="white"
				strokeOpacity={0.6}
				strokeWidth={3}
				strokeDasharray="1 8"
				strokeLinecap="round"
			/>
			<circle cx={90} cy={30} r={9} fill={CLIP_B} />
		</svg>
	);
}

function WindOverlay() {
	const rows = [22, 40, 58, 76];
	return (
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full"
			aria-hidden="true"
		>
			{rows.map((y, i) => (
				<path
					key={y}
					d={`M${8 + i * 4} ${y} h${60 - i * 10}`}
					stroke="white"
					strokeOpacity={0.75 - i * 0.12}
					strokeWidth={3}
					strokeLinecap="round"
				/>
			))}
		</svg>
	);
}
