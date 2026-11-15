// People: little houses where they settle and fishing boats where they fish.
// Like the trees, every house and boat has a fixed site and appears or goes in
// the vertex shader from the homes / fishing textures, so nothing runs on the CPU.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LiveCard } from '../cards/store';
import { sampleField, type WorldFrame } from '../sim/world';
import { HSCALE, GLSL_COMMON, type SharedUniforms, world } from './common';
import { SPARE, Sites, together, type Culled, type SiteTest } from './sites';

// How strongly a place must call for a thing before one appears there: `base + spread x the
// site's own random number`. The shaders and the CPU tests at the bottom of this file share
// these numbers: change them here and both follow.
const HOUSE = { base: 0.3, spread: 1.5 }; // at most about 1 in 2 sites built on, so there are gardens and lanes
const PERSON = { base: 0.3, spread: 2.6 }; // at most about 1 site in 4: a village, not a crowd
const BOAT = { base: 0.2, spread: 0.75 };
const SHEEP = { base: 0.4, spread: 6.0 }; // a few small flocks
/** How much each calling counts for a person: living there, farming, woodcutting, fishing from the bank. */
const ROLE = { villager: 0.7, farmer: 0.4, logger: 0.55, angler: 0.45 };
/** Only people whose second random number is at least this fish from the bank. */
const ANGLERS = 0.6;
/** The odd farmstead out in the fields: farmland counts this much toward a house. */
const FARMSTEAD = 0.18;
/** How far boats and sheep wander from their site, and how far a person looks for water (fractions of the world's width). */
const WANDER = 0.012;
const SHORE = 0.018;
/** How much further the wind pushes a boat: this in still air, and this much more in a full gale. */
const GUST = { still: 0.008, more: 0.018 };
/** Chimneys with the fire lit: those whose fract(random x 13.7) is at most this (about two houses in five). */
const FIRES = 0.4;
const glsl = (v: number) => v.toFixed(4);

/** Parts share corners: each is worked out once by the GPU, not once per triangle that touches it. */
const weld = (parts: THREE.BufferGeometry[]) => mergeVertices(mergeGeometries(parts), 1e-5);

/** Flat colour per part. `part`: 0 = walls / hull, 1 = roof / sail (gets the per-instance tint). */
function paint(geometry: THREE.BufferGeometry, colour: [number, number, number], part: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const count = g.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  const parts = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    colours.set(colour, i * 3);
    parts[i] = part;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
  return g;
}

/** A triangular prism lying along x, apex up, base at y = 0. */
function gable(length: number, width: number, height: number): THREE.BufferGeometry {
  const r = width / Math.sqrt(3);
  return new THREE.CylinderGeometry(r, r, length, 3)
    .rotateZ(Math.PI / 2)
    .rotateX(-Math.PI / 2)
    .translate(0, r / 2, 0)
    .scale(1, height / (1.5 * r), 1);
}

/**
 * A cottage. Parts: 0 = walls (each house gets its own wash of colour), 1 = roof
 * (terracotta, slate or thatch), 2 = keeps its own colour (stone footing, door,
 * windows, chimney).
 */
function house(): THREE.BufferGeometry {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const glass: [number, number, number] = [0.20, 0.22, 0.27];
  const window = (x: number, y: number, z: number, side: boolean) => paint(side ? box(0.006, 0.03, 0.032, x, y, z) : box(0.032, 0.03, 0.006, x, y, z), glass, 2);
  return weld([
    paint(box(0.232, 0.018, 0.172, 0, 0.009, 0), [0.52, 0.49, 0.45], 2), // stone footing
    paint(box(0.22, 0.125, 0.16, 0, 0.0625 + 0.006, 0), [1, 1, 1], 0), // walls
    paint(gable(0.27, 0.215, 0.12).translate(0, 0.13, 0), [1, 1, 1], 1), // roof with eaves
    paint(box(0.036, 0.062, 0.006, -0.045, 0.031 + 0.012, 0.081), [0.36, 0.24, 0.15], 2), // door
    window(0.05, 0.08, 0.081, false),
    window(-0.05, 0.08, -0.081, false),
    window(0.05, 0.08, -0.081, false),
    window(0.111, 0.08, 0, true),
    window(-0.111, 0.08, 0, true),
    paint(box(0.034, 0.08, 0.034, 0.06, 0.2, 0.03), [0.56, 0.36, 0.28], 2), // brick chimney
    paint(box(0.044, 0.012, 0.044, 0.06, 0.246, 0.03), [0.32, 0.30, 0.29], 2), // its cap
  ]);
}

function boat(): THREE.BufferGeometry {
  const hull: [number, number, number] = [0.42, 0.27, 0.16];
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0.0, 0.05, 0, 0.0, 0.3, 0, 0.13, 0.05, 0]), 3));
  sail.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  sail.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
  return weld([
    paint(new THREE.BoxGeometry(0.24, 0.05, 0.09).translate(0, 0.01, 0), hull, 0),
    paint(new THREE.ConeGeometry(0.045, 0.07, 4).rotateZ(-Math.PI / 2).scale(1, 0.55, 1).translate(0.155, 0.012, 0), hull, 0), // bow
    paint(new THREE.CylinderGeometry(0.008, 0.008, 0.28, 4).translate(-0.005, 0.17, 0), [0.30, 0.22, 0.14], 0), // mast
    paint(sail, [1, 1, 1], 1),
    // The fisher, sitting at the stern.
    paint(new THREE.CylinderGeometry(0.016, 0.02, 0.05, 6).translate(-0.075, 0.06, 0), [0.25, 0.36, 0.55], 0),
    paint(new THREE.IcosahedronGeometry(0.017, 1).translate(-0.075, 0.1, 0), [0.93, 0.74, 0.58], 0),
    // ...holding a rod out over the side.
    paint(new THREE.CylinderGeometry(0.003, 0.003, 0.2, 4).translate(0, 0.1, 0).rotateX(1.0).translate(-0.07, 0.08, 0.01), [0.35, 0.25, 0.14], 2),
  ]);
}

/**
 * A little person. Parts: 0 clothes (tinted per instance), 1 skin, 2 tool handle, 3 tool head.
 * The tool hangs from the right shoulder, pointing forward along +x, and is swung in the shader.
 */
const SHOULDER = new THREE.Vector3(0, 0.05, 0.022);
function person(): THREE.BufferGeometry {
  const s = SHOULDER;
  return weld([
    paint(new THREE.CylinderGeometry(0.015, 0.022, 0.055, 6).translate(0, 0.0275, 0), [1, 1, 1], 0),
    paint(new THREE.IcosahedronGeometry(0.018, 1).translate(0, 0.073, 0), [1, 1, 1], 1),
    paint(new THREE.CylinderGeometry(0.0035, 0.0035, 0.07, 4).rotateZ(-Math.PI / 2).translate(s.x + 0.035, s.y, s.z), [0.45, 0.32, 0.18], 2),
    paint(new THREE.BoxGeometry(0.012, 0.022, 0.008).translate(s.x + 0.07, s.y - 0.006, s.z), [0.62, 0.64, 0.68], 3),
  ]);
}

const personVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aSite;
attribute vec4 aRand;
attribute vec3 color;
attribute float aPart;
uniform float uSize;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vRoof;

const vec3 SHOULDER = vec3(${SHOULDER.x.toFixed(3)}, ${SHOULDER.y.toFixed(3)}, ${SHOULDER.z.toFixed(3)});

vec3 rotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
// Time that moves for a while, then rests: walk, pause, walk.
float strolling(float t, float rest) { float k = floor(t); return k + smoothstep(rest, 1.0, fract(t)); }

void main() {
  vec4 c0 = fieldC(aSite);
  vec4 d0 = fieldD(aSite);
  vec4 a0 = fieldA(aSite);
  vec4 b0 = fieldB(aSite);
  vec2 wind = fieldF(aSite).rg;
  float gust = length(wind);
  vec2 windUv = vec2(wind.x, wind.y * WORLD_W / WORLD_D);
  // Is open water close by (for anglers on the bank)? Which way is it?
  vec2 e = vec2(${glsl(SHORE)}, ${glsl(SHORE)} * WORLD_W / WORLD_D);
  float wE = fieldC(aSite + vec2(e.x, 0.0)).b, wW = fieldC(aSite - vec2(e.x, 0.0)).b;
  float wN = fieldC(aSite + vec2(0.0, e.y)).b, wS = fieldC(aSite - vec2(0.0, e.y)).b;
  float shore = max(max(wE, wW), max(wN, wS)) * (1.0 - step(0.0005, b0.r - a0.r));
  vec2 toWater = vec2(wE - wW, wN - wS);

  // Each person takes the job that suits where they stand.
  float villager = c0.r * ${glsl(ROLE.villager)};
  float farmer = c0.g * ${glsl(ROLE.farmer)};
  float logger = d0.g * ${glsl(ROLE.logger)};
  float angler = shore * ${glsl(ROLE.angler)} * step(${glsl(ANGLERS)}, aRand.y);
  float best = max(max(villager, farmer), max(logger, angler));
  int role = best == angler ? 3 : best == logger ? 2 : best == farmer ? 1 : 0;

  float t = uTime + aRand.w * 97.0;
  vec2 offset = vec2(0.0);
  vec2 heading = vec2(cos(aRand.z * 6.2832), sin(aRand.z * 6.2832));
  float lean = 0.0;     // bend forward at the waist
  float swing = 0.0;    // tool angle about the shoulder (0 = pointing ahead)
  float tool = 0.0;     // 0 none, 1 hoe/axe, 2 fishing rod
  float sit = 0.0;
  float bounce = 0.0;
  if (role == 0) {
    // Stroll round a little loop, stopping now and then to stand and chat.
    float r = 0.012 + 0.018 * aRand.y;
    float u = strolling(t * (0.05 + 0.04 * aRand.z), 0.45) * 2.0;
    offset = vec2(cos(u), sin(u)) * r;
    float moving = smoothstep(0.45, 0.55, fract(t * (0.05 + 0.04 * aRand.z)));
    heading = vec2(-sin(u), cos(u));
    if (gust > 0.12) heading = normalize(mix(heading, wind, min(0.7, gust)));
    bounce = abs(sin(t * 9.0)) * 0.006 * moving;
    lean = 0.05 * sin(t * 0.7) * (1.0 - moving);
  } else if (role == 1) {
    // Work down a furrow: a few strokes of the hoe, a step, a few more.
    vec2 dir = aRand.y < 0.5 ? vec2(0.94, 0.34) : vec2(-0.34, 0.94);
    float along = strolling(t * 0.07, 0.75);
    offset = dir * (fract(along * 0.1) - 0.5) * 0.05;
    heading = dir;
    lean = 0.42;
    tool = 1.0;
    swing = -1.1 + 1.0 * pow(abs(sin(t * 2.4)), 3.0);
  } else if (role == 2) {
    // Chop: big overhead swings, a pause to catch breath.
    float work = step(0.25, fract(t * 0.08));
    float beat = fract(t * 1.1);
    swing = mix(-0.4, mix(2.1, -1.2, smoothstep(0.55, 0.7, beat)) , work);
    lean = 0.15 * work * smoothstep(0.55, 0.75, beat);
    tool = 1.0;
  } else {
    // Sit on the bank with a rod out over the water.
    if (dot(toWater, toWater) > 1e-6) heading = normalize(toWater);
    sit = 1.0;
    tool = 2.0;
    swing = 0.75 + 0.05 * sin(t * 0.9) + 0.06 * step(0.97, fract(t * 0.05)) * sin(t * 20.0);
  }

  offset += windUv * sin(uTime * 2.8 + aRand.w * 30.0) * 0.012 * gust;
  vec2 site = aSite + offset * vec2(1.0, WORLD_W / WORLD_D); // offsets are in widths of the world
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  float threshold = ${glsl(PERSON.base)} + ${glsl(PERSON.spread)} * aRand.x;
  float dry = 1.0 - smoothstep(0.0, 0.0008, b.r - a.r);
  float show = smoothstep(threshold, threshold + 0.05, best) * dry * step(0.5, b.a);
  float size = uSize * (0.85 + 0.3 * aRand.y) * show;

  vec3 q = position;
  if (aPart >= 1.5) {
    // The tool: hidden for strollers; a long thin rod for anglers.
    vec3 local = q - SHOULDER;
    if (tool > 1.5) local.x *= 3.2;
    local = rotZ(local, swing);
    q = SHOULDER + local * step(0.5, tool);
  }
  if (sit > 0.5) q.y *= 0.6;
  q = rotZ(q, -lean);
  q.xz -= wind * q.y * 0.38;

  float angle = atan(heading.y, heading.x);
  float co = cos(angle), si = sin(angle);
  vec3 p = vec3(co * q.x - si * q.z, q.y, si * q.x + co * q.z) * size;

  vec2 xz = tableXz(site);
  vec3 world = vec3(xz.x, a.r * HSCALE - 0.004 + bounce * size / uSize, xz.y) + p;
  vec3 clothes = aRand.z < 0.25 ? vec3(0.80, 0.25, 0.22) : aRand.z < 0.5 ? vec3(0.22, 0.40, 0.70)
               : aRand.z < 0.75 ? vec3(0.90, 0.72, 0.25) : vec3(0.30, 0.55, 0.32);
  vec3 skin = mix(vec3(0.96, 0.80, 0.64), vec3(0.45, 0.30, 0.20), aRand.x * aRand.x * 1.4);
  vColor = aPart < 0.5 ? clothes : aPart < 1.5 ? skin : color;
  vWorld = world;
  vTemperature = a.g;
  vRain = b.b;
  vRoof = 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const houseVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aSite;
attribute vec4 aRand;
attribute vec3 color;
attribute float aPart;
uniform float uSize;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vRoof;
void main() {
  vec4 a = fieldA(aSite);
  vec4 b = fieldB(aSite);
  vec4 c = fieldC(aSite);
  // Villages where people live, plus the odd farmstead out in the fields.
  float density = max(c.r, c.g * ${glsl(FARMSTEAD)});
  float threshold = ${glsl(HOUSE.base)} + ${glsl(HOUSE.spread)} * aRand.x;
  float dry = 1.0 - smoothstep(0.0, 0.0012, b.r - a.r);
  float grow = smoothstep(threshold, threshold + 0.08, density) * dry * step(0.5, b.a);
  float size = uSize * (0.85 + 0.3 * aRand.y) * grow;

  // Houses line up roughly with the field pattern, some turned side-on; some are long cottages.
  float angle = -0.35 + (aRand.z < 0.5 ? 0.0 : 1.5708) + (aRand.w - 0.5) * 0.25;
  float co = cos(angle), si = sin(angle);
  vec3 q = position * vec3(0.9 + 0.35 * fract(aRand.z * 7.31), 1.0, 1.0);
  vec3 p = vec3(co * q.x - si * q.z, q.y, si * q.x + co * q.z) * size;

  vec2 xz = tableXz(aSite);
  vec3 world = vec3(xz.x, a.r * HSCALE - 0.01, xz.y) + p;
  // Roofs: terracotta, slate or thatch.
  vec3 roof = aRand.w < 0.45 ? vec3(0.66, 0.27, 0.17) : aRand.w < 0.75 ? vec3(0.36, 0.38, 0.44) : vec3(0.62, 0.50, 0.28);
  // Walls: whitewash, ochre, pale stone or rose.
  float w = fract(aRand.x * 11.7);
  vec3 wash = w < 0.4 ? vec3(0.93, 0.90, 0.84) : w < 0.65 ? vec3(0.89, 0.77, 0.56) : w < 0.85 ? vec3(0.78, 0.76, 0.72) : vec3(0.88, 0.72, 0.64);
  vColor = (aPart < 0.5 ? wash : aPart < 1.5 ? roof : color) * (0.9 + 0.2 * aRand.y);
  vWorld = world;
  vTemperature = a.g;
  vRain = b.b;
  vRoof = step(0.5, aPart) * step(aPart, 1.5);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const boatVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aSite;
attribute vec4 aRand;
attribute vec3 color;
attribute float aPart;
uniform float uSize;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vRoof;
void main() {
  // Each boat drifts round a small loop near its site, stopping a while to fish.
  float u = uTime * (0.03 + 0.03 * aRand.z) + aRand.w * 9.0;
  float t = (floor(u) + smoothstep(0.5, 1.0, fract(u))) * 1.4 + aRand.w * 6.2832;
  vec2 drift = vec2(cos(t), sin(t)) * ${glsl(WANDER)};
  vec2 wind = fieldF(aSite).rg;
  float gust = length(wind);
  vec2 windUv = vec2(wind.x, wind.y * WORLD_W / WORLD_D);
  vec2 site = aSite + drift + windUv * (${glsl(GUST.still)} + ${glsl(GUST.more)} * gust) * sin(uTime * 0.35 + aRand.w * 12.0);
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  vec4 c = fieldC(site);
  float threshold = ${glsl(BOAT.base)} + ${glsl(BOAT.spread)} * aRand.x;
  float afloat = smoothstep(0.002, 0.005, b.r - a.r);
  float grow = smoothstep(threshold, threshold + 0.08, c.b) * afloat * step(0.5, b.a);
  float size = uSize * (0.8 + 0.4 * aRand.y) * grow;

  // Bow points along the direction of travel; a gentle rock on the swell.
  float angle = gust > 0.12 ? atan(wind.y, wind.x) : -t - 1.5708;
  float co = cos(angle), si = sin(angle);
  vec3 q = position;
  float roll = 0.12 * sin(uTime * 1.9 + aRand.w * 20.0);
  q.y += q.z * roll;
  vec3 p = vec3(co * q.x - si * q.z, q.y, si * q.x + co * q.z) * size;

  vec2 xz = tableXz(site);
  float bob = 0.008 * sin(uTime * 1.6 + aRand.y * 30.0);
  vec3 world = vec3(xz.x, b.r * HSCALE + bob, xz.y) + p;
  vec3 sail = aRand.w < 0.6 ? vec3(0.95, 0.93, 0.88) : vec3(0.85, 0.42, 0.30);
  vColor = aPart > 0.5 && aPart < 1.5 ? sail : color;
  vWorld = world;
  vTemperature = a.g;
  vRain = b.b;
  vRoof = 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragment = /* glsl */ `
${GLSL_COMMON}
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vRoof;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (!gl_FrontFacing) n = -n;
  vec3 col = vColor;
  // Snow on the roofs when it is cold.
  float snow = smoothstep(uFreezing + 0.12, uFreezing - 0.05, vTemperature) * smoothstep(0.25, 0.7, n.y) * vRoof;
  col = mix(col, vec3(0.72, 0.76, 0.84), snow * 0.85);
  float overcast = 1.0 - 0.28 * vRain;
  float shade = sunlight(vWorld, n);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 lit = col * (SUN_LIGHT * 0.85 * ndl * shade * overcast + SKY_LIGHT * (0.42 + 0.2 * abs(n.y)) * (0.8 + 0.2 * shade) + BOUNCE_LIGHT * max(-n.y, 0.0) * 2.0);
  gl_FragColor = vec4(lit, 1.0);
}
`;

const merchantVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec3 color;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vRoof;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vec2 site = tableUv(worldPosition.xz);
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  vColor = color;
  vWorld = worldPosition.xyz;
  vTemperature = a.g;
  vRain = b.b;
  vRoof = 0.0;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

function merchantBody(): THREE.BufferGeometry {
  const horse: [number, number, number] = [0.43, 0.25, 0.13];
  const harness: [number, number, number] = [0.22, 0.16, 0.10];
  const wood: [number, number, number] = [0.40, 0.23, 0.11];
  const clothes: [number, number, number] = [0.27, 0.36, 0.58];
  return mergeGeometries([
    paint(new THREE.SphereGeometry(1, 8, 6).scale(0.075, 0.04, 0.035).translate(0.075, 0.12, 0), horse, 0),
    paint(new THREE.BoxGeometry(0.045, 0.095, 0.036).rotateZ(-0.45).translate(0.13, 0.16, 0), horse, 0),
    paint(new THREE.SphereGeometry(1, 7, 5).scale(0.031, 0.023, 0.025).translate(0.166, 0.207, 0), horse, 0),
    paint(new THREE.ConeGeometry(0.009, 0.025, 5).translate(0.15, 0.235, -0.012), horse, 0),
    paint(new THREE.ConeGeometry(0.009, 0.025, 5).translate(0.15, 0.235, 0.012), horse, 0),
    ...[0.035, 0.115].flatMap((x) =>
      [-0.022, 0.022].map((z) =>
        paint(new THREE.CylinderGeometry(0.006, 0.008, 0.07, 5).translate(x, 0.04, z), horse, 0),
      ),
    ),
    paint(new THREE.BoxGeometry(0.14, 0.065, 0.11).translate(-0.09, 0.12, 0), wood, 0),
    paint(new THREE.BoxGeometry(0.16, 0.012, 0.125).translate(-0.09, 0.158, 0), wood, 0),
    ...[-1, 1].map((side) =>
      paint(new THREE.BoxGeometry(0.12, 0.006, 0.008).translate(-0.015, 0.09, side * 0.04), harness, 0),
    ),
    paint(new THREE.BoxGeometry(0.025, 0.045, 0.025).translate(-0.09, 0.195, 0), clothes, 0),
    paint(new THREE.SphereGeometry(0.014, 6, 5).translate(-0.09, 0.226, 0), [0.72, 0.52, 0.35], 0),
  ]);
}

function merchantWheel(): THREE.BufferGeometry {
  const spokes = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4].map((angle) =>
    paint(new THREE.BoxGeometry(0.064, 0.004, 0.008).rotateZ(angle), [0.24, 0.15, 0.08], 0),
  );
  return mergeGeometries([
    paint(new THREE.TorusGeometry(0.034, 0.006, 4, 10), [0.24, 0.15, 0.08], 0),
    ...spokes,
  ]);
}

const MERCHANT_SPEED = 0.32;

export interface TradeRoute {
  key: string;
  from: LiveCard;
  to: LiveCard;
}

/** Connect every settlement to the nearest already-connected settlement. */
export function tradeRoutes(cards: readonly LiveCard[]): TradeRoute[] {
  const settlements = cards.filter((card) => card.def.id === 'settlement' && card.strength > 0.15);
  if (settlements.length < 2) return [];

  const connected = new Set([0]);
  const routes: TradeRoute[] = [];
  while (connected.size < settlements.length) {
    let best: { from: number; to: number; distance: number } | undefined;
    for (const from of connected) {
      for (let to = 0; to < settlements.length; to++) {
        if (connected.has(to)) continue;
        const dx = settlements[to].x - settlements[from].x;
        const dy = (settlements[to].y - settlements[from].y) / world.aspect;
        const distance = Math.hypot(dx, dy);
        if (distance < 0.001) continue;
        if (!best || distance < best.distance) best = { from, to, distance };
      }
    }
    if (!best) break;
    const from = settlements[best.from];
    const to = settlements[best.to];
    const key = [from.key, to.key].sort().join(':');
    routes.push({ key, from, to });
    connected.add(best.to);
  }
  return routes;
}

interface Convoy {
  group: THREE.Group;
  wheels: THREE.Group[];
}

function makeConvoy(body: THREE.BufferGeometry, wheel: THREE.BufferGeometry, material: THREE.ShaderMaterial): Convoy {
  const group = new THREE.Group();
  const bodyMesh = new THREE.Mesh(body, material);
  bodyMesh.frustumCulled = false;
  group.add(bodyMesh);
  const wheels = [-1, 1].map((side) => {
    const axle = new THREE.Group();
    axle.position.set(-0.09, 0.045, side * 0.069);
    const mesh = new THREE.Mesh(wheel, material);
    mesh.frustumCulled = false;
    axle.add(mesh);
    group.add(axle);
    return axle;
  });
  return { group, wheels };
}

/** Tiny horse-drawn carts linking the active SETTLEMENT cards. */
export class Merchants {
  readonly group = new THREE.Group();
  private body = merchantBody();
  private wheel = merchantWheel();
  private material: THREE.ShaderMaterial;
  private convoys = new Map<string, Convoy>();

  constructor(shared: SharedUniforms) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared },
      vertexShader: merchantVertex,
      fragmentShader: fragment,
      side: THREE.DoubleSide,
    });
  }

  update(cards: LiveCard[], frame: WorldFrame, time: number): void {
    const routes = tradeRoutes(cards);
    const seen = new Set<string>();
    for (const route of routes) {
      seen.add(route.key);
      let convoy = this.convoys.get(route.key);
      if (!convoy) {
        convoy = makeConvoy(this.body, this.wheel, this.material);
        this.convoys.set(route.key, convoy);
        this.group.add(convoy.group);
      }

      const dx = (route.to.x - route.from.x) * world.w;
      const dz = (route.to.y - route.from.y) * world.d;
      const distance = Math.hypot(dx, dz);
      let hash = 0;
      for (const char of route.key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
      const offset = ((hash >>> 0) % 1000) / 1000 * 2;
      const midX = (route.from.x + route.to.x) * 0.5;
      const midY = (route.from.y + route.to.y) * 0.5;
      const tailwind =
        (sampleField(frame.windX, frame.w, frame.h, midX, midY) * dx +
          sampleField(frame.windY, frame.w, frame.h, midX, midY) * dz) /
        distance;
      const speed = MERCHANT_SPEED * (1 + 0.7 * tailwind);
      const phase = ((time * speed) / distance + offset) % 2;
      const forward = phase <= 1;
      const progress = forward ? phase : 2 - phase;
      const x = route.from.x + (route.to.x - route.from.x) * progress;
      const y = route.from.y + (route.to.y - route.from.y) * progress;
      const ground = Math.max(
        sampleField(frame.height, frame.w, frame.h, x, y),
        sampleField(frame.waterSurface, frame.w, frame.h, x, y),
      ) * HSCALE;

      convoy.group.position.set((x - 0.5) * world.w, ground + Math.abs(Math.sin(time * 8 + offset)) * 0.003, (y - 0.5) * world.d);
      convoy.group.rotation.y = Math.atan2(forward ? -dz : dz, forward ? dx : -dx);
      convoy.group.rotation.z = Math.sin(time * 8 + offset) * 0.012;
      const wheelTurn = (time * speed * (forward ? 1 : -1)) / 0.034;
      for (const axle of convoy.wheels) axle.rotation.z = wheelTurn + offset;
    }

    for (const [key, convoy] of this.convoys) {
      if (seen.has(key)) continue;
      this.group.remove(convoy.group);
      this.convoys.delete(key);
    }
  }
}

/** Five wisps of chimney smoke per house (part = which wisp). Same sites as the houses. */
const WISPS = 5;
function smoke(): THREE.BufferGeometry {
  return weld(Array.from({ length: WISPS }, (_, k) => paint(new THREE.IcosahedronGeometry(1, 1), [1, 1, 1], k)));
}

const smokeVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aSite;
attribute vec4 aRand;
attribute float aPart;
uniform float uSize;
varying float vAlpha;
varying float vLife;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  // The same house as houseVertex at this site (keep the two in step).
  vec4 a = fieldA(aSite);
  vec4 b = fieldB(aSite);
  vec4 c = fieldC(aSite);
  float density = max(c.r, c.g * ${glsl(FARMSTEAD)});
  float threshold = ${glsl(HOUSE.base)} + ${glsl(HOUSE.spread)} * aRand.x;
  float dry = 1.0 - smoothstep(0.0, 0.0012, b.r - a.r);
  float grow = smoothstep(threshold, threshold + 0.08, density) * dry * step(0.5, b.a);
  float size = uSize * (0.85 + 0.3 * aRand.y) * grow;
  float angle = -0.35 + (aRand.z < 0.5 ? 0.0 : 1.5708) + (aRand.w - 0.5) * 0.25;
  float co = cos(angle), si = sin(angle);
  vec3 chimney = vec3(0.06 * (0.9 + 0.35 * fract(aRand.z * 7.31)), 0.255, 0.03);
  chimney = vec3(co * chimney.x - si * chimney.z, chimney.y, si * chimney.x + co * chimney.z) * size;
  // About two houses in five have the fire lit. Wisps leave the chimney thin and dark, then
  // rise, swell, pale and bend with the wind, curling a little as they go.
  float lit = step(fract(aRand.y * 13.7), ${glsl(FIRES)}) * step(0.01, size);
  float life = fract(uTime * 0.07 + aPart / ${WISPS}.0 + aRand.y * 5.0);
  float curl = sin(uTime * 0.6 + aRand.x * 9.0 + life * 5.0);
  vec2 wind = fieldF(aSite).rg;
  vec3 rise = vec3(0.025 * curl * life, 0.42 * life, 0.02 * cos(uTime * 0.5 + aRand.z * 7.0) * life);
  // A gentle drift even in still air; the wind bends it further the higher it rises.
  rise.xz += vec2(0.06, 0.02) * life + wind * (0.12 * life + 0.3 * life * life);
  float puff = (0.006 + 0.05 * life) * lit;
  vec2 xz = tableXz(aSite);
  vec3 world = vec3(xz.x, a.r * HSCALE - 0.01, xz.y) + chimney + rise * uSize + position * puff * uSize;
  vAlpha = smoothstep(0.0, 0.08, life) * pow(1.0 - life, 1.5) * 0.42 * lit;
  vLife = life;
  vNormal = position;
  vWorld = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const smokeFragment = /* glsl */ `
${GLSL_COMMON}
varying float vAlpha;
varying float vLife;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  // Feathered edges: a wisp is thick in the middle and fades to nothing at its rim.
  float facing = abs(dot(n, normalize(cameraPosition - vWorld)));
  float soft = smoothstep(0.05, 0.85, facing);
  float light = 0.78 + 0.3 * max(dot(n, uSunDir), 0.0);
  vec3 col = mix(vec3(0.42, 0.41, 0.42), vec3(0.88, 0.89, 0.92), smoothstep(0.0, 0.45, vLife));
  gl_FragColor = vec4(col * light, vAlpha * soft);
}
`;

/** A sheep: woolly body (part 0) and dark face (part 1). */
function sheep(): THREE.BufferGeometry {
  return weld([
    paint(new THREE.IcosahedronGeometry(0.03, 1).scale(1.35, 0.9, 1.0).translate(0, 0.04, 0), [0.93, 0.92, 0.88], 0),
    paint(new THREE.BoxGeometry(0.022, 0.022, 0.02).translate(0.045, 0.05, 0), [0.18, 0.16, 0.15], 1),
    ...[[-0.022, -0.012], [-0.022, 0.012], [0.022, -0.012], [0.022, 0.012]].map(([x, z]) =>
      paint(new THREE.CylinderGeometry(0.004, 0.004, 0.025, 4).translate(x, 0.0125, z), [0.18, 0.16, 0.15], 0)),
  ]);
}

const sheepVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aSite;
attribute vec4 aRand;
attribute vec3 color;
attribute float aPart;
uniform float uSize;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
varying float vRoof;
void main() {
  // Graze slowly in the fields at the edge of the village: amble, stop, crop the grass.
  float t = uTime * (0.02 + 0.02 * aRand.z) + aRand.w * 40.0;
  float u = floor(t) + smoothstep(0.6, 1.0, fract(t));
  vec2 heading = vec2(cos(u * 2.1 + aRand.y * 6.28), sin(u * 2.1 + aRand.y * 6.28));
  vec2 site = aSite + vec2(cos(u * 1.3), sin(u * 1.7)) * ${glsl(WANDER)} * vec2(1.0, WORLD_W / WORLD_D);
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  vec4 c = fieldC(site);
  float pasture = c.g * (1.0 - smoothstep(0.2, 0.5, c.r)) * smoothstep(0.3, 0.6, a.b);
  float threshold = ${glsl(SHEEP.base)} + ${glsl(SHEEP.spread)} * aRand.x;
  float dry = 1.0 - smoothstep(0.0, 0.0008, b.r - a.r);
  float size = uSize * (0.85 + 0.3 * aRand.y) * smoothstep(threshold, threshold + 0.05, pasture) * dry * step(0.5, b.a);
  vec3 q = position;
  // Head down to graze while standing still.
  float grazing = 1.0 - smoothstep(0.6, 0.65, fract(t)) + smoothstep(0.95, 1.0, fract(t));
  if (aPart > 0.5) q.y -= 0.025 * grazing * (0.7 + 0.3 * sin(uTime * 3.0 + aRand.x * 20.0));
  float angle = atan(heading.y, heading.x);
  float co = cos(angle), si = sin(angle);
  vec3 p = vec3(co * q.x - si * q.z, q.y, si * q.x + co * q.z) * size;
  vec2 xz = tableXz(site);
  vec3 world = vec3(xz.x, a.r * HSCALE - 0.004, xz.y) + p;
  vColor = color;
  vWorld = world;
  vTemperature = a.g;
  vRain = b.b;
  vRoof = 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

function makeSites(
  shared: SharedUniforms, base: THREE.BufferGeometry, vertex: string, columns: number, rows: number, seed: number, size: number,
  test: SiteTest, frag = fragment, transparent = false, jitter = 0.9,
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
      sites[k * 2] = Math.min(0.99, Math.max(0.01, (i + 0.5 + jitter * (random() - 0.5)) / columns));
      sites[k * 2 + 1] = Math.min(0.99, Math.max(0.01, (j + 0.5 + jitter * (random() - 0.5)) / rows));
      rand.set([random(), random(), random(), random()], k * 4);
    }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('color', base.getAttribute('color'));
  geometry.setAttribute('aPart', base.getAttribute('aPart'));
  geometry.setIndex(base.getIndex());
  geometry.setAttribute('aSite', new THREE.InstancedBufferAttribute(sites, 2));
  geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared, uSize: { value: size } },
    vertexShader: vertex,
    fragmentShader: frag,
    side: THREE.DoubleSide,
    transparent,
    depthWrite: !transparent,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  if (transparent) mesh.renderOrder = 5;
  return new Sites(mesh, test);
}

// --- which sites are worth drawing --------------------------------------------------------
// Each test mirrors the `threshold` line of its shader, with the largest value the shader could
// read there. It may keep a site the shader then hides (under water, say); it must never drop
// one the shader would show. `r[at]`, `r[at + 1]` are the site's aRand.x and aRand.y.

const houseStands: SiteTest = (world, x, y, r, at) =>
  Math.max(world.most('homes', x, y), world.most('farms', x, y) * FARMSTEAD) > HOUSE.base + HOUSE.spread * r[at] - SPARE;

const fireLit: SiteTest = (world, x, y, r, at) => {
  const turn = r[at + 1] * 13.7;
  return turn - Math.floor(turn) <= FIRES + 0.001 && houseStands(world, x, y, r, at);
};

const sheepGrazes: SiteTest = (world, x, y, r, at) => world.most('farms', x, y, WANDER) > SHEEP.base + SHEEP.spread * r[at] - SPARE;

const boatSails: SiteTest = (world, x, y, r, at) => world.most('fishing', x, y, WANDER + GUST.still + GUST.more) > BOAT.base + BOAT.spread * r[at] - SPARE;

const personWorks: SiteTest = (world, x, y, r, at) => {
  const needs = PERSON.base + PERSON.spread * r[at] - SPARE;
  return (
    world.most('homes', x, y) * ROLE.villager > needs ||
    world.most('farms', x, y) * ROLE.farmer > needs ||
    world.most('logging', x, y) * ROLE.logger > needs ||
    (r[at + 1] >= ANGLERS - 0.001 && world.most('fishing', x, y, SHORE) * ROLE.angler > needs)
  );
};

export function makePeople(shared: SharedUniforms): THREE.Object3D & Culled {
  const kinds = [
    // Houses and their chimney smoke share sites (same grid and seed), so the smoke finds its chimney.
    // A coarse grid with little jitter: each house has its own plot, so they never pile into each other.
    makeSites(shared, house(), houseVertex, 44, 31, 71, 0.72, houseStands, fragment, false, 0.45),
    makeSites(shared, smoke(), smokeVertex, 44, 31, 71, 0.72, fireLit, smokeFragment, true, 0.45),
    makeSites(shared, sheep(), sheepVertex, 70, 50, 113, 1.1, sheepGrazes),
    makeSites(shared, boat(), boatVertex, 40, 28, 83, 0.62, boatSails),
    makeSites(shared, person(), personVertex, 64, 45, 97, 1.25, personWorks),
  ];
  const group = new THREE.Group();
  for (const kind of kinds) group.add(kind.mesh);
  return together(group, kinds);
}
