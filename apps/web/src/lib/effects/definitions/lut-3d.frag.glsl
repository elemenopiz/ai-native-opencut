precision mediump float;

varying vec2 v_texCoord;
uniform sampler2D u_texture;
// 3D LUT baked into a 2D texture: `u_lutSize` slices of u_lutSize x u_lutSize
// (red x green) tiled horizontally — see lib/effects/lut-texture.ts.
uniform sampler2D u_lut;
uniform float u_lutSize;
uniform float u_intensity;

void main() {
    vec4 original = texture2D(u_texture, v_texCoord);
    vec3 rgb = clamp(original.rgb, 0.0, 1.0);

    float size = max(u_lutSize, 2.0);
    float sliceSize = 1.0 / size;                    // width of one blue-axis tile, in UV space
    float slicePixelSize = sliceSize / size;          // width of one texel within a tile
    float sliceInnerSize = slicePixelSize * (size - 1.0);

    float zSlice0 = min(floor(rgb.b * size), size - 1.0);
    float zSlice1 = min(zSlice0 + 1.0, size - 1.0);

    // Inset the sample by half a texel on each side of the tile so hardware
    // bilinear filtering can't bleed into the neighboring blue-axis tile.
    float xOffset = slicePixelSize * 0.5 + rgb.r * sliceInnerSize;
    float yOffset = (rgb.g * (size - 1.0) + 0.5) / size;

    vec2 uv0 = vec2(zSlice0 * sliceSize + xOffset, yOffset);
    vec2 uv1 = vec2(zSlice1 * sliceSize + xOffset, yOffset);

    vec3 lutColor0 = texture2D(u_lut, uv0).rgb;
    vec3 lutColor1 = texture2D(u_lut, uv1).rgb;
    vec3 lutColor = mix(lutColor0, lutColor1, fract(rgb.b * size));

    vec3 result = mix(rgb, lutColor, clamp(u_intensity, 0.0, 1.0));
    gl_FragColor = vec4(result, original.a);
}
