// The cut sides of the world: a deep section through the ground (soil, bedded rock,
// bedrock, and molten cracks far below, fading into the dark) and water in cross-section.
import * as THREE from 'three';
import { DOME_RADIUS, GLSL_VOID } from './backdrop';
import { GLSL_COMMON, world, type SharedUniforms } from './common';

/** The bottom of the world is this much narrower than the top. */
const TAPER = 0.86;

/** Corners sharper than this get a crease (separate normals) instead of a smooth turn. */
const CREASE_COS = Math.cos((35 * Math.PI) / 180);

/**
 * A ribbon of quads round the play area's outline, inset about half a cell so the
 * terrain's edge sits just over its top. Each column has a top and a bottom vertex.
 */
function makeEdgeGeometry(outline: number[][], gw: number): THREE.BufferGeometry {
  const W = world.w;
  const D = world.d;
  const cell = W / (gw - 1);
  const inset = 0.5 * cell;
  // Outline in world units (x right, z near), without repeated points.
  const pts: [number, number][] = [];
  for (const [u, v] of outline) {
    const p: [number, number] = [u * W, v * D];
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) pts.push(p);
  }
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
  const m = pts.length;
  let area = 0;
  for (let i = 0; i < m; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % m];
    area += x0 * z1 - x1 * z0;
  }
  // Outward normal of edge i (from pts[i] to pts[i+1]).
  const edgeNormal = (i: number): [number, number] => {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % m];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    return area < 0 ? [-dz / len, dx / len] : [dz / len, -dx / len];
  };
  const normals = pts.map((_, i) => edgeNormal(i));
  // Inset each vertex along the mitre of its two edges; smooth its normal unless it is a crease.
  const inner: [number, number][] = [];
  const smooth: ([number, number] | null)[] = [];
  for (let i = 0; i < m; i++) {
    const a = normals[(i + m - 1) % m];
    const b = normals[i];
    const dot = a[0] * b[0] + a[1] * b[1];
    const k = Math.min(2, 1 / Math.max(0.25, 1 + dot));
    inner.push([pts[i][0] - (a[0] + b[0]) * k * inset, pts[i][1] - (a[1] + b[1]) * k * inset]);
    const sx = a[0] + b[0];
    const sz = a[1] + b[1];
    const sl = Math.hypot(sx, sz) || 1;
    smooth.push(dot >= CREASE_COS ? [sx / sl, sz / sl] : null);
  }

  const uvs: number[] = [];
  const tops: number[] = [];
  const normalData: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  let distance = 0;
  for (let e = 0; e < m; e++) {
    const f = (e + 1) % m;
    const [x0, z0] = inner[e];
    const [x1, z1] = inner[f];
    const length = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(length / cell));
    const n0 = smooth[e] ?? normals[e];
    const n1 = smooth[f] ?? normals[e];
    const start = uvs.length / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      let nx = n0[0] + (n1[0] - n0[0]) * t;
      let nz = n0[1] + (n1[1] - n0[1]) * t;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      for (const top of [1, 0]) {
        uvs.push(x / W, z / D);
        tops.push(top);
        normalData.push(nx, 0, nz);
        along.push(distance + t * length);
      }
    }
    for (let i = 0; i < steps; i++) {
      const a = start + i * 2;
      index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    distance += length;
  }
  const geometry = new THREE.BufferGeometry();
  const count = uvs.length / 2;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('aTop', new THREE.BufferAttribute(new Float32Array(tops), 1));
  geometry.setAttribute('aAlong', new THREE.BufferAttribute(new Float32Array(along), 1));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normalData), 3));
  geometry.setIndex(index);
  return geometry;
}

const earthVertex = /* glsl */ `
${GLSL_COMMON}
const float TAPER = ${TAPER.toFixed(3)};
attribute vec2 aUv;
attribute float aTop;
attribute float aAlong;
varying float vY;
varying float vTopY;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec4 a = fieldA(aUv);
  float top = (a.r - 0.004 * fieldB(aUv).g) * HSCALE;
  float y = mix(SLAB_BOTTOM, top, aTop);
  // The ground narrows a little with depth, like a root: the walls lean in under the surface.
  vec2 xz = tableXz(aUv) * mix(TAPER, 1.0, aTop);
  vY = y;
  vTopY = top;
  vAlong = aAlong;
  vNormal = normal;
  vWorld = vec3(xz.x, y, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const earthFragment = /* glsl */ `
${GLSL_COMMON}
const float DOME = ${DOME_RADIUS.toFixed(1)};
varying float vY;
varying float vTopY;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vWorld;
${GLSL_VOID}

// One family of rock beds: each bed gets its own shade, with a darker seam between beds.
vec3 beds(float layer, float seed, vec3 lo, vec3 hi, vec3 odd) {
  float band = fract(layer);
  float pick = hash21(vec2(floor(layer), seed));
  vec3 c = mix(lo, hi, pick);
  c = mix(c, odd, step(0.7, pick));
  return c * (0.86 + 0.14 * smoothstep(0.0, 0.12, band) * smoothstep(1.0, 0.85, band));
}

void main() {
  // Ragged underside, far below.
  float bottom = SLAB_BOTTOM + 0.1 + 0.9 * fbm2(vec2(vAlong * 1.7, 3.0));
  if (vY < bottom) discard;

  float below = vTopY - vY; // how far under the surface
  float wobble = fbm2(vec2(vAlong * 0.9, vY * 1.5));

  // Near the surface: thin, warm beds of sediment. Deeper: thick, cold bedrock.
  vec3 upper = beds(vY * 2.6 + wobble * 0.9, 7.0, vec3(0.26, 0.16, 0.10), vec3(0.40, 0.26, 0.16), vec3(0.22, 0.20, 0.20));
  vec3 lower = beds(vY * 0.8 + wobble * 1.4 + 0.37, 3.0, vec3(0.115, 0.11, 0.125), vec3(0.20, 0.185, 0.195), vec3(0.16, 0.12, 0.10));
  vec3 rock = mix(upper, lower, smoothstep(1.3, 3.0, below + wobble * 0.9));
  rock *= 0.9 + 0.2 * vnoise(vec2(vAlong * 30.0, vY * 30.0));

  vec3 soil = vec3(0.13, 0.085, 0.05);
  vec3 col = mix(soil, rock, smoothstep(0.05, 0.16, below + wobble * 0.05));

  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  // Less daylight reaches the depths.
  float daylight = mix(1.0, 0.42, smoothstep(0.4, 5.0, below));
  vec3 lit = col * (vec3(1.0, 0.93, 0.80) * 1.2 * ndl + vec3(0.50, 0.62, 0.85) * 0.36) * daylight;

  // Far down the rock is hot: molten seams run through it and the whole face glows faintly.
  float heat = smoothstep(4.2, 7.2, below);
  float seam = fbm2(vec2(vAlong * 1.25, vY * 1.05 + 5.0));
  float crack = smoothstep(0.03, 0.0, abs(seam - 0.47)) + 0.5 * smoothstep(0.02, 0.0, abs(fbm2(vec2(vAlong * 3.1 + 9.0, vY * 2.7)) - 0.5));
  float pulse = 0.75 + 0.25 * sin(uTime * 0.7 + vAlong * 1.9 + vY * 1.3);
  lit += vec3(2.0, 0.56, 0.11) * crack * heat * pulse;
  lit += vec3(0.50, 0.12, 0.03) * heat * heat * 0.22;

  // And at the very bottom it is lost in the void: it takes exactly the colour of the sky behind it,
  // so there is no underside and no edge to see.
  vec3 dir = normalize(vWorld - cameraPosition);
  float along = dot(cameraPosition, dir);
  float reach = -along + sqrt(max(along * along - dot(cameraPosition, cameraPosition) + DOME * DOME, 0.0));
  vec3 behind = voidColour(normalize(cameraPosition + dir * reach));
  float lost = 1.0 - smoothstep(SLAB_BOTTOM + 0.7, SLAB_BOTTOM + 4.6, vY);
  lit = mix(lit, behind, lost * lost * (3.0 - 2.0 * lost));
  gl_FragColor = vec4(lit, 1.0);
}
`;

const waterVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aUv;
attribute float aTop;
varying float vBelow;
varying float vDepth;
varying vec3 vNormal;
void main() {
  float ground = fieldA(aUv).r;
  float surface = fieldB(aUv).r;
  float depth = surface - ground;
  float top = max(surface, ground) * HSCALE;
  float y = mix(ground * HSCALE, top, aTop);
  vec2 xz = tableXz(aUv) + normal.xz * 0.004;
  vBelow = top - y;
  vDepth = depth;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
}
`;

const waterFragment = /* glsl */ `
${GLSL_COMMON}
varying float vBelow;
varying float vDepth;
varying vec3 vNormal;
void main() {
  if (vDepth < 0.0004) discard;
  vec3 col = mix(vec3(0.16, 0.56, 0.66), vec3(0.02, 0.15, 0.36), smoothstep(0.0, 0.32, vBelow));
  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  col *= 0.65 + 0.6 * ndl;
  col = mix(col, vec3(0.85, 0.95, 1.0), (1.0 - smoothstep(0.0, 0.012, vBelow)) * 0.6);
  gl_FragColor = vec4(col, 0.86);
}
`;

const fallVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aUv;
attribute float aTop;
attribute float aAlong;
varying float vDrop;
varying float vStrength;
varying float vAlong;
void main() {
  vec4 a = fieldA(aUv);
  vec4 b = fieldB(aUv);
  float sea = step(a.r, uSea);
  // Only running water falls; the sea is shown as a clean cut.
  vStrength = b.g * (1.0 - sea) * step(0.0, b.r - a.r);
  float top = b.r * HSCALE;
  float y = top - (1.0 - aTop) * 3.4;
  vec2 xz = tableXz(aUv) + normal.xz * (0.03 + (1.0 - aTop) * 0.25);
  vDrop = 1.0 - aTop;
  vAlong = aAlong;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
}
`;

const fallFragment = /* glsl */ `
${GLSL_COMMON}
varying float vDrop;
varying float vStrength;
varying float vAlong;
void main() {
  if (vStrength < 0.04) discard;
  float streaks = vnoise(vec2(vAlong * 34.0, vDrop * 9.0 - uTime * 3.2));
  float mist = vnoise(vec2(vAlong * 9.0, vDrop * 3.0 - uTime * 1.1));
  float alpha = vStrength * pow(1.0 - vDrop, 1.6) * (0.35 + 0.75 * streaks) * (0.7 + 0.5 * mist);
  vec3 col = mix(vec3(0.55, 0.80, 1.0), vec3(1.0), streaks);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * 0.9);
}
`;

export function makeSlabSides(shared: SharedUniforms, outline: number[][], gw: number): THREE.Group {
  const group = new THREE.Group();
  const earth = new THREE.Mesh(
    makeEdgeGeometry(outline, gw),
    new THREE.ShaderMaterial({ uniforms: { ...shared }, vertexShader: earthVertex, fragmentShader: earthFragment, side: THREE.DoubleSide }),
  );
  const water = new THREE.Mesh(
    makeEdgeGeometry(outline, gw),
    new THREE.ShaderMaterial({
      uniforms: { ...shared }, vertexShader: waterVertex, fragmentShader: waterFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  water.renderOrder = 3;
  earth.frustumCulled = false;
  water.frustumCulled = false;
  const falls = new THREE.Mesh(
    makeEdgeGeometry(outline, gw),
    new THREE.ShaderMaterial({
      uniforms: { ...shared }, vertexShader: fallVertex, fragmentShader: fallFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  falls.renderOrder = 4;
  falls.frustumCulled = false;
  group.add(earth, water, falls);
  return group;
}
