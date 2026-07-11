// Separable Gaussian blur of a mask's coverage (alpha) channel — one axis per
// pass. Replaces pre-rewrite's Rust/WASM jump-flood feather with a portable
// GLSL blur sized by the feather param. Tap spacing scales with the feather
// radius so a fixed tap budget covers any feather width; step-scaling ghosting
// is imperceptible on a smooth 0..1 coverage field.
precision mediump float;

varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform vec2 u_direction; // (1,0) horizontal or (0,1) vertical
uniform float u_featherPx; // feather radius in pixels along the blur axis

const int TAPS = 8; // samples per side

void main() {
  float radius = max(u_featherPx, 0.75);
  float sigma = radius * 0.5;
  // Span roughly +/-3 sigma with the fixed tap budget.
  float step = max(1.0, (3.0 * sigma) / float(TAPS));
  vec2 texel = (u_direction * step) / u_resolution;

  float total = 0.0;
  float weightSum = 0.0;
  for (int i = -TAPS; i <= TAPS; i++) {
    float d = float(i) * step; // distance in pixels
    float weight = exp(-(d * d) / (2.0 * sigma * sigma));
    total += texture2D(u_texture, v_texCoord + texel * float(i)).a * weight;
    weightSum += weight;
  }

  float coverage = total / weightSum;
  gl_FragColor = vec4(coverage, coverage, coverage, coverage);
}
