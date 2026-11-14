// Shared constants, uniforms and GLSL used by every part of the renderer.
//
// The renderer's whole view of the world is two textures (see fields.ts):
//   uFieldA = height, temperature, wetness, vegetation
//   uFieldB = waterSurface, river, precipitation, inside mask (0.5 on the outline)
//   uFieldC = homes, farms, fishing, lavaHeat (1 molten .. 0 set to rock)
//   uFieldD = cleared (felled forest, permanent), logging, lavaSurface, lava (how much covers the ground)
//   uFieldE = ash (lava spread wide: burnt ground), lava glow (molten lava spread a little),
//             molten lava spread a medium way (scoria, crater rim), any lava spread a medium way (basalt)
//   uFieldF = wind-x, wind-z, wind-blown snow, (spare)
//             (Lava and wind were each written to take C.a, D.b and D.a; wind moved here.)
// plus the sea level. Rewrite anything in render/ freely: nothing else in the
// app depends on it.
import * as THREE from 'three';
import { A3_ASPECT, GW, RULES, gridHeight } from '../sim/world';
import { MAX_VENTS } from './vents';
export { MAX_VENTS };

/** World size in scene units. X = table left to right, Z = far to near, Y = up. */
export const WORLD_W = 10;
/** Current world size (depth follows the play area's proportions). Mutated by setWorldAspect. */
export const world = { w: WORLD_W, d: WORLD_W / A3_ASPECT, aspect: A3_ASPECT };
export function setWorldAspect(aspect: number): void {
  world.aspect = aspect;
  world.d = WORLD_W / aspect;
}
/** Scene units per unit of sim height. */
export const HSCALE = 4.2;
/** How far down the world goes before it is lost in the dark. Deep enough that it never reads as a thin slab. */
export const SLAB_BOTTOM = -9;

export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();

export interface SharedUniforms {
  [name: string]: THREE.IUniform;
  uFieldA: THREE.IUniform<THREE.Texture | null>;
  uFieldB: THREE.IUniform<THREE.Texture | null>;
  uFieldC: THREE.IUniform<THREE.Texture | null>;
  uFieldD: THREE.IUniform<THREE.Texture | null>;
  uFieldE: THREE.IUniform<THREE.Texture | null>;
  uFieldF: THREE.IUniform<THREE.Texture | null>;
  uTexel: THREE.IUniform<THREE.Vector2>;
  uGrid: THREE.IUniform<THREE.Vector2>;
  /** World width and depth in scene units. */
  uWorld: THREE.IUniform<THREE.Vector2>;
  uSea: THREE.IUniform<number>;
  /** The highest ground in the world, in scene units (shadow rays stop once clear of it). */
  uPeak: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uFreezing: THREE.IUniform<number>;
  /** The world's conditions, for the sky: how hot, cold, wet and alive (each 0..1). See mood.ts. */
  uMood: THREE.IUniform<THREE.Vector4>;
  /** Per card: table x, table y, seconds since it appeared, strength. */
  uPulse: THREE.IUniform<THREE.Vector4[]>;
  uPulseColor: THREE.IUniform<THREE.Color[]>;
  uPulseCount: THREE.IUniform<number>;
  /** Where smoke rises (see vents.ts): table u, table v, strength, unused. */
  uVent: THREE.IUniform<THREE.Vector4[]>;
  uVentCount: THREE.IUniform<number>;
}

export const MAX_PULSES = 16;

export function makeSharedUniforms(): SharedUniforms {
  return {
    uFieldA: { value: null },
    uFieldB: { value: null },
    uFieldC: { value: null },
    uFieldD: { value: null },
    uFieldE: { value: null },
    uFieldF: { value: null },
    uTexel: { value: new THREE.Vector2(1 / GW, 1 / gridHeight(world.aspect)) },
    uGrid: { value: new THREE.Vector2(GW, gridHeight(world.aspect)) },
    uWorld: { value: new THREE.Vector2(world.w, world.d) },
    uSea: { value: RULES.seaBase },
    uPeak: { value: 1e9 },
    uTime: { value: 0 },
    uSunDir: { value: SUN_DIR.clone() },
    uFreezing: { value: RULES.freezing },
    uMood: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPulse: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Vector4(0, 0, 99, 0)) },
    uPulseColor: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Color(1, 1, 1)) },
    uPulseCount: { value: 0 },
    uVent: { value: Array.from({ length: MAX_VENTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uVentCount: { value: 0 },
  };
}

/** GLSL prelude: uniforms, coordinate helpers and noise. */
export const GLSL_COMMON = /* glsl */ `
uniform sampler2D uFieldA;
uniform sampler2D uFieldB;
uniform sampler2D uFieldC;
uniform sampler2D uFieldD;
uniform sampler2D uFieldE;
uniform sampler2D uFieldF;
uniform vec2 uTexel;
uniform vec2 uGrid;
uniform float uSea;
uniform float uPeak;
uniform float uTime;
uniform vec3 uSunDir;
uniform float uFreezing;
uniform vec4 uMood;

uniform vec2 uWorld;
#define WORLD_W uWorld.x
#define WORLD_D uWorld.y
const float HSCALE = ${HSCALE.toFixed(4)};
const float SLAB_BOTTOM = ${SLAB_BOTTOM.toFixed(4)};

// Table position (0..1, 0..1) from scene x,z.
vec2 tableUv(vec2 xz) { return vec2(xz.x / WORLD_W + 0.5, xz.y / WORLD_D + 0.5); }
vec2 tableXz(vec2 uv) { return vec2((uv.x - 0.5) * WORLD_W, (uv.y - 0.5) * WORLD_D); }
// Texture coordinate whose texel centres sit exactly on grid points.
vec2 fieldUv(vec2 uv) { return (clamp(uv, 0.0, 1.0) * (uGrid - 1.0) + 0.5) * uTexel; }
vec4 fieldA(vec2 uv) { return texture2D(uFieldA, fieldUv(uv)); }
vec4 fieldB(vec2 uv) { return texture2D(uFieldB, fieldUv(uv)); }
vec4 fieldC(vec2 uv) { return texture2D(uFieldC, fieldUv(uv)); }
vec4 fieldD(vec2 uv) { return texture2D(uFieldD, fieldUv(uv)); }
vec4 fieldE(vec2 uv) { return texture2D(uFieldE, fieldUv(uv)); }
// Wind (rg: x and z, each -1..1) and wind-blown snow (b).
vec4 fieldF(vec2 uv) { return texture2D(uFieldF, fieldUv(uv)); }

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

/** Point the shared uniforms at a new grid and world size (vectors are shared by reference). */
export function setSharedWorld(shared: SharedUniforms, w: number, h: number): void {
  shared.uTexel.value.set(1 / w, 1 / h);
  shared.uGrid.value.set(w, h);
  shared.uWorld.value.set(world.w, world.d);
}
