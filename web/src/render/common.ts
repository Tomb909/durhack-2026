// Shared constants, uniforms and GLSL used by every part of the renderer.
//
// The renderer's whole view of the world is seven textures (see fields.ts):
//   uFieldA = height, temperature, wetness, vegetation
//   uFieldB = waterSurface, river, precipitation, inside mask (0.5 on the outline)
//   uFieldC = homes, farms, fishing, lavaHeat (1 molten .. 0 set to rock)
//   uFieldD = cleared (felled forest, permanent), logging, lavaSurface, lava (how much covers the ground)
//   uFieldE = ash (lava spread wide: burnt ground), lava glow (molten lava spread a little),
//             molten lava spread a medium way (scoria, crater rim), any lava spread a medium way (basalt)
//   uFieldF = wind-x, wind-z, wind-blown snow, (spare)
//             (Lava and wind were each written to take C.a, D.b and D.a; wind moved here.)
//   uFieldG = town, city, plaza (the square in the middle of a town or city), unused
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

/**
 * Toward the sun: low (about 31 degrees) so everything casts a long shadow, from the
 * left and a little behind the world as first seen, so its glitter on the water and
 * its light through the leaves face the viewer while the near faces stay lit.
 */
export const SUN_DIR = new THREE.Vector3(-0.72, 0.48, -0.3).normalize();
/** Size of the sun's shadow map (texels a side) and of the cloud cover map. */
export const SHADOW_SIZE = 2048;
export const CLOUD_MAP_SIZE = 256;

export interface SharedUniforms {
  [name: string]: THREE.IUniform;
  uFieldA: THREE.IUniform<THREE.Texture | null>;
  uFieldB: THREE.IUniform<THREE.Texture | null>;
  uFieldC: THREE.IUniform<THREE.Texture | null>;
  uFieldD: THREE.IUniform<THREE.Texture | null>;
  uFieldE: THREE.IUniform<THREE.Texture | null>;
  uFieldF: THREE.IUniform<THREE.Texture | null>;
  uFieldG: THREE.IUniform<THREE.Texture | null>;
  uTexel: THREE.IUniform<THREE.Vector2>;
  uGrid: THREE.IUniform<THREE.Vector2>;
  /** World width and depth in scene units. */
  uWorld: THREE.IUniform<THREE.Vector2>;
  uSea: THREE.IUniform<number>;
  /** The highest ground in the world, in scene units (shadow rays stop once clear of it). */
  uPeak: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  /** Height of the picture in pixels. */
  uViewHeight: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uFreezing: THREE.IUniform<number>;
  /** The world's conditions, for the sky: how hot, cold, wet and alive (each 0..1). See mood.ts. */
  uMood: THREE.IUniform<THREE.Vector4>;
  /** Per card: table x, table y, seconds since it appeared, strength. */
  uPulse: THREE.IUniform<THREE.Vector4[]>;
  uPulseColor: THREE.IUniform<THREE.Color[]>;
  uPulseCount: THREE.IUniform<number>;
  /** Per card with a biome: table u, v, radius (share of width), strength. */
  uBiome: THREE.IUniform<THREE.Vector4[]>;
  uBiomeGround: THREE.IUniform<THREE.Color[]>;
  uBiomeRock: THREE.IUniform<THREE.Color[]>;
  /** Colour, and 1 when the biome has its own (0: the world's greens, or water). */
  uBiomePlants: THREE.IUniform<THREE.Vector4[]>;
  uBiomeLiquid: THREE.IUniform<THREE.Vector4[]>;
  /** x: how far the liquid is lit from within (0..1). y: 1 when the world's own trees grow here. */
  uBiomeExtra: THREE.IUniform<THREE.Vector4[]>;
  uBiomeCount: THREE.IUniform<number>;
  /** Where smoke rises (see vents.ts): table u, table v, strength, unused. */
  uVent: THREE.IUniform<THREE.Vector4[]>;
  uVentCount: THREE.IUniform<number>;
  /** Depth of everything that casts a shadow, seen from the sun (see scene.ts). */
  uShadowMap: THREE.IUniform<THREE.Texture | null>;
  /** How much cloud lies between each point and the sun (0..1), seen from the sun. */
  uCloudMap: THREE.IUniform<THREE.Texture | null>;
  /** Scene position to the sun's view (both maps). */
  uSunMatrix: THREE.IUniform<THREE.Matrix4>;
}

export const MAX_PULSES = 16;
/** Cards with a biome (their own ground, plants, rock and liquid), at most this many at once. */
export const MAX_BIOMES = 8;

export function makeSharedUniforms(): SharedUniforms {
  return {
    uFieldA: { value: null },
    uFieldB: { value: null },
    uFieldC: { value: null },
    uFieldD: { value: null },
    uFieldE: { value: null },
    uFieldF: { value: null },
    uFieldG: { value: null },
    uTexel: { value: new THREE.Vector2(1 / GW, 1 / gridHeight(world.aspect)) },
    uGrid: { value: new THREE.Vector2(GW, gridHeight(world.aspect)) },
    uWorld: { value: new THREE.Vector2(world.w, world.d) },
    uSea: { value: RULES.seaBase },
    uPeak: { value: 1e9 },
    uTime: { value: 0 },
    uViewHeight: { value: 1080 },
    uSunDir: { value: SUN_DIR.clone() },
    uFreezing: { value: RULES.freezing },
    uMood: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPulse: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Vector4(0, 0, 99, 0)) },
    uPulseColor: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Color(1, 1, 1)) },
    uPulseCount: { value: 0 },
    uBiome: { value: Array.from({ length: MAX_BIOMES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uBiomeGround: { value: Array.from({ length: MAX_BIOMES }, () => new THREE.Color(1, 1, 1)) },
    uBiomeRock: { value: Array.from({ length: MAX_BIOMES }, () => new THREE.Color(1, 1, 1)) },
    uBiomePlants: { value: Array.from({ length: MAX_BIOMES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uBiomeLiquid: { value: Array.from({ length: MAX_BIOMES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uBiomeExtra: { value: Array.from({ length: MAX_BIOMES }, () => new THREE.Vector4(0, 1, 0, 0)) },
    uBiomeCount: { value: 0 },
    uVent: { value: Array.from({ length: MAX_VENTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uVentCount: { value: 0 },
    uShadowMap: { value: null },
    uCloudMap: { value: null },
    uSunMatrix: { value: new THREE.Matrix4() },
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
uniform sampler2D uFieldG;
uniform vec2 uTexel;
uniform vec2 uGrid;
uniform float uSea;
uniform float uPeak;
uniform float uTime;
uniform vec3 uSunDir;
uniform float uFreezing;
uniform vec4 uMood;
uniform sampler2D uShadowMap;
uniform sampler2D uCloudMap;
uniform mat4 uSunMatrix;

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
// Town, city and plaza (the square in the middle of a town or city).
vec4 fieldG(vec2 uv) { return texture2D(uFieldG, fieldUv(uv)); }

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

// A scatter of boulders over the land (scene x,z). x: how much of a boulder is here (0..1);
// yz: which way its surface leans, for shading it as a dome. chance: share of plots with one.
// Shared so the grass can stand clear of the same stones the land draws.
vec3 boulders(vec2 xz, float chance) {
  vec2 p = xz * 3.2;
  vec2 cell = floor(p);
  if (hash21(cell + 3.7) > chance) return vec3(0.0);
  vec2 centre = 0.25 + 0.5 * vec2(hash21(cell + 11.1), hash21(cell + 23.9));
  float radius = 0.09 + 0.15 * hash21(cell + 41.3);
  vec2 d = (fract(p) - centre) / radius;
  d.y *= 1.0 + 0.7 * hash21(cell + 5.5);
  float r = length(d);
  return vec3(1.0 - smoothstep(0.7, 1.0, r), d * step(r, 1.0));
}
// How much of the ground is a hillside (above the plains), and how much is high mountain.
float hillside(float h) { return smoothstep(0.075, 0.15, h); }
float alpine(float h) { return smoothstep(0.16, 0.34, h); }

// --- Light ------------------------------------------------------------------------
// Late-afternoon sun and a cool sky. Every surface takes its sunlight through
// sunlight(): the land's own relief (mountains shade valleys), everything that
// stands on it (trees, houses, people: a shadow map), and the clouds overhead.
const vec3 SUN_LIGHT = vec3(1.0, 0.86, 0.68) * 2.45;
const vec3 SKY_LIGHT = vec3(0.36, 0.52, 0.95) * 0.62;
const vec3 BOUNCE_LIGHT = vec3(0.70, 0.50, 0.32) * 0.20;
const float SHADOW_TEXEL = ${(1 / SHADOW_SIZE).toFixed(6)};

// The land's relief: walk toward the sun over the height texture; soft-edged.
float reliefShadow(vec3 p) {
  float res = 1.0;
  float t = 0.05;
  for (int i = 0; i < 22; i++) {
    vec3 q = p + uSunDir * t;
    vec2 uv = tableUv(q.xz);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float gap = q.y - fieldA(uv).r * HSCALE;
    res = min(res, 8.0 * gap / t);
    if (res < 0.0) break;
    t += 0.07 + t * 0.14;
  }
  return smoothstep(0.0, 1.0, res);
}

vec3 sunSpace(vec3 p) {
  vec4 s = uSunMatrix * vec4(p, 1.0);
  return s.xyz / s.w * 0.5 + 0.5;
}

// Trees, houses and people: a shadow map, softened over a small disc of taps.
float castShadow(vec3 p) {
  vec3 c = sunSpace(p);
  if (c.x <= 0.0 || c.x >= 1.0 || c.y <= 0.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  float bias = 0.0009;
  float lit = 0.0;
  float angle = hash21(p.xz * 91.7) * 6.2832;
  mat2 spin = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 2.39996;
    vec2 o = spin * vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / 8.0) * 2.2 * SHADOW_TEXEL;
    lit += step(c.z - bias, texture2D(uShadowMap, c.xy + o).r);
  }
  return lit / 8.0;
}

// Clouds: soft, moving shade where they pass between the land and the sun.
float cloudShade(vec3 p) {
  vec3 c = sunSpace(p);
  float cover = texture2D(uCloudMap, c.xy).r;
  return 1.0 - 0.55 * smoothstep(0.0, 0.9, cover);
}

float sunlight(vec3 p, vec3 n) {
  vec3 q = p + n * 0.02;
  return reliefShadow(q) * castShadow(q) * cloudShade(q);
}
`;

/**
 * GLSL for biomes (include after GLSL_COMMON): a card's own ground, plants, rock and liquid, held
 * inside its radius. The land, the water and the trees each ask `biomeAt` how far a biome holds
 * where they are and lean their colours that far, so a region changes material as one.
 */
export const GLSL_BIOME = /* glsl */ `
uniform vec4 uBiome[${MAX_BIOMES}];
uniform vec3 uBiomeGround[${MAX_BIOMES}];
uniform vec3 uBiomeRock[${MAX_BIOMES}];
uniform vec4 uBiomePlants[${MAX_BIOMES}];
uniform vec4 uBiomeLiquid[${MAX_BIOMES}];
uniform vec4 uBiomeExtra[${MAX_BIOMES}];
uniform int uBiomeCount;
// How far biome i holds at a place (table uv, scene xz): its strength inside, 0 outside, with a ragged edge.
float biomeAt(int i, vec2 uv, vec2 xz) {
  vec4 g = uBiome[i];
  float r = length((uv - g.xy) * vec2(WORLD_W, WORLD_D)) / (g.z * WORLD_W);
  if (r > 1.2) return 0.0;
  return g.w * (1.0 - smoothstep(0.82, 1.0, r + (fbm2(xz * 1.7 + float(i) * 13.0) - 0.5) * 0.3));
}
`;

/** Point the shared uniforms at a new grid and world size (vectors are shared by reference). */
export function setSharedWorld(shared: SharedUniforms, w: number, h: number): void {
  shared.uTexel.value.set(1 / w, 1 / h);
  shared.uGrid.value.set(w, h);
  shared.uWorld.value.set(world.w, world.d);
}
