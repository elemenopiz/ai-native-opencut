precision highp float;

varying vec2 v_texCoord;
uniform sampler2D u_texture;

// Tiled 3D-LUT atlas: a horizontal strip of u_lutSize blue-slices, each
// u_lutSize x u_lutSize (red across, green down). Atlas is u_lutSize^2 wide.
uniform sampler2D u_lut;
uniform float u_lutSize;   // N; 0 = no LUT loaded (pass through)
uniform float u_intensity; // 0..1 blend between original and graded
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;

// Look up a color in the tiled 2D LUT atlas with manual blue-slice blending.
vec3 sampleLut(vec3 rgb, float size) {
    // Normalize the incoming color into the LUT input domain.
    vec3 domain = max(u_domainMax - u_domainMin, vec3(1e-5));
    vec3 c = clamp((rgb - u_domainMin) / domain, 0.0, 1.0);

    float sliceCount = size;                 // number of blue slices
    float blue = c.b * (sliceCount - 1.0);   // 0 .. N-1
    float sliceLow = floor(blue);
    float sliceHigh = min(sliceLow + 1.0, sliceCount - 1.0);
    float frac = blue - sliceLow;

    // Within a slice, offset to texel centers so red never bleeds into the
    // neighbouring slice under hardware LINEAR filtering.
    float u = (c.r * (size - 1.0) + 0.5) / size; // 0..1 within one slice
    float v = (c.g * (size - 1.0) + 0.5) / size; // 0..1 down the atlas

    // Each slice spans 1/N of the atlas width.
    vec2 uvLow = vec2((sliceLow + u) / sliceCount, v);
    vec2 uvHigh = vec2((sliceHigh + u) / sliceCount, v);

    vec3 lo = texture2D(u_lut, uvLow).rgb;
    vec3 hi = texture2D(u_lut, uvHigh).rgb;
    return mix(lo, hi, frac);
}

void main() {
    vec4 color = texture2D(u_texture, v_texCoord);

    if (u_lutSize < 1.5) {
        // No LUT loaded — pass the frame through unchanged.
        gl_FragColor = color;
        return;
    }

    vec3 graded = sampleLut(color.rgb, u_lutSize);
    vec3 outRgb = mix(color.rgb, graded, clamp(u_intensity, 0.0, 1.0));
    gl_FragColor = vec4(outRgb, color.a);
}
