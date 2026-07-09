precision mediump float;

varying vec2 v_texCoord;
uniform sampler2D u_texture;

// Tone controls
uniform float u_exposure;    // stops, -2..2
uniform float u_brightness;  // -0.5..0.5
uniform float u_contrast;    // 0.2..3, 1 = neutral
uniform float u_saturation;  // 0..3, 1 = neutral
uniform float u_temperature; // -1 cool .. 1 warm
uniform float u_tint;        // -1 green .. 1 magenta
uniform float u_highlights;  // -1..1
uniform float u_shadows;     // -1..1
uniform float u_whites;      // -1..1
uniform float u_blacks;      // -1..1
uniform float u_vignette;    // 0..1

// Lift / Gamma / Gain color wheels (RGB, neutral = lift 0, gamma 1, gain 1)
uniform vec3 u_lift;
uniform vec3 u_gamma;
uniform vec3 u_gain;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
    vec4 color = texture2D(u_texture, v_texCoord);
    vec3 rgb = color.rgb;

    // 1. Exposure (in stops)
    rgb *= pow(2.0, u_exposure);

    // 2. White balance
    rgb.r += u_temperature * 0.1;
    rgb.b -= u_temperature * 0.1;
    rgb.g += u_tint * 0.1;

    // 3. Lift / Gamma / Gain (ASC CDL style)
    //    out = (in * gain + lift) ^ (1 / gamma)
    rgb = clamp(rgb * u_gain + u_lift, 0.0, 1.0);
    vec3 safeGamma = max(u_gamma, vec3(0.01));
    rgb = pow(rgb, 1.0 / safeGamma);

    // 4. Tonal zones (shadows / highlights / blacks / whites)
    float luma = dot(rgb, LUMA);
    float shadowW = 1.0 - smoothstep(0.0, 0.5, luma);
    float highlightW = smoothstep(0.5, 1.0, luma);
    float blackW = 1.0 - smoothstep(0.0, 0.25, luma);
    float whiteW = smoothstep(0.75, 1.0, luma);
    rgb += u_shadows * shadowW * 0.5;
    rgb += u_highlights * highlightW * 0.5;
    rgb += u_blacks * blackW * 0.5;
    rgb += u_whites * whiteW * 0.5;

    // 5. Contrast (pivot at mid-gray)
    rgb = (rgb - 0.5) * u_contrast + 0.5;

    // 6. Brightness
    rgb += u_brightness;

    // 7. Saturation
    float gray = dot(rgb, LUMA);
    rgb = mix(vec3(gray), rgb, u_saturation);

    // 8. Vignette
    if (u_vignette > 0.0) {
        vec2 uv = v_texCoord * 2.0 - 1.0;
        float dist = length(uv) * 0.707;
        float vig = 1.0 - smoothstep(1.0 - u_vignette * 0.8, 1.0, dist);
        rgb *= vig;
    }

    rgb = clamp(rgb, 0.0, 1.0);
    gl_FragColor = vec4(rgb, color.a);
}
