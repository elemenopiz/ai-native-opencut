/**
 * Transitions vendored from gl-transitions
 * (https://github.com/gl-transitions/gl-transitions, MIT license).
 *
 * Each shader in ./shaders/gl/ is a verbatim copy (author/license header
 * preserved) adapted onto our renderer contract at registration time by
 * {@link adaptGlTransition}. See THIRD_PARTY_NOTICES.md at the repo root for
 * attribution.
 */
import type { TransitionDefinition } from "./registry";
import { adaptGlTransition } from "./gl-transitions-adapter";

import angularShader from "./shaders/gl/angular.frag.glsl";
import bounceShader from "./shaders/gl/bounce.frag.glsl";
import burnShader from "./shaders/gl/burn.frag.glsl";
import butterflyWaveShader from "./shaders/gl/butterfly-wave.frag.glsl";
import circleCropShader from "./shaders/gl/circle-crop.frag.glsl";
import circleOpenShader from "./shaders/gl/circle-open.frag.glsl";
import circleShader from "./shaders/gl/circle.frag.glsl";
import colorPhaseShader from "./shaders/gl/color-phase.frag.glsl";
import crossWarpShader from "./shaders/gl/cross-warp.frag.glsl";
import crossZoomShader from "./shaders/gl/cross-zoom.frag.glsl";
import crosshatchShader from "./shaders/gl/crosshatch.frag.glsl";
import cubeShader from "./shaders/gl/cube.frag.glsl";
import directionalWarpShader from "./shaders/gl/directional-warp.frag.glsl";
import directionalWipeShader from "./shaders/gl/directional-wipe.frag.glsl";
import doomScreenShader from "./shaders/gl/doom-screen.frag.glsl";
import doorwayShader from "./shaders/gl/doorway.frag.glsl";
import dreamyShader from "./shaders/gl/dreamy.frag.glsl";
import dreamyZoomShader from "./shaders/gl/dreamy-zoom.frag.glsl";
import fadeColorShader from "./shaders/gl/fade-color.frag.glsl";
import fadeGrayscaleShader from "./shaders/gl/fade-grayscale.frag.glsl";
import flyEyeShader from "./shaders/gl/fly-eye.frag.glsl";
import glitchDisplaceShader from "./shaders/gl/glitch-displace.frag.glsl";
import glitchMemoriesShader from "./shaders/gl/glitch-memories.frag.glsl";
import gridFlipShader from "./shaders/gl/grid-flip.frag.glsl";
import heartShader from "./shaders/gl/heart.frag.glsl";
import hexagonalizeShader from "./shaders/gl/hexagonalize.frag.glsl";
import kaleidoscopeShader from "./shaders/gl/kaleidoscope.frag.glsl";
import linearBlurShader from "./shaders/gl/linear-blur.frag.glsl";
import mosaicShader from "./shaders/gl/mosaic.frag.glsl";
import perlinShader from "./shaders/gl/perlin.frag.glsl";
import pinwheelShader from "./shaders/gl/pinwheel.frag.glsl";
import pixelizeShader from "./shaders/gl/pixelize.frag.glsl";
import polkaDotsCurtainShader from "./shaders/gl/polka-dots-curtain.frag.glsl";
import radialShader from "./shaders/gl/radial.frag.glsl";
import randomSquaresShader from "./shaders/gl/random-squares.frag.glsl";
import rippleShader from "./shaders/gl/ripple.frag.glsl";
import rotateScaleVanishShader from "./shaders/gl/rotate-scale-vanish.frag.glsl";
import simpleZoomShader from "./shaders/gl/simple-zoom.frag.glsl";
import squaresWireShader from "./shaders/gl/squares-wire.frag.glsl";
import swapShader from "./shaders/gl/swap.frag.glsl";
import swirlShader from "./shaders/gl/swirl.frag.glsl";
import undulatingBurnOutShader from "./shaders/gl/undulating-burn-out.frag.glsl";
import waterDropShader from "./shaders/gl/water-drop.frag.glsl";
import windShader from "./shaders/gl/wind.frag.glsl";
import windowBlindsShader from "./shaders/gl/window-blinds.frag.glsl";
import windowSliceShader from "./shaders/gl/window-slice.frag.glsl";
import wipeDownShader from "./shaders/gl/wipe-down.frag.glsl";
import wipeUpShader from "./shaders/gl/wipe-up.frag.glsl";

interface GlTransitionEntry {
	type: string;
	name: string;
	category: TransitionDefinition["category"];
	keywords: string[];
	defaultDuration: number;
	source: string;
}

const GL_TRANSITION_ENTRIES: GlTransitionEntry[] = [
	// ── dissolve ───────────────────────────────────────────────────────────
	{
		type: "fade-grayscale",
		name: "Fade Grayscale",
		category: "dissolve",
		keywords: ["fade", "grayscale", "desaturate", "black and white"],
		defaultDuration: 0.6,
		source: fadeGrayscaleShader,
	},
	{
		type: "color-phase",
		name: "Color Phase",
		category: "dissolve",
		keywords: ["color", "phase", "channel", "fade"],
		defaultDuration: 0.6,
		source: colorPhaseShader,
	},
	{
		type: "perlin",
		name: "Perlin Dissolve",
		category: "dissolve",
		keywords: ["perlin", "noise", "dissolve", "organic"],
		defaultDuration: 0.6,
		source: perlinShader,
	},
	{
		type: "linear-blur",
		name: "Linear Blur",
		category: "dissolve",
		keywords: ["blur", "soft", "smooth", "defocus"],
		defaultDuration: 0.5,
		source: linearBlurShader,
	},
	// ── dip ────────────────────────────────────────────────────────────────
	{
		type: "fade-color",
		name: "Fade Through Color",
		category: "dip",
		keywords: ["fade", "color", "dip", "flash"],
		defaultDuration: 0.75,
		source: fadeColorShader,
	},
	// ── slide ──────────────────────────────────────────────────────────────
	{
		type: "bounce",
		name: "Bounce",
		category: "slide",
		keywords: ["bounce", "drop", "spring", "fall"],
		defaultDuration: 0.75,
		source: bounceShader,
	},
	// ── wipe ───────────────────────────────────────────────────────────────
	{
		type: "wipe-up",
		name: "Wipe Up",
		category: "wipe",
		keywords: ["wipe", "reveal", "up", "vertical"],
		defaultDuration: 0.5,
		source: wipeUpShader,
	},
	{
		type: "wipe-down",
		name: "Wipe Down",
		category: "wipe",
		keywords: ["wipe", "reveal", "down", "vertical"],
		defaultDuration: 0.5,
		source: wipeDownShader,
	},
	{
		type: "directional-wipe",
		name: "Directional Wipe",
		category: "wipe",
		keywords: ["wipe", "diagonal", "direction", "soft edge"],
		defaultDuration: 0.5,
		source: directionalWipeShader,
	},
	{
		type: "angular",
		name: "Angular Sweep",
		category: "wipe",
		keywords: ["angular", "sweep", "radial", "clock"],
		defaultDuration: 0.6,
		source: angularShader,
	},
	{
		type: "radial",
		name: "Radial Sweep",
		category: "wipe",
		keywords: ["radial", "sweep", "clock", "smooth"],
		defaultDuration: 0.6,
		source: radialShader,
	},
	{
		type: "wind",
		name: "Wind",
		category: "wipe",
		keywords: ["wind", "streak", "blow", "ragged"],
		defaultDuration: 0.6,
		source: windShader,
	},
	{
		type: "window-slice",
		name: "Window Slice",
		category: "wipe",
		keywords: ["slice", "bars", "stripes", "blinds"],
		defaultDuration: 0.5,
		source: windowSliceShader,
	},
	{
		type: "window-blinds",
		name: "Window Blinds",
		category: "wipe",
		keywords: ["blinds", "shutter", "stripes", "venetian"],
		defaultDuration: 0.5,
		source: windowBlindsShader,
	},
	{
		type: "doom-screen",
		name: "Screen Melt",
		category: "wipe",
		keywords: ["melt", "doom", "drip", "columns", "retro"],
		defaultDuration: 0.8,
		source: doomScreenShader,
	},
	// ── zoom ───────────────────────────────────────────────────────────────
	{
		type: "cross-zoom",
		name: "Cross Zoom",
		category: "zoom",
		keywords: ["zoom", "cross", "blur", "punch", "whip"],
		defaultDuration: 0.75,
		source: crossZoomShader,
	},
	{
		type: "simple-zoom",
		name: "Simple Zoom",
		category: "zoom",
		keywords: ["zoom", "scale", "grow", "in"],
		defaultDuration: 0.6,
		source: simpleZoomShader,
	},
	{
		type: "dreamy-zoom",
		name: "Dreamy Zoom",
		category: "zoom",
		keywords: ["dreamy", "zoom", "rotate", "cinematic"],
		defaultDuration: 0.75,
		source: dreamyZoomShader,
	},
	// ── iris ───────────────────────────────────────────────────────────────
	{
		type: "circle",
		name: "Circle Reveal",
		category: "iris",
		keywords: ["circle", "iris", "reveal", "round"],
		defaultDuration: 0.6,
		source: circleShader,
	},
	{
		type: "circle-open",
		name: "Circle Open",
		category: "iris",
		keywords: ["circle", "open", "iris", "aperture"],
		defaultDuration: 0.6,
		source: circleOpenShader,
	},
	{
		type: "circle-crop",
		name: "Circle Crop",
		category: "iris",
		keywords: ["circle", "crop", "close", "open", "black"],
		defaultDuration: 0.75,
		source: circleCropShader,
	},
	{
		type: "heart",
		name: "Heart",
		category: "iris",
		keywords: ["heart", "love", "shape", "reveal"],
		defaultDuration: 0.6,
		source: heartShader,
	},
	{
		type: "polka-dots-curtain",
		name: "Polka Dots",
		category: "iris",
		keywords: ["polka", "dots", "circles", "curtain"],
		defaultDuration: 0.6,
		source: polkaDotsCurtainShader,
	},
	// ── morph ──────────────────────────────────────────────────────────────
	{
		type: "cross-warp",
		name: "Cross Warp",
		category: "morph",
		keywords: ["warp", "cross", "stretch", "morph"],
		defaultDuration: 0.6,
		source: crossWarpShader,
	},
	{
		type: "directional-warp",
		name: "Directional Warp",
		category: "morph",
		keywords: ["warp", "direction", "smear", "morph"],
		defaultDuration: 0.6,
		source: directionalWarpShader,
	},
	// ── distortion ─────────────────────────────────────────────────────────
	{
		type: "ripple",
		name: "Ripple",
		category: "distortion",
		keywords: ["ripple", "wave", "water", "rings"],
		defaultDuration: 0.75,
		source: rippleShader,
	},
	{
		type: "water-drop",
		name: "Water Drop",
		category: "distortion",
		keywords: ["water", "drop", "ripple", "splash"],
		defaultDuration: 0.75,
		source: waterDropShader,
	},
	{
		type: "swirl",
		name: "Swirl",
		category: "distortion",
		keywords: ["swirl", "twist", "vortex", "spiral"],
		defaultDuration: 0.75,
		source: swirlShader,
	},
	{
		type: "dreamy",
		name: "Dreamy",
		category: "distortion",
		keywords: ["dreamy", "wave", "soft", "float"],
		defaultDuration: 0.75,
		source: dreamyShader,
	},
	{
		type: "glitch-memories",
		name: "Glitch Memories",
		category: "distortion",
		keywords: ["glitch", "memories", "jitter", "digital"],
		defaultDuration: 0.5,
		source: glitchMemoriesShader,
	},
	{
		type: "glitch-displace",
		name: "Glitch Displace",
		category: "distortion",
		keywords: ["glitch", "displace", "corrupt", "digital"],
		defaultDuration: 0.5,
		source: glitchDisplaceShader,
	},
	{
		type: "fly-eye",
		name: "Fly Eye",
		category: "distortion",
		keywords: ["fly", "eye", "lens", "facet", "insect"],
		defaultDuration: 0.6,
		source: flyEyeShader,
	},
	{
		type: "butterfly-wave",
		name: "Butterfly Wave",
		category: "distortion",
		keywords: ["butterfly", "wave", "scrawl", "flutter"],
		defaultDuration: 0.75,
		source: butterflyWaveShader,
	},
	{
		type: "kaleidoscope",
		name: "Kaleidoscope",
		category: "distortion",
		keywords: ["kaleidoscope", "mirror", "fractal", "psychedelic"],
		defaultDuration: 0.75,
		source: kaleidoscopeShader,
	},
	// ── burn ───────────────────────────────────────────────────────────────
	{
		type: "burn",
		name: "Color Burn",
		category: "burn",
		keywords: ["burn", "warm", "orange", "glow"],
		defaultDuration: 0.6,
		source: burnShader,
	},
	{
		type: "undulating-burn-out",
		name: "Undulating Burn",
		category: "burn",
		keywords: ["burn", "undulate", "edge", "smolder"],
		defaultDuration: 0.75,
		source: undulatingBurnOutShader,
	},
	// ── spin ───────────────────────────────────────────────────────────────
	{
		type: "pinwheel",
		name: "Pinwheel",
		category: "spin",
		keywords: ["pinwheel", "spin", "blades", "radial"],
		defaultDuration: 0.6,
		source: pinwheelShader,
	},
	{
		type: "rotate-scale-vanish",
		name: "Rotate Scale Vanish",
		category: "spin",
		keywords: ["rotate", "scale", "vanish", "spiral"],
		defaultDuration: 0.75,
		source: rotateScaleVanishShader,
	},
	// ── cube (3D) ──────────────────────────────────────────────────────────
	{
		type: "cube",
		name: "Cube",
		category: "cube",
		keywords: ["cube", "3d", "rotate", "perspective", "box"],
		defaultDuration: 0.75,
		source: cubeShader,
	},
	{
		type: "doorway",
		name: "Doorway",
		category: "cube",
		keywords: ["doorway", "door", "open", "3d", "perspective"],
		defaultDuration: 0.75,
		source: doorwayShader,
	},
	{
		type: "swap",
		name: "Swap",
		category: "cube",
		keywords: ["swap", "3d", "depth", "cards", "exchange"],
		defaultDuration: 0.75,
		source: swapShader,
	},
	// ── pattern ────────────────────────────────────────────────────────────
	{
		type: "pixelize",
		name: "Pixelize",
		category: "pattern",
		keywords: ["pixel", "pixelate", "mosaic", "8bit", "retro"],
		defaultDuration: 0.6,
		source: pixelizeShader,
	},
	{
		type: "mosaic",
		name: "Mosaic Grid",
		category: "pattern",
		keywords: ["mosaic", "grid", "tiles", "zoom out"],
		defaultDuration: 0.75,
		source: mosaicShader,
	},
	{
		type: "grid-flip",
		name: "Grid Flip",
		category: "pattern",
		keywords: ["grid", "flip", "tiles", "board"],
		defaultDuration: 0.75,
		source: gridFlipShader,
	},
	{
		type: "random-squares",
		name: "Random Squares",
		category: "pattern",
		keywords: ["random", "squares", "blocks", "grid"],
		defaultDuration: 0.5,
		source: randomSquaresShader,
	},
	{
		type: "squares-wire",
		name: "Squares Wire",
		category: "pattern",
		keywords: ["squares", "wire", "grid", "diagonal"],
		defaultDuration: 0.6,
		source: squaresWireShader,
	},
	{
		type: "hexagonalize",
		name: "Hexagonalize",
		category: "pattern",
		keywords: ["hexagon", "honeycomb", "tiles", "geometric"],
		defaultDuration: 0.6,
		source: hexagonalizeShader,
	},
	{
		type: "crosshatch",
		name: "Crosshatch",
		category: "pattern",
		keywords: ["crosshatch", "sketch", "noise", "hatch"],
		defaultDuration: 0.6,
		source: crosshatchShader,
	},
];

export const GL_TRANSITIONS: TransitionDefinition[] = GL_TRANSITION_ENTRIES.map(
	({ type, name, category, keywords, defaultDuration, source }) => ({
		type,
		name,
		category,
		keywords,
		defaultDuration,
		fragmentShader: adaptGlTransition({ source }),
	}),
);
