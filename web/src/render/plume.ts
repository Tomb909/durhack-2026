// Smoke and embers over molten lava. Like the weather, every particle has a fixed
// slot and works out where it is from uTime alone: a vent (see vents.ts) owns a column
// of puffs, each at a different stage of the same rise, so there is no state to keep and a
// picture drawn at one moment is always the same picture.
import * as THREE from 'three';
import { GLSL_COMMON, MAX_VENTS, type SharedUniforms } from './common';

const PUFFS = 56; // per vent
const EMBERS = 7; // per vent
const WIND = 'vec2(0.80, 0.30)'; // which way the smoke leans, scene xz

function rand(count: number, seed: number): Float32Array {
  const data = new Float32Array(count * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    data[i] = (s >>> 0) / 4294967296;
  }
  return data;
}

function quad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const COMMON = /* glsl */ `
${GLSL_COMMON}
uniform vec4 uVent[${MAX_VENTS}];
uniform int uVentCount;
attribute vec4 aSeed;
attribute vec2 aInfo; // x: which vent, y: this particle's place in the cycle (0..1)
vec3 ventBase(vec4 vent) {
  vec2 uv = vent.xy;
  float ground = max(fieldA(uv).r, fieldD(uv).b) * HSCALE;
  vec2 xz = tableXz(uv);
  return vec3(xz.x, ground, xz.y);
}
`;

const smokeVertex = /* glsl */ `
${COMMON}
varying vec2 vQuad;
varying float vLife;
varying float vAlpha;
varying vec4 vSeed;
varying float vStrength;
varying vec2 vSunView;
void main() {
  int vi = int(aInfo.x + 0.5);
  vec4 vent = uVent[vi];
  float s = vent.z;
  float life = fract(uTime * (0.085 + 0.02 * aSeed.w) + aInfo.y + aInfo.x * 0.173);
  float tall = mix(0.9, 3.9, s * s * (3.0 - 2.0 * s));
  float rise = 1.0 - pow(1.0 - life, 1.7);
  vec3 base = ventBase(vent);
  float spread = 0.05 + 0.16 * s;
  float ang = aSeed.x * 6.2832;
  vec2 off = vec2(cos(ang), sin(ang)) * sqrt(aSeed.y) * spread * (1.0 - life);
  vec2 lean = ${WIND} * tall * 0.34 * life * life;
  vec2 wob = vec2(sin(uTime * 0.55 + aSeed.z * 40.0 + life * 5.0), cos(uTime * 0.47 + aSeed.w * 40.0 + life * 4.0)) * (0.03 + 0.16 * life) * (0.4 + s);
  vec3 centre = base + vec3(off.x + lean.x + wob.x, 0.12 + tall * rise, off.y + lean.y + wob.y);
  float size = (0.11 + 0.68 * pow(life, 0.72)) * (0.35 + 0.75 * s) * (0.75 + 0.5 * aSeed.y);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = centre + (right * position.x + up * position.y) * size;
  vQuad = position.xy;
  vLife = life;
  vSeed = aSeed;
  vStrength = s;
  vSunView = (viewMatrix * vec4(uSunDir, 0.0)).xy;
  // Fade in at the vent, thin out as it climbs; weak vents only wisp.
  vAlpha = smoothstep(0.0, 0.07, life) * (1.0 - smoothstep(0.35, 1.0, life)) * smoothstep(0.08, 0.35, s) * (0.075 + 0.20 * s);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (vi >= uVentCount || s < 0.06) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const smokeFragment = /* glsl */ `
${GLSL_COMMON}
varying vec2 vQuad;
varying float vLife;
varying float vAlpha;
varying vec4 vSeed;
varying float vStrength;
varying vec2 vSunView;
void main() {
  float d = length(vQuad);
  if (d > 1.0) discard;
  // A ragged-edged, billowy disc: noise nibbles the rim, a second octave darkens the folds.
  vec2 q = vQuad * 1.7 + vSeed.xy * 31.0 + vec2(uTime * 0.04, -uTime * 0.03);
  float n = vnoise(q * 1.6);
  float m = vnoise(q * 3.7 + 9.0);
  float shape = 1.0 - smoothstep(0.30 + 0.30 * (n - 0.5), 0.98, d + 0.18 * (m - 0.5));
  shape *= shape;
  if (shape < 0.01) discard;
  vec3 dark = vec3(0.156, 0.144, 0.138);   // #6E6A68
  vec3 pale = vec3(0.366, 0.342, 0.323);   // #A39E9A
  vec3 warm = vec3(0.254, 0.159, 0.122);   // #8A6F62
  vec3 col = mix(dark, pale, smoothstep(0.05, 0.85, vLife));
  // Lit from the sun's side, shaded on the far side of each puff.
  float side = dot(vQuad, normalize(vSunView + 1e-4));
  col *= 0.45 + 0.85 * (0.5 + 0.5 * side * (0.6 + 0.4 * vSeed.z)) + 0.35 * (m - 0.5);
  // Near the vent the glow underneath tints it warm, strongest on the underside.
  float lowDown = (1.0 - smoothstep(0.0, 0.4, vLife)) * vStrength;
  col = mix(col, warm * 1.5, lowDown * (0.35 + 0.35 * (0.5 - 0.5 * vQuad.y)));
  col += vec3(1.0, 0.30, 0.06) * lowDown * lowDown * (0.5 - 0.5 * vQuad.y) * 0.45;
  gl_FragColor = vec4(col, shape * vAlpha);
}
`;

const emberVertex = /* glsl */ `
${COMMON}
varying vec2 vQuad;
varying float vBright;
void main() {
  int vi = int(aInfo.x + 0.5);
  vec4 vent = uVent[vi];
  float s = vent.z;
  float life = fract(uTime * (0.22 + 0.2 * aSeed.w) + aInfo.y);
  vec3 base = ventBase(vent);
  float ang = aSeed.x * 6.2832;
  float reach = (0.05 + 0.45 * aSeed.y) * (0.4 + s);
  vec2 out2 = vec2(cos(ang), sin(ang)) * reach * life;
  float h = (0.4 + 1.8 * aSeed.z) * (0.4 + 0.6 * s) * (1.0 - pow(1.0 - life, 2.0));
  vec2 lean = ${WIND} * 0.5 * life * life;
  vec2 flutter = vec2(sin(uTime * 3.1 + aSeed.x * 60.0), cos(uTime * 2.7 + aSeed.y * 60.0)) * 0.03 * life;
  vec3 centre = base + vec3(out2.x + lean.x + flutter.x, 0.04 + h, out2.y + lean.y + flutter.y);
  float size = 0.016 * (0.7 + 0.6 * aSeed.w) * (1.0 - 0.6 * life);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = centre + (right * position.x + up * position.y) * size;
  vQuad = position.xy;
  float flicker = 0.7 + 0.3 * sin(uTime * 14.0 + aSeed.x * 90.0);
  vBright = smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.55, 1.0, life)) * flicker * smoothstep(0.35, 0.6, s);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (vi >= uVentCount || s < 0.35) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const emberFragment = /* glsl */ `
varying vec2 vQuad;
varying float vBright;
void main() {
  float d = length(vQuad);
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  // Above the bloom threshold, so each spark glows.
  gl_FragColor = vec4(vec3(5.5, 2.0, 0.35) * core, core * vBright);
}
`;

function make(
  shared: SharedUniforms, vents: number, per: number, seed: number, vertexShader: string, fragmentShader: string,
  blending: THREE.Blending, order: number,
): THREE.Mesh {
  const count = vents * per;
  const geometry = quad();
  const info = new Float32Array(count * 2);
  for (let v = 0; v < vents; v++) {
    for (let k = 0; k < per; k++) {
      info[(v * per + k) * 2] = v;
      info[(v * per + k) * 2 + 1] = k / per;
    }
  }
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(rand(count, seed), 4));
  geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 2));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared }, vertexShader, fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return mesh;
}

export function makePlume(shared: SharedUniforms): THREE.Group {
  const group = new THREE.Group();
  group.add(make(shared, MAX_VENTS, PUFFS, 17, smokeVertex, smokeFragment, THREE.NormalBlending, 4));
  group.add(make(shared, MAX_VENTS, EMBERS, 29, emberVertex, emberFragment, THREE.AdditiveBlending, 7));
  return group;
}
