// The land: a grid mesh pushed up by the height texture and coloured by climate.
import * as THREE from 'three';
import { GLSL_COMMON, world, type SharedUniforms } from './common';

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
uniform sampler2D uPaletteBare;
uniform sampler2D uPaletteGreen;
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

  // Snow where it is cold and wet enough: crisp, patchy edge.
  float snow = smoothstep(uFreezing + 0.10, uFreezing - 0.10, temperature + (grain - 0.5) * 0.16)
             * smoothstep(0.22, 0.42, wet);
  // Bare rock on steep faces.
  vec3 rock = mix(vec3(0.33, 0.31, 0.30), vec3(0.50, 0.47, 0.43), fine);
  float rocky = smoothstep(0.24, 0.50, slope + (grain - 0.5) * 0.10);
  col = mix(col, rock, rocky * (1.0 - 0.75 * plants));
  col = mix(col, vec3(0.66, 0.71, 0.80), snow * (1.0 - 0.8 * smoothstep(0.45, 0.75, slope)));

  // Beach just above the sea (not where frozen).
  float shore = (1.0 - smoothstep(0.0, 0.010, h - uSea)) * step(uSea, h);
  col = mix(col, vec3(0.86, 0.78, 0.56), shore * 0.75 * (1.0 - snow) * (1.0 - rocky));
  // Damp banks beside rivers; bed under water.
  col *= 1.0 - 0.30 * river;
  float under = smoothstep(0.0, 0.035, depth);
  col = mix(col, col * vec3(0.30, 0.55, 0.62), under);

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
    uniforms: { ...shared, uPaletteBare: { value: palettes.bare }, uPaletteGreen: { value: palettes.green } },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}
