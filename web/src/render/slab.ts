// The cut sides of the floating chunk: layered earth, and water in cross-section.
import * as THREE from 'three';
import { GH, GW } from '../sim/world';
import { GLSL_COMMON, type SharedUniforms } from './common';

/** A ribbon of quads round the four edges. Each column has a top and a bottom vertex. */
function makeEdgeGeometry(): THREE.BufferGeometry {
  const uvs: number[] = [];
  const tops: number[] = [];
  const normals: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  let offset = 0;
  let distance = 0;
  const edge = (from: [number, number], to: [number, number], normal: [number, number, number], steps: number, length: number) => {
    const start = uvs.length / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = from[0] + (to[0] - from[0]) * t;
      const v = from[1] + (to[1] - from[1]) * t;
      for (const top of [1, 0]) {
        uvs.push(u, v);
        tops.push(top);
        normals.push(...normal);
        along.push(distance + t * length);
      }
    }
    for (let i = 0; i < steps; i++) {
      const a = start + i * 2;
      index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    offset += (steps + 1) * 2;
    distance += length;
  };
  edge([0, 1], [1, 1], [0, 0, 1], GW - 1, 10); // near
  edge([1, 1], [1, 0], [1, 0, 0], GH - 1, 7.07); // right
  edge([1, 0], [0, 0], [0, 0, -1], GW - 1, 10); // far
  edge([0, 0], [0, 1], [-1, 0, 0], GH - 1, 7.07); // left
  const geometry = new THREE.BufferGeometry();
  const count = uvs.length / 2;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('aTop', new THREE.BufferAttribute(new Float32Array(tops), 1));
  geometry.setAttribute('aAlong', new THREE.BufferAttribute(new Float32Array(along), 1));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(index);
  return geometry;
}

const earthVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aUv;
attribute float aTop;
attribute float aAlong;
varying float vY;
varying float vTopY;
varying float vAlong;
varying vec3 vNormal;
void main() {
  vec4 a = fieldA(aUv);
  float top = (a.r - 0.004 * fieldB(aUv).g) * HSCALE;
  float y = mix(SLAB_BOTTOM, top, aTop);
  vec2 xz = tableXz(aUv);
  vY = y;
  vTopY = top;
  vAlong = aAlong;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
}
`;

const earthFragment = /* glsl */ `
${GLSL_COMMON}
varying float vY;
varying float vTopY;
varying float vAlong;
varying vec3 vNormal;
void main() {
  // Ragged underside.
  float bottom = SLAB_BOTTOM + 0.15 + 0.55 * fbm2(vec2(vAlong * 1.7, 3.0));
  if (vY < bottom) discard;

  float wobble = fbm2(vec2(vAlong * 0.9, vY * 1.5));
  float layer = vY * 2.6 + wobble * 0.9;
  float band = fract(layer);
  float which = floor(layer);
  float pick = hash21(vec2(which, 7.0));
  vec3 strata = mix(vec3(0.26, 0.16, 0.10), vec3(0.40, 0.26, 0.16), pick);
  strata = mix(strata, vec3(0.22, 0.20, 0.20), step(0.7, pick));
  strata *= 0.86 + 0.14 * smoothstep(0.0, 0.12, band) * smoothstep(1.0, 0.85, band);
  strata *= 0.9 + 0.2 * vnoise(vec2(vAlong * 30.0, vY * 30.0));

  float below = vTopY - vY;
  vec3 soil = vec3(0.13, 0.085, 0.05);
  vec3 col = mix(soil, strata, smoothstep(0.05, 0.16, below + wobble * 0.05));

  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  vec3 lit = col * (vec3(1.0, 0.93, 0.80) * 1.2 * ndl + vec3(0.50, 0.62, 0.85) * 0.36);
  // Sink into the dark toward the underside.
  lit *= mix(0.25, 1.0, smoothstep(bottom, bottom + 1.1, vY));
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

export function makeSlabSides(shared: SharedUniforms): THREE.Group {
  const group = new THREE.Group();
  const earth = new THREE.Mesh(
    makeEdgeGeometry(),
    new THREE.ShaderMaterial({ uniforms: { ...shared }, vertexShader: earthVertex, fragmentShader: earthFragment, side: THREE.DoubleSide }),
  );
  const water = new THREE.Mesh(
    makeEdgeGeometry(),
    new THREE.ShaderMaterial({
      uniforms: { ...shared }, vertexShader: waterVertex, fragmentShader: waterFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  water.renderOrder = 3;
  earth.frustumCulled = false;
  water.frustumCulled = false;
  const falls = new THREE.Mesh(
    makeEdgeGeometry(),
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
