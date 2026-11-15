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

// Relief too small for the height grid to hold: creases and gullies (low) between knuckles of ground (high).
float crease(vec2 p) {
  float r = 1.0 - abs(2.0 * fbm2(p * 1.7 + 3.0) - 1.0);
  return r * r * 0.65 + 0.35 * fbm2(p * 6.5 + 9.0);
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
  vec2 e = uTexel; // one whole cell each way: the slope then varies smoothly across cell edges
  float hl = groundAt(vUv - vec2(e.x, 0.0));
  float hr = groundAt(vUv + vec2(e.x, 0.0));
  float hd = groundAt(vUv - vec2(0.0, e.y));
  float hu = groundAt(vUv + vec2(0.0, e.y));
  vec3 n = normalize(vec3((hl - hr) * HSCALE / (2.0 * e.x * WORLD_W), 1.0, (hd - hu) * HSCALE / (2.0 * e.y * WORLD_D)));
  float grain = fbm2(vWorld.xz * 6.0);
  float fine = vnoise(vWorld.xz * 42.0);
  n = normalize(n + 0.10 * vec3(vnoise(vWorld.xz * 9.0) - 0.5, 0.0, vnoise(vWorld.xz * 9.0 + 31.7) - 0.5));
  // The lie of the land decides how rugged it is: plains barely, hillsides and steep ground a lot.
  float lifted = hillside(h);
  float high = alpine(h);
  float crag = crease(vWorld.xz);
  vec2 creaseSlope = vec2(crag - crease(vWorld.xz + vec2(0.035, 0.0)), crag - crease(vWorld.xz + vec2(0.0, 0.035))) / 0.035;
  float lie = 1.0 - n.y; // the slope of the land itself, before the small relief
  float rugged = 0.04 + 0.26 * lifted + 0.22 * smoothstep(0.08, 0.3, lie);
  n = normalize(n + 0.13 * rugged * vec3(creaseSlope.x, 0.0, creaseSlope.y));
  float slope = mix(lie, 1.0 - n.y, 0.5);

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
  // A meadow is never one green: broad drifts of sun-dried grass and of lusher, darker growth.
  float drift = fbm2(vWorld.xz * 0.55 + 71.0);
  col = mix(col, col * vec3(1.22, 1.10, 0.62), smoothstep(0.50, 0.70, drift) * 0.7 * (1.0 - desert));
  col = mix(col, col * vec3(0.62, 0.84, 0.72), smoothstep(0.46, 0.28, drift) * 0.6);
  // Up a mountainside the turf gives out: heath and tawny grass first, with scree spilling
  // down the gullies, well before the bare rock and the snow.
  vec3 heath = mix(vec3(0.34, 0.30, 0.15), vec3(0.22, 0.26, 0.14), fbm2(vWorld.xz * 3.1 + 5.0));
  float moor = lifted * smoothstep(0.30, 0.58, fbm2(vWorld.xz * 1.9 + 13.0) + 0.4 * high);
  col = mix(col, heath * (0.85 + 0.3 * fine), moor * 0.8 * (1.0 - 0.6 * plants));
  vec3 scree = mix(vec3(0.33, 0.30, 0.27), vec3(0.58, 0.55, 0.50), vnoise(vWorld.xz * 70.0));
  float loose = lifted * smoothstep(0.55, 0.85, slope * 2.2 + 0.45 * high + 0.55 * (1.0 - crag) + (grain - 0.5) * 0.3);
  col = mix(col, scree, loose * (1.0 - 0.7 * plants));
  // Hollows of the small relief sit a little darker, its knuckles a little lighter.
  col *= mix(1.0, 0.74 + 0.42 * crag, 0.25 + 0.75 * lifted);

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
  // A village green: the houses stand on the meadow, worn to patches of bare earth
  // where the village is thick (grass.ts thins the blades over the same ground).
  float worn = smoothstep(0.36, 0.60, fbm2(vWorld.xz * 2.6 + 11.0) + 0.10 * c.r);
  float trodden = smoothstep(0.25, 0.95, c.r) * worn;
  col = mix(col, vec3(0.17, 0.125, 0.075) * (0.9 + 0.2 * fine), 0.8 * trodden * (1.0 - smoothstep(0.004, 0.02, depth)));
  // Streets: packed earth between a town's houses, cobbles in a city and on the square.
  vec4 ue = fieldE(vUv);
  float urban = max(ue.r, ue.g);
  float cobble = hash21(floor(vWorld.xz * 42.0));
  vec3 paving = mix(vec3(0.40, 0.35, 0.28), vec3(0.47, 0.46, 0.44), max(ue.g, ue.b)) * (0.82 + 0.34 * cobble);
  float paved = max(smoothstep(0.25, 0.7, c.r) * smoothstep(0.15, 0.6, urban), ue.b);
  col = mix(col, paving, 0.9 * paved * (1.0 - smoothstep(0.004, 0.02, depth)));
  // Boulders lie about the open ground, thicker on the hillsides.
  vec3 stone = boulders(vWorld.xz, 0.07 + 0.26 * lifted);
  stone.x *= (1.0 - smoothstep(0.0, 0.004, depth)) * (1.0 - smoothstep(0.05, 0.3, max(c.r, c.g))) * (1.0 - paved);
  col = mix(col, mix(vec3(0.36, 0.34, 0.32), vec3(0.56, 0.53, 0.48), fine) * (0.9 + 0.2 * hash21(floor(vWorld.xz * 3.2))), stone.x);
  n = normalize(n + vec3(stone.y, 0.0, stone.z) * stone.x * 1.2);

  // Snow where it is cold and wet enough: crisp, patchy edge.
  float snow = smoothstep(uFreezing + 0.10, uFreezing - 0.10, temperature + (grain - 0.5) * 0.16)
             * smoothstep(0.22, 0.42, wet);
  // Bare rock on steep faces.
  // Rock is laid down in beds: bands that follow the height, and faces that run warmer or cooler.
  vec3 rock = mix(vec3(0.33, 0.31, 0.30), vec3(0.50, 0.47, 0.43), fine);
  float beds = h * 95.0 + 2.5 * fbm2(vWorld.xz * 1.3);
  rock *= 0.86 + 0.22 * smoothstep(0.25, 0.75, 0.5 + 0.5 * sin(beds)) + 0.08 * sin(beds * 3.7);
  // Brown and broken low down, paler and greyer toward the top.
  rock = mix(rock * vec3(1.10, 0.93, 0.74), rock * vec3(0.96, 0.99, 1.06), clamp(high + 0.5 * (fbm2(vWorld.xz * 0.9 + 27.0) - 0.5), 0.0, 1.0));
  // Low on the mountain only the steep faces are bare; higher up, less of a slope is needed
  // before the rock shows through. Creases hold soil a little longer than the knuckles.
  float exposed = slope + (grain - 0.5) * 0.14 + 0.10 * (crag - 0.5) * lifted;
  float rocky = smoothstep(mix(0.40, 0.20, high), mix(0.66, 0.42, high), exposed);
  col = mix(col, rock, rocky * (1.0 - 0.75 * plants));
  // Frost where it is frozen but too dry for snow: pale, blue, cracked like a dry lake of ice.
  float frost = smoothstep(uFreezing + 0.10, uFreezing - 0.16, temperature + (grain - 0.5) * 0.16) * (1.0 - snow);
  float crack = smoothstep(0.035, 0.0, abs(fbm2(vWorld.xz * 3.1 + 7.0) - 0.5)) + smoothstep(0.03, 0.0, abs(fbm2(vWorld.xz * 7.3 + 19.0) - 0.5));
  vec3 frostCol = vec3(0.70, 0.80, 0.90) * (0.92 + 0.16 * fine) * (1.0 - 0.22 * min(1.0, crack));
  col = mix(col, frostCol, frost * 0.8 * (1.0 - 0.7 * rocky) * (1.0 - 0.6 * plants));
  col = mix(col, vec3(0.66, 0.71, 0.80), snow * (1.0 - 0.8 * smoothstep(0.45, 0.75, slope)));

  // Beach just above the sea (not where frozen).
  float shore = (1.0 - smoothstep(0.0, 0.010, h - uSea)) * step(uSea, h);
  col = mix(col, vec3(0.86, 0.78, 0.56), shore * 0.75 * (1.0 - snow) * (1.0 - rocky));
  // Damp banks beside rivers; bed under water.
  col *= 1.0 - 0.30 * river;
  float under = smoothstep(0.0, 0.035, depth);
  col = mix(col, col * vec3(0.30, 0.55, 0.62), under);

  // Light: warm sun with soft shadows, cool sky fill, overcast under rain.
  float shadow = sunlight(vWorld, n);
  float ndl = max(dot(n, uSunDir), 0.0);
  float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
  float overcast = 1.0 - 0.28 * rain;
  vec3 sun = SUN_LIGHT * ndl * shadow * overcast;
  // Sky light: strongest on faces that look up, a little less in shade (the sky is half hidden).
  vec3 sky = SKY_LIGHT * (0.28 + 0.24 * n.y) * mix(1.0, 0.8, rain) * (0.85 + 0.15 * shadow);
  vec3 bounce = BOUNCE_LIGHT * wrap;
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
