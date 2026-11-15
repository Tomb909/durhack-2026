// Plants: thousands of small trees at fixed sites. Each one grows or shrinks
// in the vertex shader according to the vegetation texture at its site, so
// forests spread and retreat smoothly with no work on the CPU.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLSL_BIOME, GLSL_COMMON, MAX_BIOMES, type SharedUniforms } from './common';
import { SPARE, Sites, together, type Culled } from './sites';

/** A tree stands where the plant cover beats its own threshold: its random number times this. (Shader and CPU test share it.) */
const GROW_SPREAD = 0.72;
const glsl = (v: number) => v.toFixed(4);

/** Parts share corners: each is worked out once by the GPU, not once per triangle that touches it. */
const weld = (parts: THREE.BufferGeometry[]) => mergeVertices(mergeGeometries(parts), 1e-5);

function paint(geometry: THREE.BufferGeometry, colour: [number, number, number], leaf: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const count = g.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  const leaves = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    colours.set(colour, i * 3);
    leaves[i] = leaf;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  g.setAttribute('aLeaf', new THREE.BufferAttribute(leaves, 1));
  return g;
}

const TRUNK: [number, number, number] = [0.30, 0.20, 0.12];

function conifer(): THREE.BufferGeometry {
  const leaf: [number, number, number] = [0.10, 0.30, 0.19];
  return weld([
    paint(new THREE.CylinderGeometry(0.035, 0.05, 0.25, 5).translate(0, 0.125, 0), TRUNK, 0),
    paint(new THREE.ConeGeometry(0.23, 0.40, 6).translate(0, 0.40, 0), leaf, 1),
    paint(new THREE.ConeGeometry(0.18, 0.34, 6).translate(0, 0.60, 0), leaf, 1),
    paint(new THREE.ConeGeometry(0.12, 0.30, 6).translate(0, 0.80, 0), leaf, 1),
  ]);
}

function broadleaf(): THREE.BufferGeometry {
  const leaf: [number, number, number] = [0.22, 0.47, 0.17];
  return weld([
    paint(new THREE.CylinderGeometry(0.04, 0.06, 0.32, 5).translate(0, 0.16, 0), TRUNK, 0),
    paint(new THREE.IcosahedronGeometry(0.27, 0).scale(1, 0.88, 1).translate(0, 0.52, 0), leaf, 1),
    paint(new THREE.IcosahedronGeometry(0.18, 0).translate(0.15, 0.42, 0.06), leaf, 1),
    paint(new THREE.IcosahedronGeometry(0.15, 0).translate(-0.13, 0.44, -0.08), leaf, 1),
  ]);
}

function jungle(): THREE.BufferGeometry {
  const leaf: [number, number, number] = [0.08, 0.40, 0.16];
  return weld([
    paint(new THREE.CylinderGeometry(0.028, 0.045, 0.75, 5).translate(0, 0.375, 0), TRUNK, 0),
    paint(new THREE.IcosahedronGeometry(0.30, 0).scale(1.25, 0.34, 1.25).translate(0, 0.80, 0), leaf, 1),
    paint(new THREE.IcosahedronGeometry(0.20, 0).scale(1.2, 0.4, 1.2).translate(0.10, 0.92, 0.05), leaf, 1),
    paint(new THREE.IcosahedronGeometry(0.16, 0).scale(1.2, 0.45, 1.2).translate(-0.16, 0.66, -0.06), leaf, 1),
  ]);
}

const vertex = /* glsl */ `
${GLSL_COMMON}
${GLSL_BIOME}
attribute vec2 aSite;
attribute vec4 aRand;
attribute vec3 color;
attribute float aLeaf;
uniform vec3 uRange; // coldest, hottest, fade
uniform float uSize;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vLeaf;
void main() {
  vec4 a = fieldA(aSite);
  vec4 b = fieldB(aSite);
  float temperature = a.g;
  float fits = smoothstep(uRange.x - uRange.z, uRange.x, temperature) * (1.0 - smoothstep(uRange.y, uRange.y + uRange.z, temperature));
  float dry = 1.0 - smoothstep(0.0, 0.0015, b.r - a.r);
  float threshold = aRand.x * ${glsl(GROW_SPREAD)}; // the CPU test in makeForest uses the same number
  float grow = smoothstep(threshold, threshold + 0.20, a.a * fits) * dry;
  // Biomes: some have no trees of the world's kind, and some colour the leaves.
  vec3 leaf = color;
  for (int i = 0; i < ${MAX_BIOMES}; i++) {
    if (i >= uBiomeCount) break;
    float w = biomeAt(i, aSite, tableXz(aSite));
    if (w <= 0.0) continue;
    grow *= 1.0 - smoothstep(0.0, 0.4, w) * (1.0 - uBiomeExtra[i].y);
    leaf = mix(leaf, uBiomePlants[i].rgb, w * uBiomePlants[i].a * aLeaf);
  }
  float size = uSize * (0.62 + 0.62 * aRand.y) * (0.78 + 0.45 * a.b) * grow;

  // Woodcutters: once the felled amount here passes this tree's turn, it topples,
  // lies a while as a log, then is hauled away leaving a stump.
  float turn = 0.04 + 0.9 * fract(aRand.x * 7.31 + aRand.y * 3.17);
  float cut = fieldD(aSite).r;
  float fall = smoothstep(turn, turn + 0.012, cut);
  float gone = smoothstep(turn + 0.05, turn + 0.06, cut);
  vec3 q = position;
  // Topple about the base (ease in, like a real fall), away from the axe.
  float tip = fall * fall * 1.5;
  float ct = cos(tip), st = sin(tip);
  q = vec3(q.x, q.y * ct - q.z * st, q.y * st + q.z * ct);
  q.y = max(q.y, 0.03 * fall);
  // Stump: the trunk cut short, the crown gone.
  vec3 stump = vec3(position.x * 1.15, min(position.y, 0.07), position.z * 1.15) * (1.0 - aLeaf);
  q = mix(q, stump, gone);

  float angle = aRand.z * 6.2832;
  float c = cos(angle), s = sin(angle);
  vec3 p = vec3(c * q.x - s * q.z, q.y, s * q.x + c * q.z) * size;
  // Wind: tops sway.
  float sway = sin(uTime * 1.7 + aRand.w * 6.28 + aSite.x * 18.0) * 0.035 + sin(uTime * 2.9 + aSite.y * 23.0) * 0.015;
  p.xz += sway * position.y * size * aLeaf * (1.0 - fall);

  vec2 xz = tableXz(aSite);
  vec3 world = vec3(xz.x, a.r * HSCALE - 0.01, xz.y) + p;
  vColor = leaf * (0.82 + 0.36 * aRand.w);
  vWorld = world;
  vTemperature = temperature;
  vRain = b.b;
  vLeaf = aLeaf;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragment = /* glsl */ `
${GLSL_COMMON}
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vLeaf;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 col = vColor;
  // Snow settles on upward faces when it is cold.
  float snow = smoothstep(uFreezing + 0.12, uFreezing - 0.05, vTemperature) * smoothstep(0.25, 0.7, n.y) * vLeaf;
  col = mix(col, vec3(0.68, 0.73, 0.82), snow * 0.85);
  float overcast = 1.0 - 0.28 * vRain;
  float shade = sunlight(vWorld, n);
  float ndl = max(dot(n, uSunDir), 0.0);
  // Leaves with the sun behind them glow through, gold-green, like light through a canopy.
  vec3 view = normalize(cameraPosition - vWorld);
  float through = (pow(max(dot(-view, uSunDir), 0.0), 3.0) * 0.8 + 0.25 * max(-dot(n, uSunDir), 0.0)) * vLeaf;
  vec3 sunlit = SUN_LIGHT * 0.85 * (ndl + through * vec3(1.0, 1.15, 0.45));
  vec3 lit = col * (sunlit * shade * overcast + SKY_LIGHT * (0.40 + 0.2 * n.y) * (0.8 + 0.2 * shade));
  gl_FragColor = vec4(lit, 1.0);
}
`;

function makeForest(
  shared: SharedUniforms, base: THREE.BufferGeometry, columns: number, rows: number, seed: number,
  range: [number, number, number], size: number,
): Sites {
  const count = columns * rows;
  const sites = new Float32Array(count * 2);
  const rand = new Float32Array(count * 4);
  let s = seed;
  const random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const k = j * columns + i;
      sites[k * 2] = Math.min(0.992, Math.max(0.008, (i + 0.1 + 0.8 * random()) / columns));
      sites[k * 2 + 1] = Math.min(0.992, Math.max(0.008, (j + 0.1 + 0.8 * random()) / rows));
      rand.set([random(), random(), random(), random()], k * 4);
    }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('color', base.getAttribute('color'));
  geometry.setAttribute('aLeaf', base.getAttribute('aLeaf'));
  geometry.setIndex(base.getIndex());
  geometry.setAttribute('aSite', new THREE.InstancedBufferAttribute(sites, 2));
  geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared, uRange: { value: new THREE.Vector3(...range) }, uSize: { value: size } },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Worth drawing only where plants beat this tree's threshold and the temperature is inside
  // its kind's band (the same two tests as `grow` and `fits` in the shader, with room to spare).
  const [coldest, hottest, fade] = range;
  return new Sites(mesh, (world, x, y, r, at) =>
    world.most('vegetation', x, y) > r[at] * GROW_SPREAD - SPARE &&
    world.most('temperature', x, y) > coldest - fade - SPARE &&
    world.least('temperature', x, y) < hottest + fade + SPARE);
}

export function makeTrees(shared: SharedUniforms): THREE.Object3D & Culled {
  // Each kind lives in a band of temperature; the bands overlap so forests mix at their edges.
  const forests = [
    makeForest(shared, conifer(), 70, 50, 11, [-0.42, -0.02, 0.12], 0.46),
    makeForest(shared, broadleaf(), 66, 47, 23, [-0.12, 0.34, 0.12], 0.44),
    makeForest(shared, jungle(), 70, 50, 37, [0.26, 2.0, 0.12], 0.50),
  ];
  const group = new THREE.Group();
  for (const forest of forests) group.add(forest.mesh);
  return together(group, forests);
}
