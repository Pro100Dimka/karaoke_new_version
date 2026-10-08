/** GLSL for the stage light: everything is drawn additively into an HDR buffer, bloomed, then tone-mapped. */

const header = "#version 300 es\nprecision highp float;\n";

/** CSS pixels to clip space, y down like the page. */
const toClip = `
uniform vec2 u_view;
vec4 clipOf(vec2 pos) {
  vec2 c = pos / u_view * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}
`;

export const spriteVertex = `${header}${toClip}
in vec2 a_corner;
in vec4 a_shape;   // x, y, radius, kind
in vec4 a_light;   // r, g, b, intensity
in vec2 a_param;
out vec2 v_p;
out vec3 v_color;
flat out float v_kind;
out vec2 v_param;
void main() {
  v_p = a_corner;
  v_color = a_light.rgb * a_light.a;
  v_kind = a_shape.w;
  v_param = a_param;
  gl_Position = clipOf(a_shape.xy + a_corner * a_shape.z);
}
`;

export const spriteFragment = `${header}
in vec2 v_p;
in vec3 v_color;
flat in float v_kind;
in vec2 v_param;
out vec4 outColor;
void main() {
  float d = length(v_p);
  float a;
  if (v_kind < 0.5) {
    // A glow: a hot narrow core inside a wide soft halo, the shape the eye reads as a real light.
    a = exp(-d * d * 28.0) * 1.6 + exp(-d * d * 5.0) * 0.45;
  } else if (v_kind < 1.5) {
    float w = max(v_param.y, 0.004);
    float r = (d - v_param.x) / w;
    a = exp(-r * r) + exp(-r * r * 0.12) * 0.18;
  } else if (v_kind < 2.5) {
    // A star flare: core plus thin horizontal and vertical streaks (the eye's own glare).
    vec2 q = abs(v_p);
    float core = exp(-d * d * 60.0) * 2.4 + exp(-d * d * 9.0) * 0.4;
    float h = exp(-q.y * q.y * 2600.0) * exp(-q.x * 2.8);
    float v = exp(-q.x * q.x * 2600.0) * exp(-q.y * 4.5);
    a = core + (h + v * 0.55) * v_param.x;
  } else {
    // Bokeh: an out-of-focus disc with a slightly brighter rim.
    a = smoothstep(1.0, 0.82, d) * (0.55 + 0.45 * smoothstep(0.55, 0.95, d));
  }
  a *= smoothstep(1.0, 0.9, d);
  outColor = vec4(v_color * a, 1.0);
}
`;

export const beamVertex = `${header}${toClip}
in vec2 a_pos;
in vec2 a_cone;    // along 0..1, across -1..1 (times along)
in vec4 a_light;
out vec2 v_cone;
out vec2 v_world;
out vec4 v_light;
void main() {
  v_cone = a_cone;
  v_world = a_pos;
  v_light = a_light;
  gl_Position = clipOf(a_pos);
}
`;

export const beamFragment = `${header}
uniform float u_time;
in vec2 v_cone;
in vec2 v_world;
in vec4 v_light;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  float along = max(v_cone.x, 0.0005);
  float across = v_cone.y / along;
  // Soft edges and a brighter axis: a beam through haze, not a flat triangle.
  float edge = 1.0 - smoothstep(0.0, 1.0, abs(across));
  float body = edge * edge;
  float axis = exp(-across * across * 22.0);
  float falloff = exp(-along * 2.4) * smoothstep(0.0, 0.035, along);
  // Haze drifting through the light, and the odd mote catching it.
  float haze = fbm(v_world * 0.0045 + vec2(u_time * 0.018, -u_time * 0.035));
  haze = 0.35 + 1.25 * haze * haze;
  float mote = pow(noise(v_world * 0.11 + vec2(u_time * 0.4, -u_time * 0.9)), 22.0) * 5.0;
  float light = (body * 0.95 + axis * 0.32) * falloff * haze + mote * body * falloff;
  outColor = vec4(v_light.rgb * v_light.a * light, 1.0);
}
`;

export const fullscreenVertex = `${header}
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Dual-filter (Kawase) downsample; the first pass keeps only light above the threshold. */
export const downFragment = `${header}
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_threshold;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec3 c = texture(u_source, v_uv).rgb * 4.0;
  c += texture(u_source, v_uv + vec2(-1.0, -1.0) * u_texel).rgb;
  c += texture(u_source, v_uv + vec2(1.0, -1.0) * u_texel).rgb;
  c += texture(u_source, v_uv + vec2(-1.0, 1.0) * u_texel).rgb;
  c += texture(u_source, v_uv + vec2(1.0, 1.0) * u_texel).rgb;
  c /= 8.0;
  outColor = vec4(max(c - u_threshold, 0.0), 1.0);
}
`;

export const upFragment = `${header}
uniform sampler2D u_source;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec3 c = vec3(0.0);
  c += texture(u_source, v_uv + vec2(-2.0, 0.0) * u_texel).rgb;
  c += texture(u_source, v_uv + vec2(2.0, 0.0) * u_texel).rgb;
  c += texture(u_source, v_uv + vec2(0.0, -2.0) * u_texel).rgb;
  c += texture(u_source, v_uv + vec2(0.0, 2.0) * u_texel).rgb;
  c += texture(u_source, v_uv + vec2(-1.0, -1.0) * u_texel).rgb * 2.0;
  c += texture(u_source, v_uv + vec2(1.0, -1.0) * u_texel).rgb * 2.0;
  c += texture(u_source, v_uv + vec2(-1.0, 1.0) * u_texel).rgb * 2.0;
  c += texture(u_source, v_uv + vec2(1.0, 1.0) * u_texel).rgb * 2.0;
  outColor = vec4(c / 12.0, 1.0);
}
`;

/**
 * Scene plus bloom, tone-mapped so hot cores roll off to white instead of clipping, then softened over the readable
 * parts of the screen: strongly behind the lyrics, partly over the melody roll.
 */
export const compositeFragment = `${header}
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
uniform vec2 u_view;
uniform vec4 u_lyrics;   // x, y, w, h in CSS px; w = 0 when absent
uniform vec4 u_roll;
in vec2 v_uv;
out vec4 outColor;
float box(vec2 p, vec4 r, float radius, float soft) {
  if (r.z <= 0.0) return 0.0;
  vec2 c = r.xy + r.zw * 0.5;
  vec2 q = abs(p - c) - r.zw * 0.5 + radius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  return 1.0 - smoothstep(-soft, soft, d);
}
void main() {
  vec3 c = texture(u_scene, v_uv).rgb + texture(u_bloom, v_uv).rgb * u_bloomStrength;
  c = vec3(1.0) - exp(-c * 1.15);
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_view;
  float keep = 1.0 - 0.82 * box(p, u_lyrics, 24.0, 40.0);
  keep *= 1.0 - 0.5 * box(p, u_roll, 16.0, 6.0);
  c *= keep;
  float alpha = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  outColor = vec4(c / max(alpha, 0.0001), alpha);
}
`;
