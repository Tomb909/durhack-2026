// The sky around the world: a soft dome of light and drifting mist, stars, and
// slow motes in the air. It follows the world's conditions (uMood, see mood.ts):
// amber dusk over a hot world, icy teal and aurora over a frozen one, grey
// overcast when it rains, a green cast and fireflies where things grow.
import * as THREE from 'three';
import { GLSL_COMMON, type SharedUniforms } from './common';

/** Radius of the dome that the sky is painted on. */
export const DOME_RADIUS = 90;

/**
 * GLSL: the colour of the sky in a direction from the middle of the world,
 * without stars. Shared, so the world's deep base can fade into it exactly.
 * Needs GLSL_COMMON before it (uMood, uTime, uSunDir, fbm2).
 */
export const GLSL_VOID = /* glsl */ `
vec3 voidColour(vec3 dir) {
  float h = dir.y;
  float hot = uMood.x, cold = uMood.y, wet = uMood.z, life = uMood.w;

  // Three anchors: straight up, the horizon, and the depths below the world.
  vec3 zenith = vec3(0.020, 0.030, 0.085);
  vec3 horizon = vec3(0.085, 0.115, 0.215);
  vec3 depths = vec3(0.022, 0.030, 0.070);
  vec3 glow = vec3(0.30, 0.20, 0.26); // the bright side of the sky

  // The conditions each pull the three anchors their own way.
  zenith = mix(zenith, vec3(0.075, 0.030, 0.065), hot * 0.85);  // dusk: plum above, amber at the rim
  horizon = mix(horizon, vec3(0.330, 0.150, 0.070), hot * 0.85);
  depths = mix(depths, vec3(0.070, 0.028, 0.040), hot * 0.85);
  glow = mix(glow, vec3(0.70, 0.32, 0.10), hot);

  zenith = mix(zenith, vec3(0.010, 0.034, 0.078), cold * 0.85);  // ice: clear teal
  horizon = mix(horizon, vec3(0.110, 0.215, 0.255), cold * 0.85);
  depths = mix(depths, vec3(0.020, 0.052, 0.082), cold * 0.85);
  glow = mix(glow, vec3(0.20, 0.42, 0.46), cold);

  // Rain takes the colour out of everything and closes the sky in.
  vec3 slate = vec3(0.085, 0.100, 0.125);
  zenith = mix(zenith, slate * 0.55, wet * 0.65);
  horizon = mix(horizon, slate * 1.35, wet * 0.65);
  depths = mix(depths, slate * 0.50, wet * 0.65);
  glow = mix(glow, slate * 1.6, wet * 0.75);

  // Growing things put green back, rain or no rain.
  horizon = mix(horizon, vec3(0.080, 0.190, 0.140), life * 0.6);
  depths = mix(depths, vec3(0.018, 0.058, 0.048), life * 0.6);
  glow = mix(glow, vec3(0.36, 0.44, 0.18), life * 0.65);

  vec3 col = h >= 0.0 ? mix(horizon, zenith, smoothstep(0.0, 0.75, h)) : mix(horizon, depths, smoothstep(0.0, -0.85, h));

  // One side of the sky is brighter, as if the light came from there. It is on the
  // far side of the world from the usual view, so the world stands against it.
  vec2 heading = normalize(dir.xz + vec2(1e-5));
  float toward = 0.5 + 0.5 * dot(heading, normalize(vec2(-0.25, -1.0)));
  col += glow * pow(toward, 3.0) * exp(-3.2 * abs(h + 0.12)) * 0.42;

  // Slow mist: big soft shapes drifting through it all, thicker in the rain.
  vec2 p = dir.xz / (abs(h) + 0.45);
  float big = fbm2(p * 1.15 + vec2(uTime * 0.006, uTime * 0.004));
  float fine = fbm2(p * 3.3 - vec2(uTime * 0.005, uTime * 0.002) + 7.3);
  float mist = smoothstep(0.30, 0.78, big * 0.72 + fine * 0.28);
  col *= 0.60 + (0.90 + 0.25 * wet) * mist;
  // Kept low overall: the world is the bright thing in the picture, the sky is what it sits in.
  return col * 0.56;
}
`;

const domeFragment = /* glsl */ `
${GLSL_COMMON}
${GLSL_VOID}
varying vec3 vDir;

// Sparse stars: a grid over the sky, a few cells lit, each twinkling at its own pace.
float stars(vec3 dir, float scale, float keep) {
  vec2 g = dir.xz / (abs(dir.y) + 0.30) * scale;
  vec2 cell = floor(g);
  float pick = hash21(cell + 13.7);
  vec2 at = vec2(hash21(cell + 3.1), hash21(cell + 9.4)) * 0.7 + 0.15;
  float d = length(fract(g) - at);
  float twinkle = 0.65 + 0.35 * sin(uTime * (0.6 + 2.2 * pick) + pick * 90.0);
  return step(keep, pick) * smoothstep(0.085, 0.0, d) * twinkle;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  vec3 col = voidColour(dir);

  // Stars: clearest overhead, fewer in the depths, lost behind rain.
  float clear = (1.0 - 0.85 * uMood.z) * (1.0 - 0.45 * uMood.x);
  float where = mix(0.35, 1.0, smoothstep(-0.9, 0.3, h));
  vec3 tint = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.86, 0.70), hash21(floor(dir.xz * 40.0)));
  col += tint * (stars(dir, 26.0, 0.80) * 0.55 + stars(dir, 55.0, 0.72) * 0.22) * clear * where;

  // Aurora over a frozen world: curtains of green light hanging in the upper sky.
  float cold = uMood.y;
  if (cold > 0.01) {
    float sweep = dir.x * 3.2 + dir.z * 1.4 + 2.2 * fbm2(dir.xz * 2.4 + uTime * 0.02);
    float curtain = pow(0.5 + 0.5 * sin(sweep * 3.0), 6.0);
    float rays = 0.6 + 0.4 * vnoise(vec2(sweep * 9.0, uTime * 0.25));
    float band = smoothstep(-0.02, 0.22, h) * smoothstep(0.85, 0.30, h);
    col += mix(vec3(0.10, 0.75, 0.42), vec3(0.20, 0.45, 0.85), smoothstep(0.2, 0.7, h)) * curtain * rays * band * cold * 0.38;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeBackdrop(shared: SharedUniforms): THREE.Group {
  const group = new THREE.Group();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(DOME_RADIUS, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: { ...shared },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: domeFragment,
    }),
  );
  // Drawn after everything solid, so the sky is only worked out where it shows: the world
  // covers half the screen, and the sky's drifting mist is not cheap. (See-through things
  // such as water and rain are always drawn after the solid ones, so they still go over it.)
  dome.renderOrder = 100;
  group.add(dome);

  const count = 700;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  // Seeded, so the same world at the same moment is the same picture on every load.
  let s = 71;
  const random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() - 0.5) * 46;
    positions[i * 3 + 1] = (random() - 0.5) * 26;
    positions[i * 3 + 2] = (random() - 0.5) * 46 - 6;
    seeds[i] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const motes = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uMood: shared.uMood },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform vec4 uMood; // hot, cold, wet, life
        varying float vTwinkle;
        varying float vSeed;
        void main() {
          vec3 p = position;
          // Embers rise quickly over a hot world; snow dust sinks over a cold one.
          float rise = (0.05 + 0.12 * aSeed) * (1.0 + 2.2 * uMood.x) - 0.16 * uMood.y;
          p.y = mod(p.y + uTime * rise + 13.0, 26.0) - 13.0;
          p.x += 0.4 * sin(uTime * 0.2 + aSeed * 40.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // Fireflies blink slowly and fully; ordinary motes only shimmer.
          float blink = 0.5 + 0.5 * sin(uTime * (0.6 + aSeed) + aSeed * 90.0);
          vTwinkle = mix(0.55 + 0.45 * blink, pow(blink, 3.0) * 1.6, uMood.w * step(0.5, fract(aSeed * 7.0)));
          vSeed = aSeed;
          gl_PointSize = (2.4 + 5.6 * aSeed) * 14.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec4 uMood;
        varying float vTwinkle;
        varying float vSeed;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          vec3 col = vec3(0.60, 0.72, 1.0);
          col = mix(col, vec3(1.0, 0.50, 0.16), uMood.x);                      // embers
          col = mix(col, vec3(0.92, 0.97, 1.0), uMood.y);                      // snow dust
          col = mix(col, vec3(0.78, 1.0, 0.36), uMood.w * step(0.5, fract(vSeed * 7.0))); // fireflies
          col *= 1.0 - 0.6 * uMood.z;                                          // dimmed by rain
          gl_FragColor = vec4(col * a * vTwinkle * 0.75, a);
        }
      `,
    }),
  );
  motes.frustumCulled = false;
  motes.renderOrder = -5;
  group.add(motes);
  return group;
}
