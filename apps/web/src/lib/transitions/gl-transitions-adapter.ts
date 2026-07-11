/**
 * Adapter for shaders vendored from gl-transitions
 * (https://github.com/gl-transitions/gl-transitions, MIT).
 *
 * gl-transitions shaders implement `vec4 transition(vec2 uv)` and rely on a
 * host-provided prelude: `getFromColor(uv)` / `getToColor(uv)` sampling
 * helpers plus `progress` and `ratio` values. Our renderer
 * (services/renderer/transition-renderer.ts) instead provides the uniforms
 * `u_textureA`, `u_textureB`, `u_progress`, and `u_resolution`, with UVs in
 * `v_texCoord` (bottom-left origin — textures are uploaded with
 * UNPACK_FLIP_Y_WEBGL, matching the gl-transitions convention).
 *
 * This module maps their contract onto ours with one shared GLSL prelude and
 * footer:
 * - `progress` / `ratio` are declared as plain globals and assigned from our
 *   uniforms at the top of `main()`. Globals (rather than `#define`) are used
 *   so shaders that declare local variables or function parameters named
 *   `progress`/`ratio` (e.g. Dreamy, undulatingBurnOut) legally shadow them
 *   instead of breaking under macro expansion.
 * - Tunable parameter uniforms (`uniform float strength; // = 0.4`) are baked
 *   to `const` declarations using the default value each shader documents in
 *   its `// = value` annotation (a block-comment variant also exists), since
 *   our renderer only sets the core uniforms.
 */

const PRELUDE = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D u_textureA;
uniform sampler2D u_textureB;
uniform float u_progress;
uniform vec2 u_resolution;

varying vec2 v_texCoord;

float progress;
float ratio;

vec4 getFromColor(vec2 uv) {
  return texture2D(u_textureA, uv);
}

vec4 getToColor(vec2 uv) {
  return texture2D(u_textureB, uv);
}

// ---- vendored gl-transitions shader body follows ----
`;

const FOOTER = `
// ---- end vendored shader body ----

void main() {
  progress = u_progress;
  ratio = u_resolution.x / u_resolution.y;
  gl_FragColor = transition(v_texCoord);
}
`;

/**
 * `uniform <type> <name>; // = <default>` — the annotation format the
 * gl-transitions repo enforces for tunable parameters.
 */
const LINE_COMMENT_DEFAULT_RE =
	/^[ \t]*uniform[ \t]+(\w+)[ \t]+(\w+)[ \t]*;[^\n]*?\/\/[ \t]*=[ \t]*([^\n]*)$/gm;

// Block-comment default variant used by a few shaders (e.g. burn):
// uniform <type> <name> /* = <default> */;
const BLOCK_COMMENT_DEFAULT_RE =
	/^[ \t]*uniform[ \t]+(\w+)[ \t]+(\w+)[ \t]*\/\*[ \t]*=[ \t]*([^*]*?)[ \t]*\*\/[ \t]*;/gm;

function normalizeDefaultValue({
	glslType,
	rawValue,
}: {
	glslType: string;
	rawValue: string;
}): string {
	// Cut prose that trails the value (e.g. "0.4 ; // if 0.0, ...").
	let value = rawValue.split("//")[0].split(";")[0].trim();

	if (glslType === "bool") {
		if (value === "1") value = "true";
		if (value === "0") value = "false";
	} else if (glslType === "float" && /^-?\d+$/.test(value)) {
		// GLSL ES 1.00 has no implicit int→float conversion.
		value = `${value}.0`;
	}
	return value;
}

function bakeUniformDefaults({ source }: { source: string }): string {
	const replaceWithConst = (
		_match: string,
		glslType: string,
		name: string,
		rawValue: string,
	): string =>
		`const ${glslType} ${name} = ${normalizeDefaultValue({ glslType, rawValue })};`;

	return source
		.replace(LINE_COMMENT_DEFAULT_RE, replaceWithConst)
		.replace(BLOCK_COMMENT_DEFAULT_RE, replaceWithConst);
}

/**
 * Wrap a raw gl-transitions shader source into a fragment shader that
 * satisfies our transition renderer's contract.
 */
export function adaptGlTransition({ source }: { source: string }): string {
	return PRELUDE + bakeUniformDefaults({ source }) + FOOTER;
}
