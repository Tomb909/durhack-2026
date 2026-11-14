// People: little houses where they settle and fishing boats where they fish.
// Like the trees, every house and boat has a fixed site and appears or goes in
// the vertex shader from the homes / fishing textures, so nothing runs on the CPU.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLSL_COMMON, type SharedUniforms } from './common';

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

function house(): THREE.BufferGeometry {
  const walls: [number, number, number] = [0.88, 0.82, 0.70];
  return mergeGeometries([
    paint(new THREE.BoxGeometry(0.22, 0.13, 0.16).translate(0, 0.065, 0), walls, 0),
    paint(gable(0.26, 0.21, 0.11).translate(0, 0.13, 0), [1, 1, 1], 1),
    paint(new THREE.BoxGeometry(0.035, 0.07, 0.035).translate(0.06, 0.2, 0.03), [0.45, 0.40, 0.36], 0), // chimney
  ]);
}

function boat(): THREE.BufferGeometry {
  const hull: [number, number, number] = [0.42, 0.27, 0.16];
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0.0, 0.05, 0, 0.0, 0.3, 0, 0.13, 0.05, 0]), 3));
  sail.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  sail.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
  return mergeGeometries([
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
  return mergeGeometries([
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
  // Is open water close by (for anglers on the bank)? Which way is it?
  vec2 e = vec2(0.018, 0.018 * WORLD_W / WORLD_D);
  float wE = fieldC(aSite + vec2(e.x, 0.0)).b, wW = fieldC(aSite - vec2(e.x, 0.0)).b;
  float wN = fieldC(aSite + vec2(0.0, e.y)).b, wS = fieldC(aSite - vec2(0.0, e.y)).b;
  float shore = max(max(wE, wW), max(wN, wS)) * (1.0 - step(0.0005, b0.r - a0.r));
  vec2 toWater = vec2(wE - wW, wN - wS);

  // Each person takes the job that suits where they stand.
  float villager = c0.r * 0.7;
  float farmer = c0.g * 0.4;
  float logger = d0.g * 0.55;
  float angler = shore * 0.45 * step(0.6, aRand.y);
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

  vec2 site = aSite + offset * vec2(1.0, WORLD_W / WORLD_D); // offsets are in widths of the world
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  float threshold = 0.2 + 1.0 * aRand.x;
  float dry = 1.0 - smoothstep(0.0, 0.0008, b.r - a.r);
  // People flee wrecked ground (they come back as it is rebuilt).
  float show = smoothstep(threshold, threshold + 0.05, best) * dry * step(0.5, b.a) * (1.0 - smoothstep(0.05, 0.3, fieldD(site).b));
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
  float density = max(c.r, c.g * 0.18);
  float threshold = 0.25 + 1.2 * aRand.x; // at most about 6 in 10 sites built on
  float dry = 1.0 - smoothstep(0.0, 0.0012, b.r - a.r);
  float grow = smoothstep(threshold, threshold + 0.08, density) * dry * step(0.5, b.a);
  float size = uSize * (0.8 + 0.45 * aRand.y) * grow;
  // Wrecked by an event: roof gone, walls broken down, blackened if burnt.
  vec4 ev = fieldD(aSite);
  float ruin = smoothstep(0.15 + 0.6 * aRand.x, 0.22 + 0.6 * aRand.x, ev.b);
  vec3 q = position;
  q *= 1.0 - ruin * step(0.5, aPart);
  q.y *= 1.0 - 0.6 * ruin;

  // Houses line up roughly with the field pattern, some turned side-on.
  float angle = -0.35 + (aRand.z < 0.5 ? 0.0 : 1.5708) + (aRand.w - 0.5) * 0.25;
  float co = cos(angle), si = sin(angle);
  vec3 p = vec3(co * q.x - si * q.z, q.y, si * q.x + co * q.z) * size;

  vec2 xz = tableXz(aSite);
  vec3 world = vec3(xz.x, a.r * HSCALE - 0.01, xz.y) + p;
  // Roofs: terracotta, slate or thatch.
  vec3 roof = aRand.w < 0.45 ? vec3(0.66, 0.27, 0.17) : aRand.w < 0.75 ? vec3(0.36, 0.38, 0.44) : vec3(0.62, 0.50, 0.28);
  vColor = mix(color, roof, aPart) * (0.88 + 0.24 * aRand.y) * (1.0 - 0.35 * ruin) * (1.0 - 0.75 * ev.a);
  vWorld = world;
  vTemperature = a.g;
  vRain = b.b;
  vRoof = aPart;
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
  vec2 drift = vec2(cos(t), sin(t)) * 0.012;
  vec2 site = aSite + drift;
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  vec4 c = fieldC(site);
  float threshold = 0.2 + 0.75 * aRand.x;
  float afloat = smoothstep(0.002, 0.005, b.r - a.r);
  float grow = smoothstep(threshold, threshold + 0.08, c.b) * afloat * step(0.5, b.a) * (1.0 - smoothstep(0.1, 0.4, fieldD(site).b));
  float size = uSize * (0.8 + 0.4 * aRand.y) * grow;

  // Bow points along the direction of travel; a gentle rock on the swell.
  float angle = -t - 1.5708;
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
  float overcast = 1.0 - 0.38 * vRain;
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 lit = col * (vec3(1.0, 0.94, 0.84) * 1.45 * ndl * overcast + vec3(0.50, 0.62, 0.85) * (0.42 + 0.2 * abs(n.y)));
  gl_FragColor = vec4(lit, 1.0);
}
`;

/** Three puffs of chimney smoke per house (part = which puff). Same sites as the houses. */
function smoke(): THREE.BufferGeometry {
  return mergeGeometries([0, 1, 2].map((k) => paint(new THREE.IcosahedronGeometry(0.03, 1), [1, 1, 1], k)));
}

const smokeVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aSite;
attribute vec4 aRand;
attribute float aPart;
uniform float uSize;
varying float vAlpha;
varying float vDark;
varying vec3 vWorld;
void main() {
  // The same house as houseVertex at this site (keep the two in step).
  vec4 a = fieldA(aSite);
  vec4 b = fieldB(aSite);
  vec4 c = fieldC(aSite);
  float density = max(c.r, c.g * 0.18);
  float threshold = 0.25 + 1.2 * aRand.x;
  float dry = 1.0 - smoothstep(0.0, 0.0012, b.r - a.r);
  float grow = smoothstep(threshold, threshold + 0.08, density) * dry * step(0.5, b.a);
  float size = uSize * (0.8 + 0.45 * aRand.y) * grow;
  float angle = -0.35 + (aRand.z < 0.5 ? 0.0 : 1.5708) + (aRand.w - 0.5) * 0.25;
  float co = cos(angle), si = sin(angle);
  vec3 chimney = mix(vec3(0.06, 0.24, 0.03), vec3(0.0, 0.08, 0.0), ruin);
  chimney = vec3(co * chimney.x - si * chimney.z, chimney.y, si * chimney.x + co * chimney.z) * size;
  // About half the houses have the fire lit. Puffs rise, swell and fade, drifting downwind.
  vec4 ev = fieldD(aSite);
  float ruin = smoothstep(0.15 + 0.6 * aRand.x, 0.22 + 0.6 * aRand.x, ev.b);
  // Hearth smoke from half the homes; ruins smoulder, dark, where the ground burnt.
  float lit = max(step(fract(aRand.y * 13.7), 0.5) * (1.0 - ruin), ruin * step(0.2, ev.a)) * step(0.01, size);
  vDark = ruin * step(0.2, ev.a);
  float life = fract(uTime * 0.09 + aPart / 3.0 + aRand.y * 5.0);
  vec3 rise = vec3(0.10 * life + 0.02 * sin(uTime * 0.8 + aRand.x * 9.0 + life * 4.0), 0.32 * life, 0.04 * life);
  float puff = (0.45 + 1.6 * life) * lit;
  vec2 xz = tableXz(aSite);
  vec3 world = vec3(xz.x, a.r * HSCALE - 0.01, xz.y) + chimney + rise * uSize + position * puff * uSize;
  vAlpha = smoothstep(0.0, 0.12, life) * (1.0 - life) * 0.55 * lit;
  vWorld = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const smokeFragment = /* glsl */ `
${GLSL_COMMON}
varying float vAlpha;
varying float vDark;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float light = 0.8 + 0.25 * max(dot(n, uSunDir), 0.0);
  gl_FragColor = vec4(mix(vec3(0.86, 0.87, 0.9), vec3(0.16, 0.15, 0.15), vDark) * light, vAlpha);
}
`;

/** A sheep: woolly body (part 0) and dark face (part 1). */
function sheep(): THREE.BufferGeometry {
  return mergeGeometries([
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
  vec2 site = aSite + vec2(cos(u * 1.3), sin(u * 1.7)) * 0.012 * vec2(1.0, WORLD_W / WORLD_D);
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  vec4 c = fieldC(site);
  float pasture = c.g * (1.0 - smoothstep(0.2, 0.5, c.r)) * smoothstep(0.3, 0.6, a.b);
  float threshold = 0.4 + 2.4 * aRand.x;
  float dry = 1.0 - smoothstep(0.0, 0.0008, b.r - a.r);
  float size = uSize * (0.85 + 0.3 * aRand.y) * smoothstep(threshold, threshold + 0.05, pasture) * dry * step(0.5, b.a) * (1.0 - smoothstep(0.05, 0.3, fieldD(site).b));
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
  frag = fragment, transparent = false,
): THREE.Mesh {
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
      sites[k * 2] = Math.min(0.99, Math.max(0.01, (i + 0.05 + 0.9 * random()) / columns));
      sites[k * 2 + 1] = Math.min(0.99, Math.max(0.01, (j + 0.05 + 0.9 * random()) / rows));
      rand.set([random(), random(), random(), random()], k * 4);
    }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('color', base.getAttribute('color'));
  geometry.setAttribute('aPart', base.getAttribute('aPart'));
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
  return mesh;
}

export function makePeople(shared: SharedUniforms): THREE.Group {
  const group = new THREE.Group();
  // Houses and their chimney smoke share sites (same grid and seed), so the smoke finds its chimney.
  group.add(makeSites(shared, house(), houseVertex, 62, 44, 71, 0.75));
  group.add(makeSites(shared, smoke(), smokeVertex, 62, 44, 71, 0.75, smokeFragment, true));
  group.add(makeSites(shared, sheep(), sheepVertex, 70, 50, 113, 1.1));
  group.add(makeSites(shared, boat(), boatVertex, 40, 28, 83, 0.62));
  group.add(makeSites(shared, person(), personVertex, 90, 64, 97, 1.25));
  return group;
}
