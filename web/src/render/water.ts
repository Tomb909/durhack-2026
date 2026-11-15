// All open water (sea, lakes, rivers) is one surface, lifted to the water
// level texture and drawn only where it is above the ground.
import * as THREE from 'three';
import { GLSL_BIOME, GLSL_COMMON, MAX_BIOMES, world, type SharedUniforms } from './common';

const vertex = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec2 uv = tableUv(position.xz);
  float surface = fieldB(uv).r;
  vec3 p = vec3(position.x, surface * HSCALE, position.z);
  vUv = uv;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const fragment = /* glsl */ `
${GLSL_COMMON}
${GLSL_BIOME}
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  if (fieldB(vUv).a < 0.499) discard; // outside the play area
  vec4 a = fieldA(vUv);
  vec4 b = fieldB(vUv);
  float depth = b.r - a.r;
  if (depth < 0.0002) discard;
  float temperature = a.g;
  float river = b.g;
  float rain = b.b;
  vec2 wind = fieldF(vUv).rg;
  float gust = length(wind);

  // Ripples: two layers of drifting noise give the normal.
  vec2 p = vWorld.xz - wind * uTime * 0.20;
  float t = uTime;
  float n1 = vnoise(p * 5.0 + vec2(t * 0.35, t * 0.22));
  float n2 = vnoise(p * 11.0 - vec2(t * 0.30, -t * 0.41));
  float n1x = vnoise(p * 5.0 + vec2(0.12, 0.0) + vec2(t * 0.35, t * 0.22));
  float n1z = vnoise(p * 5.0 + vec2(0.0, 0.12) + vec2(t * 0.35, t * 0.22));
  float n2x = vnoise(p * 11.0 + vec2(0.06, 0.0) - vec2(t * 0.30, -t * 0.41));
  float n2z = vnoise(p * 11.0 + vec2(0.0, 0.06) - vec2(t * 0.30, -t * 0.41));
  vec3 n = normalize(vec3((n1 - n1x) * 1.6 + (n2 - n2x) * 1.2, 1.0, (n1 - n1z) * 1.6 + (n2 - n2z) * 1.2));

  float frozen = smoothstep(uFreezing + 0.06, uFreezing - 0.10, temperature + (n1 - 0.5) * 0.10);

  float deep = smoothstep(0.0, 0.055, depth);
  vec3 shallowCol = vec3(0.16, 0.62, 0.66);
  vec3 deepCol = vec3(0.02, 0.17, 0.38);
  vec3 riverCol = vec3(0.10, 0.42, 0.72);
  vec3 foamCol = vec3(0.95, 0.98, 1.0);
  // Biomes: what the liquid is made of here (a green swamp, a sea of lava). 'own' is how far it
  // is no longer water, 'glow' how far it is lit from within.
  vec3 ownCol = vec3(0.0);
  float own = 0.0;
  float glow = 0.0;
  for (int i = 0; i < ${MAX_BIOMES}; i++) {
    if (i >= uBiomeCount) break;
    float w = biomeAt(i, vUv, vWorld.xz) * uBiomeLiquid[i].a;
    if (w <= 0.0) continue;
    // Full strength well before the biome's own: a half-blue sea of lava is neither.
    w = smoothstep(0.0, 0.45, w);
    vec3 c = uBiomeLiquid[i].rgb;
    shallowCol = mix(shallowCol, c * 1.25 + 0.02, w);
    deepCol = mix(deepCol, c * 0.5, w);
    riverCol = mix(riverCol, c, w);
    foamCol = mix(foamCol, clamp(c * 2.0 + 0.1, 0.0, 1.0), w);
    ownCol = mix(ownCol, c, own + w > 0.0 ? w / (own + w - own * w) : 0.0);
    glow = mix(glow, uBiomeExtra[i].x, w);
    own = own + w - own * w;
  }
  vec3 col = mix(shallowCol, deepCol, deep);
  col = mix(col, riverCol, river * (1.0 - deep) * 0.85);

  vec3 view = normalize(cameraPosition - vWorld);
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0);
  vec3 skyCol = mix(vec3(0.55, 0.72, 0.95), vec3(0.50, 0.55, 0.62), rain);
  col = mix(col, skyCol, (0.10 + 0.55 * fresnel) * (1.0 - 0.8 * glow));

  float overcast = 1.0 - 0.38 * rain;
  float ndl = max(dot(n, uSunDir), 0.0);
  col *= (0.55 + 0.75 * ndl * overcast);
  float spec = pow(max(dot(reflect(-uSunDir, n), view), 0.0), 90.0);
  col += vec3(1.0, 0.95, 0.85) * spec * 1.6 * overcast * (1.0 - frozen);

  // Foam where the water meets the land, breathing in and out.
  float lap = 0.0016 + 0.0009 * sin(t * 1.3 + p.x * 3.0 + p.y * 2.0);
  float foam = (1.0 - smoothstep(0.0, lap + 0.0016, depth)) * smoothstep(0.35, 0.65, n2 + 0.25);
  foam += (1.0 - smoothstep(0.0, 0.0009, depth)) * 0.8;
  col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.85 * (1.0 - frozen) * (1.0 - smoothstep(0.05, 0.4, river)));
  vec2 flow = normalize(wind + vec2(0.00001));
  float windChop = pow(max(0.0, sin(dot(vWorld.xz, flow) * 19.0 - t * 3.2)), 12.0) * smoothstep(0.16, 0.75, gust);
  col = mix(col, vec3(0.82, 0.94, 1.0), windChop * 0.38 * (1.0 - frozen) * smoothstep(0.001, 0.025, depth));
  // Rain rings.
  float ring = smoothstep(0.80, 0.98, vnoise(p * 26.0 + floor(t * 6.0) * 7.3)) * rain;
  col += ring * 0.10 * (1.0 - frozen);

  // Ice: pale, matte, with cracks.
  float crack = smoothstep(0.47, 0.5, abs(vnoise(p * 7.0) - 0.5) * 2.0 + 0.45) ;
  vec3 ice = mix(vec3(0.80, 0.90, 0.97), vec3(0.93, 0.97, 1.0), n2) * (0.72 + 0.45 * ndl * overcast);
  ice = mix(ice * 0.86, ice, crack);
  col = mix(col, ice, frozen);

  // Lit from within: its own light, whatever the sun does. A darker skin drifts on it and it burns
  // brightest where the skin parts and where it meets the land.
  if (glow > 0.001) {
    float skin = smoothstep(0.38, 0.72, fbm2(p * 2.4 + vec2(t * 0.045, -t * 0.03)));
    float seam = 1.0 - smoothstep(0.0, 0.10, abs(fbm2(p * 3.1 - vec2(t * 0.03, t * 0.05)) - 0.5));
    vec3 hot = mix(ownCol * 2.3 + 0.06, ownCol * 0.42, skin * 0.8);
    hot += ownCol * 1.6 * seam * skin;
    hot += clamp(ownCol * 2.0 + 0.1, 0.0, 1.0) * (1.0 - smoothstep(0.0, 0.006, depth)) * 0.8;
    col = mix(col, hot, glow * (1.0 - frozen));
  }

  float alpha = mix(0.62, 0.95, max(deep, river * 0.8));
  alpha = mix(alpha, max(alpha, 0.9), own); // not water: you do not see far into it
  alpha = mix(alpha, 0.98, glow * own);
  alpha = mix(alpha, 0.97, frozen);
  alpha *= smoothstep(0.0002, 0.0016, depth);
  gl_FragColor = vec4(col, alpha);
}
`;

export function makeWater(shared: SharedUniforms, gw: number, gh: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(world.w, world.d, (gw - 1) * 2, (gh - 1) * 2);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}
