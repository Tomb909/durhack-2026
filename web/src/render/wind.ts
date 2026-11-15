// Gusts (long ribbons running downwind, dust-coloured over dry ground) and snow carried across the terrain.
import * as THREE from 'three';
import { GLSL_COMMON, type SharedUniforms } from './common';

function seeds(count: number, seed: number): Float32Array {
  const data = new Float32Array(count * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    data[i] = (s >>> 0) / 4294967296;
  }
  for (let i = 0; i < count; i++) {
    data[i * 4] = 0.015 + data[i * 4] * 0.97;
    data[i * 4 + 1] = 0.015 + data[i * 4 + 1] * 0.97;
  }
  return data;
}

function particleGeometry(count: number, seed: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(count, seed), 4));
  geometry.instanceCount = count;
  return geometry;
}

/** Points along each gust ribbon: enough that its bends and loops stay round. */
const RIBBON_SEGMENTS = 40;

/** A strip along x (0 at the head .. 1 at the tail), y = which edge (-1, 1). */
function ribbonGeometry(count: number, seed: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  const points = new Float32Array((RIBBON_SEGMENTS + 1) * 2 * 3);
  const index: number[] = [];
  for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
    points.set([i / RIBBON_SEGMENTS, -1, 0, i / RIBBON_SEGMENTS, 1, 0], i * 6);
    if (i < RIBBON_SEGMENTS) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  geometry.setIndex(index);
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(count, seed), 4));
  geometry.instanceCount = count;
  return geometry;
}

// A gust is a long soft ribbon that draws itself in, runs downwind over the land (a few
// turn a loop on the way) and draws itself out. It faces the eye and is never thinner than
// a couple of pixels: thinner than that it fades instead, so it cannot break into dots.
const gustVertex = /* glsl */ `
${GLSL_COMMON}
uniform float uViewHeight;
attribute vec4 aSeed;
varying float vSide;
varying vec3 vTint;
varying float vAlpha;

const float TRAIL = 0.42; // how much of its path a ribbon covers at once

// Where the gust is, a share u (0..1) of the way along its path.
vec3 pathAt(float u, vec2 origin, vec2 dir, float travel, vec4 seed) {
  vec2 across = vec2(-dir.y, dir.x);
  float along = (u - 0.5) * travel;
  float lift = 0.0;
  // One in five turns a loop part of the way along.
  if (seed.z > 0.8) {
    float turn = clamp((u - 0.36) / 0.3, 0.0, 1.0) * 6.2832;
    float radius = 0.10 + 0.07 * seed.w;
    along += radius * sin(turn);
    lift += radius * (1.0 - cos(turn));
  }
  float sway = sin(u * (4.0 + 5.0 * seed.w) + seed.z * 40.0) * 0.07;
  vec2 xz = tableXz(origin) + dir * along + across * sway;
  vec2 uv = tableUv(xz);
  float ground = max(max(fieldA(uv).r, fieldB(uv).r), uSea) * HSCALE;
  float bob = sin(u * 7.0 + seed.w * 30.0) * 0.045;
  return vec3(xz.x, ground + 0.16 + 0.34 * seed.z + bob + lift, xz.y);
}

void main() {
  // Each time round, the ribbon starts somewhere new.
  float period = 2.6 + 2.2 * aSeed.w;
  float clock = uTime / period + aSeed.z * 7.0 + aSeed.x * 3.0;
  float lap = floor(clock);
  float age = fract(clock);
  vec2 origin = 0.03 + 0.94 * fract(aSeed.xy + lap * vec2(0.6180, 0.7549));

  vec2 wind = fieldF(origin).rg;
  float strength = length(wind);
  if (strength < 0.08) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 dir = wind / strength;
  float travel = (1.3 + 1.3 * aSeed.w) * (0.45 + 0.55 * strength);

  float u = age * (1.0 + TRAIL) - position.x * TRAIL;
  vec3 here = pathAt(u, origin, dir, travel, aSeed);
  vec3 ahead = pathAt(u + 0.012, origin, dir, travel, aSeed);

  vec2 uv = tableUv(here.xz);
  vec4 a = fieldA(uv);
  float inside = step(0.5, fieldB(uv).a) * step(abs(uv.x - 0.5), 0.5) * step(abs(uv.y - 0.5), 0.5);
  float local = length(fieldF(uv).rg);

  // Face the eye: widen across the ribbon's direction as seen.
  vec4 view = viewMatrix * vec4(here, 1.0);
  vec3 tangent = (viewMatrix * vec4(ahead, 1.0)).xyz - view.xyz;
  vec2 side = normalize(vec2(-tangent.y, tangent.x) + vec2(0.00001, 0.0));
  float taper = pow(sin(3.14159 * position.x), 0.7);
  float wanted = (0.016 + 0.014 * strength) * (0.25 + 0.75 * taper);
  float pixel = 2.0 * -view.z / (projectionMatrix[1][1] * uViewHeight);
  float width = max(wanted, 1.1 * pixel);
  view.xy += side * position.y * width;

  float dust = smoothstep(0.18, 0.52, a.g) * (1.0 - smoothstep(0.12, 0.34, a.b));
  vSide = position.y;
  vTint = mix(vec3(0.93, 0.97, 1.0), vec3(0.93, 0.76, 0.52), dust);
  float drawn = smoothstep(0.0, 0.10, u) * (1.0 - smoothstep(0.90, 1.0, u));
  vAlpha = drawn * taper * inside * smoothstep(0.08, 0.34, local) * (0.20 + 0.22 * aSeed.x) * min(1.0, wanted / width * 1.6);
  gl_Position = projectionMatrix * view;
}
`;

const gustFragment = /* glsl */ `
varying float vSide;
varying vec3 vTint;
varying float vAlpha;
void main() {
  float across = 1.0 - smoothstep(0.15, 1.0, abs(vSide));
  gl_FragColor = vec4(vTint, across * vAlpha);
}
`;

const snowVertex = /* glsl */ `
${GLSL_COMMON}
uniform float uViewHeight;
attribute vec4 aSeed;
varying vec2 vQuad;
varying float vAlpha;
void main() {
  vec2 origin = aSeed.xy;
  vec2 wind = fieldF(origin).rg;
  float strength = length(wind);
  vec4 sourceA = fieldA(origin);
  float cold = smoothstep(uFreezing + 0.12, uFreezing - 0.10, sourceA.g);
  float snowCover = cold * smoothstep(0.22, 0.44, sourceA.b);
  float source = max(fieldF(origin).b, snowCover * strength * 0.65);
  float phase = fract(uTime * (0.10 + aSeed.w * 0.12) + aSeed.z);
  vec2 flowUv = vec2(wind.x, wind.y * WORLD_W / WORLD_D);
  vec2 site = origin;
  if (length(flowUv) > 0.001) site += normalize(flowUv) * phase * 0.24;
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  float enabled = source * smoothstep(0.05, 0.24, strength) * step(0.5, b.a);
  float ground = max(a.r, b.r) * HSCALE;
  float flutter = sin(uTime * 2.4 + aSeed.z * 30.0) * 0.025;
  vec3 centre = vec3(tableXz(site).x, ground + 0.04 + (1.0 - phase) * 0.13 + flutter, tableXz(site).y);
  // A round flake facing the eye, never smaller than a couple of pixels (it fades instead).
  vec4 view = viewMatrix * vec4(centre, 1.0);
  float pixel = 2.0 * -view.z / (projectionMatrix[1][1] * uViewHeight);
  float wanted = 0.034;
  float size = max(wanted, 2.4 * pixel);
  view.xy += vec2(position.x, position.y - 0.5) * size;
  vQuad = vec2(position.x + 0.5, position.y);
  vAlpha = enabled * (0.35 + 0.55 * strength) * min(1.0, wanted / size * 1.5);
  gl_Position = projectionMatrix * view;
  if (enabled < 0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const snowFragment = /* glsl */ `
varying vec2 vQuad;
varying float vAlpha;
void main() {
  float flake = 1.0 - smoothstep(0.22, 0.5, length(vQuad - 0.5));
  gl_FragColor = vec4(0.85, 0.94, 1.0, flake * vAlpha * 0.88);
}
`;

function particleMesh(
  shared: SharedUniforms,
  geometry: THREE.InstancedBufferGeometry,
  vertexShader: string,
  fragmentShader: string,
): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  return mesh;
}

export function makeWindEffects(shared: SharedUniforms): THREE.Group {
  const group = new THREE.Group();
  group.add(particleMesh(shared, ribbonGeometry(150, 43), gustVertex, gustFragment));
  group.add(particleMesh(shared, particleGeometry(5200, 71), snowVertex, snowFragment));
  return group;
}
