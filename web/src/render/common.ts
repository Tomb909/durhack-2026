// Shared constants, uniforms and GLSL used by every part of the renderer.
//
// The renderer's whole view of the world is two textures (see fields.ts):
//   uFieldA = height, temperature, wetness, vegetation
//   uFieldB = waterSurface, river, precipitation, (spare)
// plus the sea level. Rewrite anything in render/ freely: nothing else in the
// app depends on it.
import * as THREE from 'three';
import { ASPECT, GH, GW, RULES } from '../sim/world';

/** World size in scene units. X = table left to right, Z = far to near, Y = up. */
export const WORLD_W = 10;
export const WORLD_D = WORLD_W / ASPECT;
/** Scene units per unit of sim height. */
export const HSCALE = 4.2;
export const SLAB_BOTTOM = -1.7;

export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();

export interface SharedUniforms {
  [name: string]: THREE.IUniform;
  uFieldA: THREE.IUniform<THREE.Texture | null>;
  uFieldB: THREE.IUniform<THREE.Texture | null>;
  uTexel: THREE.IUniform<THREE.Vector2>;
  uGrid: THREE.IUniform<THREE.Vector2>;
  uSea: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uFreezing: THREE.IUniform<number>;
}

export function makeSharedUniforms(): SharedUniforms {
  return {
    uFieldA: { value: null },
    uFieldB: { value: null },
    uTexel: { value: new THREE.Vector2(1 / GW, 1 / GH) },
    uGrid: { value: new THREE.Vector2(GW, GH) },
    uSea: { value: RULES.seaBase },
    uTime: { value: 0 },
    uSunDir: { value: SUN_DIR.clone() },
    uFreezing: { value: RULES.freezing },
  };
}

/** GLSL prelude: uniforms, coordinate helpers and noise. */
export const GLSL_COMMON = /* glsl */ `
uniform sampler2D uFieldA;
uniform sampler2D uFieldB;
uniform vec2 uTexel;
uniform vec2 uGrid;
uniform float uSea;
uniform float uTime;
uniform vec3 uSunDir;
uniform float uFreezing;

const float WORLD_W = ${WORLD_W.toFixed(4)};
const float WORLD_D = ${WORLD_D.toFixed(4)};
const float HSCALE = ${HSCALE.toFixed(4)};
const float SLAB_BOTTOM = ${SLAB_BOTTOM.toFixed(4)};

// Table position (0..1, 0..1) from scene x,z.
vec2 tableUv(vec2 xz) { return vec2(xz.x / WORLD_W + 0.5, xz.y / WORLD_D + 0.5); }
vec2 tableXz(vec2 uv) { return vec2((uv.x - 0.5) * WORLD_W, (uv.y - 0.5) * WORLD_D); }
// Texture coordinate whose texel centres sit exactly on grid points.
vec2 fieldUv(vec2 uv) { return (clamp(uv, 0.0, 1.0) * (uGrid - 1.0) + 0.5) * uTexel; }
vec4 fieldA(vec2 uv) { return texture2D(uFieldA, fieldUv(uv)); }
vec4 fieldB(vec2 uv) { return texture2D(uFieldB, fieldUv(uv)); }

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;
