// Lava: one surface lifted to the lava level texture, like the water. Thin lava lying on
// open ground is painted by the terrain itself with the same look (GLSL_LAVA), so the two
// meet without a seam; this surface is what fills craters and ravines level.
import * as THREE from 'three';
import { GLSL_COMMON, world, type SharedUniforms } from './common';

/** Shared by the terrain and the lava surface. Needs GLSL_COMMON first. */
export const GLSL_LAVA = /* glsl */ `
// Black crust through red and orange to yellow-white. Above 1 so the hottest seams bloom.
vec3 lavaRamp(float x) {
  vec3 c = mix(vec3(0.045, 0.022, 0.020), vec3(0.85, 0.10, 0.02), smoothstep(0.0, 0.38, x));
  c = mix(c, vec3(2.6, 0.72, 0.07), smoothstep(0.32, 0.72, x));
  return mix(c, vec3(4.0, 2.3, 0.55), smoothstep(0.72, 1.0, x));
}
float lavaSeams(vec2 q) {
  float n = fbm2(q * 2.6);
  float veins = 1.0 - smoothstep(0.0, 0.11, abs(n - 0.5));
  return clamp(0.85 * veins + 0.5 * (n - 0.32) + 0.18 * vnoise(q * 9.0), 0.0, 1.0);
}
// Which way is downhill here, in scene units: the crust drifts that way.
vec2 lavaDownhill(vec2 uv) {
  vec2 e = uTexel;
  float dx = fieldA(uv + vec2(e.x, 0.0)).r - fieldA(uv - vec2(e.x, 0.0)).r;
  float dz = fieldA(uv + vec2(0.0, e.y)).r - fieldA(uv - vec2(0.0, e.y)).r;
  vec2 slope = vec2(dx / (2.0 * e.x * WORLD_W), dz / (2.0 * e.y * WORLD_D)) * HSCALE;
  vec2 down = -slope * 0.9;
  float len = length(down);
  return len > 0.55 ? down * (0.55 / len) : down;
}
// The light lava gives off at scene position p: drifting plates of dark crust with glowing
// seams between them. heat 1 = molten, 0 = set to rock (then it gives off almost nothing).
// amount is how much lava covers the ground: the middle of a stream or pool is hottest, its
// thin edge is crusted over.
vec3 lavaGlow(vec2 p, vec2 downhill, float heat, float amount) {
  // Two copies of the pattern, each sliding downhill then starting again, cross-faded so neither restart shows.
  float phase = fract(uTime * 0.11);
  float s0 = lavaSeams(p - downhill * phase);
  float s1 = lavaSeams(p - downhill * fract(phase + 0.5) + 7.3);
  float seams = mix(s0, s1, abs(1.0 - 2.0 * phase));
  float pulse = 0.92 + 0.08 * sin(uTime * 1.6 + p.x * 2.1 + p.y * 1.4);
  float body = smoothstep(0.12, 0.8, amount);   // 0 on the thin rim, 1 in the middle
  float x = (0.22 + 0.78 * seams) * mix(0.30, 1.0, body) * pulse;
  x += 0.30 * smoothstep(0.55, 1.0, amount) * smoothstep(0.5, 1.0, heat) * (0.4 + 0.6 * seams); // the molten core
  return lavaRamp(clamp(x, 0.0, 1.0) * heat);
}
// Lava that has set: near-black rock with a rough, ropy surface. Unlit colour.
vec3 lavaRock(vec2 p) {
  float n = fbm2(p * 5.0);
  float rope = 0.5 + 0.5 * sin(n * 34.0 + vnoise(p * 3.0) * 6.0);
  return mix(vec3(0.016, 0.013, 0.012), vec3(0.052, 0.044, 0.040), n) * (0.7 + 0.5 * rope) * (0.85 + 0.3 * vnoise(p * 38.0));
}
// Faint dull-red cracks in rock that is cooling or has set; added to the lit colour. heat 1 = still molten.
vec3 lavaCracks(vec2 p, float heat) {
  float n = fbm2(p * 7.0 + 3.0);
  float veins = 1.0 - smoothstep(0.0, 0.045, abs(n - 0.5));
  return vec3(0.195, 0.027, 0.006) * veins * (0.55 + 0.9 * heat) * (0.7 + 0.3 * sin(uTime * 0.7 + n * 20.0));
}
`;

const vertex = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec2 uv = tableUv(position.xz);
  vec3 p = vec3(position.x, fieldD(uv).b * HSCALE, position.z);
  vUv = uv;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const fragment = /* glsl */ `
${GLSL_COMMON}
${GLSL_LAVA}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  if (fieldB(vUv).a < 0.499) discard; // outside the play area
  vec4 d = fieldD(vUv);
  float amount = d.a;
  if (d.b - fieldA(vUv).r < 0.0002 || amount < 0.05) discard;
  float heat = fieldC(vUv).a;
  vec2 p = vWorld.xz;
  // Set rock is lit like ground; molten rock is its own light.
  vec3 n = normalize(vec3(vnoise(p * 14.0) - 0.5, 2.2, vnoise(p * 14.0 + 31.7) - 0.5));
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 rock = lavaRock(p) * (vec3(1.0, 0.94, 0.84) * 1.5 * ndl + vec3(0.50, 0.62, 0.88) * 0.5);
  float molten = smoothstep(0.0, 0.6, heat);
  vec3 col = mix(rock + lavaCracks(p, heat), lavaGlow(p, lavaDownhill(vUv), heat, amount), molten);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeLava(shared: SharedUniforms, gw: number, gh: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(world.w, world.d, (gw - 1) * 2, (gh - 1) * 2);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({ uniforms: { ...shared }, vertexShader: vertex, fragmentShader: fragment });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}
