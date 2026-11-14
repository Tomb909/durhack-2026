// The land: a grid mesh pushed up by the height texture and coloured by climate.
import * as THREE from 'three';
import { GLSL_COMMON, world, type SharedUniforms } from './common';
import { RULES } from '../sim/world';
import { GLSL_LAVA } from './lava';

const vertex = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec2 uv = tableUv(position.xz);
  vec4 a = fieldA(uv);
  vec4 b = fieldB(uv);
  float h = a.r - 0.004 * b.g; // rivers cut a shallow channel
  vec3 p = vec3(position.x, h * HSCALE, position.z);
  vUv = uv;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const fragment = /* glsl */ `
${GLSL_COMMON}
${GLSL_LAVA}
uniform sampler2D uPaletteBare;
uniform sampler2D uPaletteGreen;
uniform float uSeaBase;
uniform vec4 uPulse[16];
uniform vec3 uPulseColor[16];
uniform int uPulseCount;
varying vec2 vUv;
varying vec3 vWorld;

float groundAt(vec2 uv) { vec4 a = fieldA(uv); return a.r; }

// Soft shadows: walk toward the sun over the height texture.
float sunShadow(vec3 p) {
  float res = 1.0;
  float t = 0.05;
  for (int i = 0; i < 20; i++) {
    vec3 q = p + uSunDir * t;
    vec2 uv = tableUv(q.xz);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float gap = q.y - groundAt(uv) * HSCALE;
    res = min(res, 9.0 * gap / t);
    if (res < 0.0) break;
    t += 0.07 + t * 0.14;
  }
  return smoothstep(0.0, 1.0, res);
}

void main() {
  if (fieldB(vUv).a < 0.499) discard; // outside the play area
  vec4 a = fieldA(vUv);
  vec4 b = fieldB(vUv);
  float h = a.r;
  float temperature = a.g;
  float wet = a.b;
  float plants = a.a;
  float depth = b.r - h;
  float river = b.g;
  float rain = b.b;

  // Surface normal from neighbouring heights, plus fine grain.
  vec2 e = uTexel * 0.9;
  float hl = groundAt(vUv - vec2(e.x, 0.0));
  float hr = groundAt(vUv + vec2(e.x, 0.0));
  float hd = groundAt(vUv - vec2(0.0, e.y));
  float hu = groundAt(vUv + vec2(0.0, e.y));
  vec3 n = normalize(vec3((hl - hr) * HSCALE / (2.0 * e.x * WORLD_W), 1.0, (hd - hu) * HSCALE / (2.0 * e.y * WORLD_D)));
  float grain = fbm2(vWorld.xz * 6.0);
  float fine = vnoise(vWorld.xz * 42.0);
  n = normalize(n + 0.10 * vec3(vnoise(vWorld.xz * 9.0) - 0.5, 0.0, vnoise(vWorld.xz * 9.0 + 31.7) - 0.5));
  float slope = 1.0 - n.y;

  // Climate colour: temperature and wetness together, wobbled a little so zone edges are organic.
  vec2 climate = vec2(clamp(temperature * 0.5 + 0.5 + (grain - 0.5) * 0.06, 0.02, 0.98), clamp(wet + (grain - 0.5) * 0.10, 0.02, 0.98));
  vec3 bare = texture2D(uPaletteBare, climate).rgb;
  vec3 green = texture2D(uPaletteGreen, climate).rgb;
  vec3 col = mix(bare, green, smoothstep(0.04, 0.55, plants));
  col *= 0.90 + 0.20 * fine;
  // Mottling so bare ground is not a flat wash; wind ripples where it is hot and dry.
  col *= 0.86 + 0.28 * fbm2(vWorld.xz * 2.3 + 40.0);
  float desert = smoothstep(0.25, 0.55, temperature) * (1.0 - smoothstep(0.12, 0.3, wet)) * (1.0 - plants);
  float ripple = sin((vWorld.x * 0.8 + vWorld.z + 0.35 * fbm2(vWorld.xz * 1.5)) * 38.0);
  col *= 1.0 + 0.07 * desert * ripple;

  // Farmland: a patchwork of fields, each one crop, with furrows and darker hedges.
  vec4 c = fieldC(vUv);
  if (c.g > 0.02) {
    vec2 q = mat2(0.94, -0.34, 0.34, 0.94) * vWorld.xz / 0.30;
    vec2 cell = floor(q);
    vec2 f = fract(q);
    float pick = hash21(cell);
    float crop = hash21(cell + 17.3);
    float owned = smoothstep(pick - 0.12, pick + 0.12, c.g * 1.3 - 0.05);
    vec3 field = crop < 0.35 ? vec3(0.80, 0.68, 0.30)   // ripe wheat
               : crop < 0.62 ? vec3(0.42, 0.58, 0.22)   // young green
               : crop < 0.82 ? vec3(0.48, 0.34, 0.20)   // ploughed
               : vec3(0.70, 0.72, 0.36);                // pale barley
    float along = hash21(cell + 5.1) < 0.5 ? f.x : f.y;
    field *= 0.88 + 0.12 * sin(along * 6.2832 * 7.0);
    float hedge = 1.0 - smoothstep(0.0, 0.06, min(min(f.x, f.y), min(1.0 - f.x, 1.0 - f.y)));
    field = mix(field, vec3(0.20, 0.30, 0.13), hedge * 0.75);
    col = mix(col, field * (0.94 + 0.12 * fine), owned * (1.0 - smoothstep(0.004, 0.02, depth)));
  }
  // Felled forest stays open, sunny meadow.
  float felled = fieldD(vUv).r;
  col = mix(col, col * vec3(1.1, 1.06, 0.86) + vec3(0.03, 0.025, 0.0), felled * 0.6 * smoothstep(0.05, 0.4, plants));
  // Trodden earth between the houses.
  col = mix(col, vec3(0.52, 0.44, 0.34) * (0.9 + 0.2 * fine), 0.35 * smoothstep(0.2, 0.9, c.r));

  // Lava, and the volcanic ground around it: pale ash far out, dark grey-brown nearer, black basalt
  // beside the lava and high on the cone, with a hint of red-brown scoria where molten rock lights it.
  float lava = fieldD(vUv).a;
  float lavaHeat = c.a;
  float lavaCover = smoothstep(0.04, 0.34, lava + (grain - 0.5) * 0.12);
  vec4 nearLava = fieldE(vUv); // x: ash (lava spread wide), y: glow (molten lava spread a little), z: molten, w: any lava, both a medium way
  float burnt = smoothstep(0.004, 0.035, nearLava.x + (grain - 0.5) * 0.008);
  float flecks = 0.75 + 0.5 * fine;
  vec3 volcanic = vec3(0.19, 0.165, 0.135) * (0.85 + 0.3 * grain);                                    // ash apron, near #8C8478 once lit
  volcanic = mix(volcanic, vec3(0.102, 0.084, 0.072) * flecks, smoothstep(0.015, 0.09, nearLava.x));  // dark grey-brown #5A524C
  float blackness = max(smoothstep(0.08, 0.38, nearLava.w + (grain - 0.5) * 0.06), smoothstep(0.02, 0.07, nearLava.x + (grain - 0.5) * 0.015));
  volcanic = mix(volcanic, vec3(0.027, 0.023, 0.022) * flecks, blackness);                             // basalt #2E2A29
  float scoria = smoothstep(0.05, 0.40, nearLava.z + (fine - 0.5) * 0.06) * (0.55 + 0.45 * slope);
  volcanic = mix(volcanic, mix(vec3(0.047, 0.032, 0.030), vec3(0.147, 0.069, 0.048), smoothstep(0.1, 0.8, nearLava.y)) * flecks * 1.3, scoria * 0.8);
  col = mix(col, volcanic, burnt * 0.82);
  col = mix(col, lavaRock(vWorld.xz), lavaCover);

  // Snow where it is cold and wet enough: crisp, patchy edge.
  float snow = smoothstep(uFreezing + 0.10, uFreezing - 0.10, temperature + (grain - 0.5) * 0.16)
             * smoothstep(0.22, 0.42, wet);
  // Bare rock on steep faces.
  vec3 rock = mix(vec3(0.33, 0.31, 0.30), vec3(0.50, 0.47, 0.43), fine);
  float rocky = smoothstep(0.24, 0.50, slope + (grain - 0.5) * 0.10);
  col = mix(col, mix(rock, volcanic * (0.9 + 0.3 * fine), burnt), rocky * (1.0 - 0.75 * plants) * (1.0 - lavaCover));
  col = mix(col, vec3(0.66, 0.71, 0.80), snow * (1.0 - 0.8 * smoothstep(0.45, 0.75, slope)) * (1.0 - lavaCover * lavaHeat) * (1.0 - smoothstep(0.008, 0.04, nearLava.x)));

  // Beach just above the sea (not where frozen).
  // (No sand in a dug hole the sea has not reached: only ground the sea could lap at.)
  float shore = (1.0 - smoothstep(0.0, 0.010, h - uSea)) * step(uSea, h) * step(uSeaBase + 0.012, h);
  col = mix(col, vec3(0.86, 0.78, 0.56), shore * 0.75 * (1.0 - snow) * (1.0 - rocky));
  // Damp banks beside rivers; bed under water.
  col *= 1.0 - 0.30 * river;
  float under = smoothstep(0.0, 0.035, depth);
  col = mix(col, col * vec3(0.30, 0.55, 0.62), under);
  // Less daylight reaches the bottom of a hole.
  col *= 1.0 - 0.5 * smoothstep(0.0, 0.2, uSeaBase - h);

  // Light: warm sun with soft shadows, cool sky fill, overcast under rain.
  float shadow = sunShadow(vWorld + n * 0.02);
  float ndl = max(dot(n, uSunDir), 0.0);
  float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
  float overcast = 1.0 - 0.38 * rain;
  vec3 sun = vec3(1.0, 0.94, 0.84) * 1.55 * ndl * shadow * overcast;
  vec3 sky = vec3(0.50, 0.62, 0.88) * (0.30 + 0.26 * n.y) * mix(1.0, 0.82, rain);
  vec3 bounce = vec3(0.55, 0.45, 0.35) * 0.10 * wrap;
  vec3 lit = col * (sun + sky + bounce);
  // Snow glints.
  lit += snow * shadow * pow(max(dot(reflect(-uSunDir, n), normalize(cameraPosition - vWorld)), 0.0), 30.0) * 0.25;
  // Hot places glow warm, cold places cool.
  lit *= mix(vec3(0.90, 0.97, 1.08), vec3(1.08, 1.0, 0.90), smoothstep(-0.7, 0.7, temperature));
  // Molten rock is its own light, and throws an orange glow on what is next to it, most of all on
  // the walls that face it (the inside of a crater or a ravine). Shadow does not stop it.
  float molten = lavaCover * smoothstep(0.0, 0.6, lavaHeat) * (1.0 - under);
  float glow = smoothstep(0.0, 0.6, nearLava.y);
  if (glow > 0.003) {
    vec2 toward = vec2(fieldE(vUv + vec2(uTexel.x * 1.5, 0.0)).g - nearLava.y, fieldE(vUv + vec2(0.0, uTexel.y * 1.5)).g - nearLava.y);
    float facing = clamp(dot(n.xz, toward) / (length(toward) + 1e-5) * 2.5, 0.0, 1.0) * smoothstep(0.0005, 0.004, length(toward));
    float wall = smoothstep(0.05, 0.5, slope);
    vec3 glowTint = mix(vec3(1.0, 0.26, 0.04), vec3(1.0, 0.45, 0.10), glow);
    lit += glowTint * (col * 2.8 + 0.10) * glow * (1.2 + 2.2 * facing * wall + 0.8 * facing) * (1.0 - molten);
  }
  lit += lavaCracks(vWorld.xz, lavaHeat) * lavaCover * (1.0 - molten) * (1.0 - under);
  lit = mix(lit, lavaGlow(vWorld.xz, lavaDownhill(vUv), lavaHeat, lava), molten);
  // A ring of the card's colour sweeps out from where a card has just landed.
  for (int i = 0; i < 16; i++) {
    if (i >= uPulseCount) break;
    float age = uPulse[i].z;
    if (age > 1.5) continue;
    float r = length((vUv - uPulse[i].xy) * vec2(WORLD_W, WORLD_D));
    float ring = smoothstep(0.22, 0.0, abs(r - age * 3.4)) * (1.0 - age / 1.5);
    lit += uPulseColor[i] * ring * 0.8;
  }
  gl_FragColor = vec4(lit, 1.0);
}
`;

export function makeTerrain(
  shared: SharedUniforms, palettes: { bare: THREE.Texture; green: THREE.Texture }, gw: number, gh: number,
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(world.w, world.d, (gw - 1) * 2, (gh - 1) * 2);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared, uPaletteBare: { value: palettes.bare }, uPaletteGreen: { value: palettes.green }, uSeaBase: { value: RULES.seaBase } },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}
