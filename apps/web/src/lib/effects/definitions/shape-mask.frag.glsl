// Adapted from OpenCut-app/opencut-classic (MIT). See THIRD_PARTY_NOTICES.
// Shape geometry ported from its Canvas2D mask renderer; feathering
// re-implemented as a smoothstep falloff on the shape's signed distance.
precision mediump float;

varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform vec2 u_resolution;

uniform float u_shape;    // 0 rectangle, 1 ellipse, 2 star, 3 cinematic bars
uniform vec2 u_center;    // center offset from element center, fraction of element size
uniform vec2 u_size;      // mask size, fraction of element size
uniform float u_rotation; // radians
uniform float u_feather;  // fraction of the element's short side
uniform float u_inverted; // 0 or 1

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdEllipse(vec2 p, vec2 r) {
  // Scaled-distance approximation: exact on the axes, close elsewhere.
  float k = length(p / r);
  return (k - 1.0) * min(r.x, r.y);
}

float sdStar5(vec2 p, float r, float rf) {
  // 5-point star SDF (Inigo Quilez, MIT), rf = inner radius ratio.
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);

  // Pixel-space position relative to the mask center, y down (image space).
  vec2 p = (vec2(v_texCoord.x, 1.0 - v_texCoord.y) - 0.5 - u_center) * u_resolution;
  float c = cos(u_rotation);
  float s = sin(u_rotation);
  p = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);

  vec2 halfSize = max(u_size * u_resolution * 0.5, vec2(1.0));
  float shortSide = min(u_resolution.x, u_resolution.y);

  float dist;
  if (u_shape < 0.5) {
    dist = sdBox(p, halfSize);
  } else if (u_shape < 1.5) {
    dist = sdEllipse(p, halfSize);
  } else if (u_shape < 2.5) {
    // Map the elliptical bounding box to a circle, point the star up (y down space).
    float radius = min(halfSize.x, halfSize.y);
    vec2 star = p / halfSize * radius;
    dist = sdStar5(vec2(star.x, -star.y), radius, 0.45);
  } else {
    dist = abs(p.y) - halfSize.y;
  }

  float featherPx = max(u_feather * shortSide * 0.5, 1.0);
  float alpha = 1.0 - smoothstep(-featherPx * 0.5, featherPx * 0.5, dist);
  alpha = mix(alpha, 1.0 - alpha, u_inverted);

  gl_FragColor = vec4(color.rgb, color.a * alpha);
}
