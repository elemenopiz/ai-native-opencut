// Final custom-mask pass: multiply the (blurred) rasterized path coverage into
// the element's own frame, with invert support. The blurred coverage arrives as
// the chained pass input (u_texture, GL-space); the element frame is bound as an
// auxiliary texture uploaded WITHOUT a Y-flip, so it is sampled at (x, 1 - y) to
// line up with the coverage — mirroring how the analytic shape-mask reads its
// input at a Y-flipped upload.
precision mediump float;

varying vec2 v_texCoord;
uniform sampler2D u_texture; // blurred coverage in .a
uniform sampler2D u_sourceTexture; // element frame (no Y-flip)
uniform float u_inverted; // 0 or 1

void main() {
  float coverage = texture2D(u_texture, v_texCoord).a;
  vec4 color = texture2D(u_sourceTexture, vec2(v_texCoord.x, 1.0 - v_texCoord.y));
  float alpha = mix(coverage, 1.0 - coverage, u_inverted);
  gl_FragColor = vec4(color.rgb, color.a * alpha);
}
