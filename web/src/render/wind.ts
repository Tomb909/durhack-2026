// Directional gust streaks, dust and snow carried across the terrain.
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

const gustVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec4 aSeed;
varying vec2 vQuad;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec2 origin = aSeed.xy;
  vec2 flow = fieldF(origin).rg;
  float phase = fract(uTime * (0.12 + aSeed.w * 0.11) + aSeed.z);
  vec2 flowUv = vec2(flow.x, flow.y * WORLD_W / WORLD_D);
  vec2 site = origin;
  if (length(flowUv) > 0.001) site += normalize(flowUv) * (phase - 0.5) * 0.065;
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  vec2 wind = fieldF(site).rg;
  float strength = length(wind);
  float dust = smoothstep(0.18, 0.52, a.g) * (1.0 - smoothstep(0.12, 0.34, a.b));
  float enabled = smoothstep(0.08, 0.32, strength) * step(0.5, b.a);
  float ground = max(a.r, b.r) * HSCALE;
  vec3 direction = normalize(vec3(wind.x, 0.0, wind.y) + vec3(0.00001, 0.0, 0.00001));
  vec3 across = vec3(-direction.z, 0.0, direction.x);
  vec3 centre = vec3(tableXz(site).x, ground + 0.025 + aSeed.z * 0.18, tableXz(site).y);
  float length = 0.08 + 0.14 * strength;
  vec3 p = centre + across * position.x * (0.012 + 0.012 * strength) + direction * (position.y - 0.5) * length;
  vQuad = vec2(position.x + 0.5, position.y);
  vTint = mix(vec3(0.67, 0.84, 0.98), vec3(0.88, 0.66, 0.38), dust);
  vAlpha = enabled * smoothstep(0.08, 0.28, strength) * (0.35 + 0.45 * aSeed.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (enabled < 0.01 || strength < 0.08) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const gustFragment = /* glsl */ `
varying vec2 vQuad;
varying vec3 vTint;
varying float vAlpha;
void main() {
  float across = 1.0 - smoothstep(0.18, 0.5, abs(vQuad.x - 0.5) * 2.0);
  float ends = smoothstep(0.0, 0.18, vQuad.y) * (1.0 - smoothstep(0.74, 1.0, vQuad.y));
  gl_FragColor = vec4(vTint, across * ends * vAlpha);
}
`;

const snowVertex = /* glsl */ `
${GLSL_COMMON}
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
  vec3 direction = normalize(vec3(wind.x, 0.0, wind.y) + vec3(0.00001, 0.0, 0.00001));
  vec3 across = vec3(-direction.z, 0.0, direction.x);
  vec3 p = centre + across * position.x * 0.018 + direction * (position.y - 0.5) * 0.052;
  vQuad = vec2(position.x + 0.5, position.y);
  vAlpha = enabled * (0.35 + 0.55 * strength);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
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
  count: number,
  seed: number,
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
  const mesh = new THREE.Mesh(particleGeometry(count, seed), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  return mesh;
}

export function makeWindEffects(shared: SharedUniforms): THREE.Group {
  const group = new THREE.Group();
  group.add(particleMesh(shared, 3800, 43, gustVertex, gustFragment));
  group.add(particleMesh(shared, 5200, 71, snowVertex, snowFragment));
  return group;
}
