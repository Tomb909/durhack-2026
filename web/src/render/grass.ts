// Grass: tens of thousands of small tufts at fixed sites, so open ground is a
// meadow instead of a flat wash of colour. Built to be cheap:
//
// - one draw call (instancing), a tuft is three blades and nine triangles;
// - all the work is in the vertex shader: whether grass grows here, its colour and
//   its light are worked out once per corner, and the pixel shader only writes the
//   colour (no shadow lookups per pixel, unlike the land and the trees);
// - a tuft where no grass grows (desert, ice, water, fields) is thrown away before
//   any of the costly light lookups;
// - tufts cast no shadows and so are never drawn into the sun's shadow map.
//
// Blades are a pixel or two wide from where the whole world is in view, which
// would sparkle like static as the camera drifts. Three things keep it calm:
// far blades are widened to stay a couple of pixels across, their root-to-tip and
// tuft-to-tuft contrast fades toward one even colour, and grass is left out of
// the depth buffer so the ambient occlusion sees smooth ground, not blade edges.
import * as THREE from 'three';
import { GLSL_COMMON, type SharedUniforms } from './common';

/** Tufts across the long side of the world. The count grows with its square. */
const COLUMNS = 270;
const BLADES = 3;

/** One tuft, one unit tall: blades fanned out from a point, each tapering to a tip. */
function tuft(): THREE.BufferGeometry {
  const positions: number[] = []; // down the middle of each blade
  const sides: number[] = []; // from the middle out to the edge
  const tips: number[] = [];
  const indices: number[] = [];
  const heights = [1, 0.8, 0.62];
  for (let k = 0; k < BLADES; k++) {
    const yaw = (k / BLADES) * Math.PI * 2 + 0.5;
    const out = [Math.cos(yaw), Math.sin(yaw)]; // the way this blade leans
    const side = [-out[1], out[0]];
    const tall = heights[k % heights.length];
    const lean = 0.30 + 0.12 * k;
    const first = positions.length / 3;
    // Rows of the blade: root, half way, tip. (how far up, half width)
    const rows: [number, number][] = [[0, 0.13], [0.5, 0.09], [1, 0]];
    for (const [t, half] of rows) {
      const forward = 0.08 + lean * t * t * tall;
      for (const across of half > 0 ? [-half, half] : [0]) {
        positions.push(out[0] * forward, t * tall, out[1] * forward);
        sides.push(side[0] * across, side[1] * across);
        tips.push(t);
      }
    }
    indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2, first + 2, first + 3, first + 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 2));
  geometry.setAttribute('aTip', new THREE.Float32BufferAttribute(tips, 1));
  geometry.setIndex(indices);
  return geometry;
}

const vertex = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aSite;
attribute vec4 aRand;
attribute float aTip;
attribute vec2 aSide;
uniform float uViewHeight;
uniform sampler2D uPaletteBare;
uniform sampler2D uPaletteGreen;
uniform float uSize;
varying vec3 vColor;

// Sunlight on a tuft: the same three things as sunlight() in common.ts (the land's
// relief, things standing on it, clouds) with fewer lookups. A tuft is small, so
// its shadow edge does not need the land's soft many-tap filter.
float tuftSunlight(vec3 p) {
  float res = 1.0;
  float t = 0.06;
  for (int i = 0; i < 12; i++) {
    vec3 q = p + uSunDir * t;
    vec2 uv = tableUv(q.xz);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    res = min(res, 8.0 * (q.y - fieldA(uv).r * HSCALE) / t);
    if (res < 0.0) break;
    t += 0.12 + t * 0.3;
  }
  float relief = smoothstep(0.0, 1.0, res);
  if (relief <= 0.0) return 0.0;
  vec3 c = sunSpace(p);
  float unshaded = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 1.5708 + aRand.w * 6.2832;
    vec2 o = vec2(cos(a), sin(a)) * 1.6 * SHADOW_TEXEL;
    unshaded += step(c.z - 0.0009, texture2D(uShadowMap, c.xy + o).r);
  }
  return relief * unshaded * 0.25 * (1.0 - 0.55 * smoothstep(0.0, 0.9, texture2D(uCloudMap, c.xy).r));
}

void main() {
  vec4 a = fieldA(aSite);
  vec4 b = fieldB(aSite);
  vec4 c = fieldC(aSite);
  float h = a.r;
  float temperature = a.g;
  float wet = a.b;
  float plants = a.a;

  // Where grass grows: thawed ground that is not desert, water, beach, field or village.
  float thawed = smoothstep(uFreezing + 0.02, uFreezing + 0.22, temperature);
  float parched = smoothstep(0.18, 0.42, temperature) * (1.0 - smoothstep(0.12, 0.3, wet));
  float cover = thawed * (1.0 - parched) * step(0.5, b.a);
  cover *= 1.0 - smoothstep(0.0, 0.0015, b.r - h);
  cover *= smoothstep(0.004, 0.014, h - uSea) * (1.0 - b.g);
  cover *= (1.0 - smoothstep(0.04, 0.25, c.g)) * (1.0 - 0.8 * smoothstep(0.3, 0.9, c.r));
  // None on paved streets and squares, little up on the heath and scree, and none on a boulder.
  vec4 ue = fieldE(aSite);
  cover *= 1.0 - max(ue.b, smoothstep(0.25, 0.7, c.r) * smoothstep(0.15, 0.6, max(ue.r, ue.g)));
  cover *= 1.0 - 0.7 * smoothstep(0.14, 0.3, h);
  cover *= 1.0 - step(0.2, boulders(tableXz(aSite), 0.07 + 0.26 * hillside(h)).x);
  // Each tuft has its own threshold, so a meadow thins out toward its edge.
  float threshold = 0.04 + 0.6 * aRand.x;
  float grow = smoothstep(threshold, threshold + 0.25, cover);
  if (grow < 0.01) {
    vColor = vec3(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen: costs nothing more
    return;
  }

  // The slope here: no grass on rock faces, and the ground's own shading.
  vec2 e = uTexel;
  float hl = fieldA(aSite - vec2(e.x, 0.0)).r;
  float hr = fieldA(aSite + vec2(e.x, 0.0)).r;
  float hd = fieldA(aSite - vec2(0.0, e.y)).r;
  float hu = fieldA(aSite + vec2(0.0, e.y)).r;
  vec3 n = normalize(vec3((hl - hr) * HSCALE / (2.0 * e.x * WORLD_W), 1.0, (hd - hu) * HSCALE / (2.0 * e.y * WORLD_D)));
  grow *= 1.0 - smoothstep(0.18, 0.40, 1.0 - n.y);

  vec2 xz = tableXz(aSite);
  float size = uSize * (0.55 + 0.75 * aRand.y) * (0.75 + 0.6 * wet) * grow;
  vec3 ground = vec3(xz.x, h * HSCALE, xz.y);
  // How many pixels wide a blade is from here. Small: widen it, and flatten its colour.
  float pixels = 0.26 * size * uViewHeight * projectionMatrix[1][1] * 0.5 / max(0.1, -(viewMatrix * vec4(ground, 1.0)).z);
  float widen = clamp(2.6 / max(pixels, 0.01), 1.0, 3.0);
  float far = 1.0 - smoothstep(1.5, 4.0, pixels);
  float angle = aRand.z * 6.2832;
  float ca = cos(angle), sa = sin(angle);
  vec3 blade = position + vec3(aSide.x, 0.0, aSide.y) * widen;
  vec3 p = vec3(ca * blade.x - sa * blade.z, blade.y, sa * blade.x + ca * blade.z) * size;

  // Wind: slow waves roll across the meadow; a WIND card lays the grass over its way.
  float gust = vnoise(xz * 0.9 - uTime * vec2(0.55, 0.2));
  vec2 wind = fieldD(aSite).ba;
  vec2 bend = vec2(0.30, 0.12) * (gust - 0.4)
            + 0.07 * vec2(sin(uTime * 2.3 + aRand.w * 6.2832), cos(uTime * 1.9 + aRand.z * 6.2832))
            + wind * (0.55 + 0.25 * sin(uTime * 5.0 + aRand.w * 6.2832 + gust * 5.0));
  // From far off the sway is smaller than a pixel and only sparkles: still it there (the paler gust waves still show the wind).
  bend *= 1.0 - 0.9 * far;
  p.xz += bend * aTip * aTip * size;
  p.y *= 1.0 - 0.25 * min(1.0, dot(bend, bend));

  vec3 world = ground + vec3(p.x, p.y - 0.004, p.z);

  // Colour: the ground's own climate colour (see terrain.ts), dark at the root, bright at the tip.
  float grain = fbm2(xz * 6.0);
  vec2 climate = vec2(clamp(temperature * 0.5 + 0.5 + (grain - 0.5) * 0.06, 0.02, 0.98), clamp(wet + (grain - 0.5) * 0.10, 0.02, 0.98));
  vec3 col = mix(texture2D(uPaletteBare, climate).rgb, texture2D(uPaletteGreen, climate).rgb, smoothstep(0.04, 0.55, plants));
  col *= 0.86 + 0.28 * fbm2(xz * 2.3 + 40.0);
  // The same drifts of sun-dried and of lusher grass as the land under it (see terrain.ts).
  float drift = fbm2(xz * 0.55 + 71.0);
  col = mix(col, col * vec3(1.22, 1.10, 0.62), smoothstep(0.50, 0.70, drift) * 0.7 * (1.0 - parched));
  col = mix(col, col * vec3(0.62, 0.84, 0.72), smoothstep(0.46, 0.28, drift) * 0.6);
  col *= mix(mix(0.60, 1.18, aTip) * (0.84 + 0.32 * aRand.w), 0.88, 0.93 * far);
  // Some tufts are sun-bleached at the tip; passing gusts show as paler waves.
  col = mix(col, col * vec3(1.12, 1.08, 0.74), aTip * 0.30 * aRand.x * (1.0 - far));
  col *= 1.0 + 0.22 * (gust - 0.5) * aTip;
  // Wild flowers: here and there a tuft is in bloom, in drifts across the wetter meadows.
  float bloom = step(0.93, fract(aRand.w * 37.7)) * smoothstep(0.42, 0.62, fbm2(xz * 1.3 + 90.0)) * smoothstep(0.18, 0.4, wet);
  float kind = fract(aRand.x * 19.3);
  vec3 petal = kind < 0.4 ? vec3(1.0, 0.96, 0.86) : kind < 0.75 ? vec3(1.0, 0.80, 0.16) : vec3(0.72, 0.42, 0.92);
  col = mix(col, petal, bloom * aTip * aTip);

  // Light, as on the land under it.
  float shade = tuftSunlight(ground + n * 0.03 + vec3(0.0, 0.03, 0.0)); // from blade height, so a bump in the ground beside it does not black out one tuft
  float rain = b.b;
  float ndl = max(dot(n, uSunDir), 0.0);
  float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
  vec3 light = SUN_LIGHT * ndl * shade * (1.0 - 0.28 * rain) * (1.0 + 0.2 * aTip * (1.0 - far))
             + SKY_LIGHT * (0.28 + 0.24 * n.y) * mix(1.0, 0.8, rain) * (0.85 + 0.15 * shade)
             + BOUNCE_LIGHT * wrap;
  light *= mix(vec3(0.90, 0.97, 1.08), vec3(1.08, 1.0, 0.90), smoothstep(-0.7, 0.7, temperature));
  vColor = col * light;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragment = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

export function makeGrass(shared: SharedUniforms, palettes: { bare: THREE.Texture; green: THREE.Texture }): THREE.Mesh {
  const columns = COLUMNS;
  const rows = Math.round(COLUMNS / 1.4);
  const count = columns * rows;
  const sites = new Float32Array(count * 2);
  const rand = new Float32Array(count * 4);
  let s = 71;
  const random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const k = j * columns + i;
      sites[k * 2] = Math.min(0.997, Math.max(0.003, (i + random()) / columns));
      sites[k * 2 + 1] = Math.min(0.997, Math.max(0.003, (j + random()) / rows));
      rand.set([random(), random(), random(), random()], k * 4);
    }
  }
  const base = tuft();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(base.getIndex());
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('aTip', base.getAttribute('aTip'));
  geometry.setAttribute('aSide', base.getAttribute('aSide'));
  geometry.setAttribute('aSite', new THREE.InstancedBufferAttribute(sites, 2));
  geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared, uPaletteBare: { value: palettes.bare }, uPaletteGreen: { value: palettes.green }, uSize: { value: 0.085 } },
    vertexShader: vertex,
    fragmentShader: fragment,
    side: THREE.DoubleSide,
    // Tested against the depth of everything else, but writing none of its own.
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1; // so: after everything solid that could stand in front of it
  mesh.frustumCulled = false;
  return mesh;
}
