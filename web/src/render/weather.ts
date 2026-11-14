// Rain, snow and clouds. Every particle has a fixed site on the map and reads
// the precipitation and temperature textures there, so weather simply appears
// wherever the world says it is wet: rain if mild or hot, snow if cold.
import { castsCloudShade } from './post';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLSL_COMMON, type SharedUniforms } from './common';

const CLOUD_HEIGHT = 2.3; // above the ground, scene units

function seeds(count: number, seed: number): Float32Array {
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
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const fallVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec4 aSeed;
uniform float uSnow; // 0 = rain streaks, 1 = snowflakes
varying float vAlpha;
varying vec2 vQuad;
void main() {
  vec2 site = aSeed.xy;
  float speed = mix(1.5 + aSeed.w * 0.6, 0.22 + aSeed.w * 0.12, uSnow);
  float life = fract(uTime * speed + aSeed.z * 7.0);
  vec2 wind = fieldD(site).ba;
  vec2 windUv = vec2(wind.x, wind.y * WORLD_W / WORLD_D);
  // Both rain and snow travel downwind; snow has a stronger sideways drift.
  site += windUv * mix(0.20, 0.30, uSnow) * life;
  site += uSnow * 0.012 * vec2(sin(uTime * 1.3 + aSeed.z * 40.0), cos(uTime * 1.1 + aSeed.w * 40.0));
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  float cold = smoothstep(uFreezing + 0.08, uFreezing - 0.08, a.g);
  float kind = mix(1.0 - cold, cold, uSnow);
  // More precipitation = more of the particles switched on.
  float on = step(aSeed.w, b.b * 1.05) * step(0.02, b.b) * kind;
  float ground = max(a.r, b.r) * HSCALE;
  float y = ground + ${CLOUD_HEIGHT.toFixed(2)} * (1.0 - life);
  vec2 xz = tableXz(site);
  vec3 centre = vec3(xz.x, y, xz.y);
  vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
  vec2 size = mix(vec2(0.014, 0.20), vec2(0.045, 0.045), uSnow);
  vec3 up = mix(vec3(0.0, 1.0, 0.0), vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]), uSnow);
  vec3 windWorld = vec3(wind.x, 0.0, wind.y) * mix(0.16, 0.12, uSnow);
  vec3 p = centre + right * position.x * size.x + up * position.y * size.y + windWorld * position.y * 0.045;
  vAlpha = on * smoothstep(0.0, 0.08, life) * smoothstep(1.0, 0.9, life);
  vQuad = vec2(position.x + 0.5, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (on < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen
}
`;

const fallFragment = /* glsl */ `
uniform float uSnow;
varying float vAlpha;
varying vec2 vQuad;
void main() {
  // max(): a streak thinner than a pixel is sampled off its edge, where this would go negative and draw black.
  float streak = max(0.0, 1.0 - abs(vQuad.x - 0.5) * 2.0) * smoothstep(0.0, 0.3, vQuad.y);
  float flake = 1.0 - smoothstep(0.25, 0.5, length(vQuad - 0.5));
  float shape = mix(streak, flake, uSnow);
  vec3 col = mix(vec3(0.72, 0.84, 1.0), vec3(1.0), uSnow);
  gl_FragColor = vec4(col * 1.2, shape * vAlpha * mix(0.55, 0.95, uSnow));
}
`;

function makeFall(shared: SharedUniforms, count: number, snow: boolean, seed: number): THREE.Mesh {
  const geometry = quad();
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(count, seed), 4));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared, uSnow: { value: snow ? 1 : 0 } },
    vertexShader: fallVertex,
    fragmentShader: fallFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}

const cloudVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec4 aSeed;
varying vec3 vWorld;
varying float vRain;
varying float vShade;
void main() {
  vec2 site = aSeed.xy;
  vec2 wind = fieldD(site).ba;
  vec2 windUv = vec2(wind.x, wind.y * WORLD_W / WORLD_D);
  site += windUv * sin(uTime * 0.08 + aSeed.w * 6.2832) * 0.035;
  site += 0.012 * vec2(sin(uTime * 0.11 + aSeed.z * 30.0), cos(uTime * 0.09 + aSeed.w * 30.0));
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  float rain = b.b;
  float grow = smoothstep(0.40 + aSeed.w * 0.45, 0.62 + aSeed.w * 0.45, rain);
  float size = (0.45 + 0.45 * aSeed.z) * grow;
  float angle = aSeed.w * 6.2832;
  float c = cos(angle), s = sin(angle);
  vec3 p = vec3(c * position.x - s * position.z, position.y, s * position.x + c * position.z) * size;
  float ground = max(a.r, b.r) * HSCALE;
  vec2 xz = tableXz(site);
  vec3 world = vec3(xz.x, ground + ${CLOUD_HEIGHT.toFixed(2)} + 0.25 * aSeed.z + 0.05 * sin(uTime * 0.6 + aSeed.w * 20.0), xz.y) + p;
  vWorld = world;
  vRain = rain;
  vShade = position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  if (grow < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const cloudFragment = /* glsl */ `
${GLSL_COMMON}
varying vec3 vWorld;
varying float vRain;
varying float vShade;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float ndl = dot(n, uSunDir) * 0.5 + 0.5;
  vec3 bright = vec3(0.86, 0.87, 0.90);
  vec3 storm = vec3(0.52, 0.56, 0.64);
  vec3 col = mix(bright, storm, smoothstep(0.45, 1.0, vRain));
  col *= 0.62 + 0.55 * ndl;
  col *= 0.85 + 0.3 * smoothstep(-0.1, 0.25, vShade); // darker bellies
  gl_FragColor = vec4(col, 0.80);
}
`;

function cloudShape(): THREE.BufferGeometry {
  const lump = (r: number, x: number, y: number, z: number) =>
    new THREE.IcosahedronGeometry(r, 1).scale(1, 0.62, 1).translate(x, y, z).toNonIndexed();
  const merged = mergeGeometries([
    lump(0.42, 0, 0, 0), lump(0.30, 0.36, -0.03, 0.08), lump(0.27, -0.34, -0.02, -0.06), lump(0.24, 0.08, 0.10, -0.26), lump(0.22, -0.06, 0.04, 0.27),
  ]);
  merged.deleteAttribute('uv');
  merged.deleteAttribute('normal');
  return merged;
}

function makeClouds(shared: SharedUniforms, columns: number, rows: number): THREE.Mesh {
  const count = columns * rows;
  const data = seeds(count, 91);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const k = (j * columns + i) * 4;
      data[k] = (i + 0.15 + 0.7 * data[k]) / columns;
      data[k + 1] = (j + 0.15 + 0.7 * data[k + 1]) / rows;
    }
  }
  const base = cloudShape();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(data, 4));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared }, vertexShader: cloudVertex, fragmentShader: cloudFragment, transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

export function makeWeather(shared: SharedUniforms): THREE.Group {
  const group = new THREE.Group();
  const clouds = makeClouds(shared, 11, 8);
  castsCloudShade(clouds);
  group.add(clouds);
  group.add(makeFall(shared, 3500, false, 5));
  group.add(makeFall(shared, 2600, true, 9));
  return group;
}
