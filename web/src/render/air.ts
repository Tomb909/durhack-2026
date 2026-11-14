// The air of word cards. Two parts:
//
//  - Particles belong to the card's place: embers rise over here, fog drifts over
//    there. One fixed pool of points, shared out among the cards that have any.
//  - Tint and light are for the whole world: a colour grade over the finished
//    picture, blended across cards by strength and capped, so the sky's own mood
//    (hot, cold, wet, alive) still shows through and night stays readable.
//
// Both are worked out from the cards each frame with nothing carried over, so a
// tile drawn from the same cards is always the same picture.
import * as THREE from 'three';
import type { LiveCard } from '../cards/store';
import { sampleField, type WorldFrame } from '../sim/world';
import { GLSL_COMMON, HSCALE, world, type SharedUniforms } from './common';

const SLOTS = 16;
const PER_SLOT = 180;
const MOTION = { rise: 0, fall: 1, drift: 2, swirl: 3 } as const;
/** The most any number of cards can lean the picture's colour, and darken or brighten it. */
const MOST_TINT = 0.42;
const DARKEST = -0.8;
const BRIGHTEST = 0.6;

const vertex = /* glsl */ `
${GLSL_COMMON}
varying float vSoft;
attribute vec4 aSeed;
attribute float aSlot;
uniform vec4 uSlot[${SLOTS}];      // x, ground y, z (scene units), strength
uniform vec4 uSlotKind[${SLOTS}];  // motion, size, density, glow
uniform vec3 uSlotColor[${SLOTS}];
uniform int uSlots;
uniform float uViewHeight;
varying vec3 vColor;
varying float vAlpha;
varying float vGlow;
void main() {
  int s = int(aSlot + 0.5);
  vAlpha = 0.0;
  vColor = vec3(0.0);
  vGlow = 0.0;
  gl_PointSize = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen unless used
  if (s >= uSlots) return;
  vec4 slot = uSlot[s];
  vec4 kind = uSlotKind[s];
  if (aSeed.w > kind.z || slot.w <= 0.0) return;
  float reach = 1.0 + 0.6 * kind.y;  // scene units round the card
  float a = aSeed.y * 6.2832;
  float r = reach * sqrt(aSeed.x);
  vec3 p = vec3(slot.x, slot.y, slot.z);
  float fade = 1.0;
  int motion = int(kind.x + 0.5);
  if (motion == 0) {
    // Rise: up from the ground and away, like smoke or sparks.
    float life = fract(uTime * (0.10 + 0.08 * aSeed.z) + aSeed.z * 7.0);
    p += vec3(cos(a) * r * (0.45 + 0.55 * life), 0.05 + 2.2 * life, sin(a) * r * (0.45 + 0.55 * life));
    p.x += 0.12 * sin(uTime * 0.9 + aSeed.y * 30.0) * life;
    fade = smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.65, 1.0, life));
  } else if (motion == 1) {
    // Fall: down from above, swaying, like petals or ash.
    float life = fract(uTime * (0.07 + 0.05 * aSeed.z) + aSeed.z * 7.0);
    p += vec3(cos(a) * r, 2.3 * (1.0 - life), sin(a) * r);
    p.xz += 0.15 * vec2(sin(uTime * 1.1 + aSeed.y * 20.0), cos(uTime * 0.8 + aSeed.x * 20.0));
    fade = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.9, 1.0, life));
  } else if (motion == 2) {
    // Drift: hanging low and wandering slowly, like fog or motes.
    float b = a + uTime * 0.04 * (aSeed.z - 0.5);
    p += vec3(cos(b) * r, 0.08 + 0.75 * aSeed.z * aSeed.z + 0.06 * sin(uTime * 0.5 + aSeed.y * 40.0), sin(b) * r);
  } else {
    // Swirl: round and up the card's axis, like a whirlwind or dancing lights.
    float life = fract(uTime * 0.05 + aSeed.z);
    float b = a + uTime * (0.7 + 0.5 * aSeed.x);
    float rr = reach * (0.25 + 0.6 * aSeed.x) * (0.6 + 0.4 * life);
    p += vec3(cos(b) * rr, 0.1 + 1.9 * life, sin(b) * rr);
    fade = smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.8, 1.0, life));
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  // A size in the world (scene units), drawn the same at any picture size.
  float size = (0.035 + 0.16 * kind.y + 0.35 * kind.y * kind.y) * (0.6 + 0.8 * aSeed.z);
  gl_PointSize = max(1.5, size * projectionMatrix[1][1] * uViewHeight * 0.5 / -mv.z);
  gl_Position = projectionMatrix * mv;
  // The fog of a big soft particle is thin; small sparks are solid.
  vAlpha = fade * slot.w * mix(0.85, 0.3, kind.y);
  vColor = uSlotColor[s];
  vGlow = kind.w;
  vSoft = kind.y;
}
`;

const fragment = /* glsl */ `
uniform float uNight;
varying vec3 vColor;
varying float vAlpha;
varying float vGlow;
varying float vSoft;
void main() {
  float d = length(gl_PointCoord - 0.5);
  // Small ones are crisp specks; big ones are soft puffs with no edge, so a crowd of them reads as fog.
  float shape = mix(smoothstep(0.5, 0.15, d), pow(max(0.0, 1.0 - 2.0 * d), 2.2), smoothstep(0.3, 0.8, vSoft));
  if (vAlpha * shape < 0.004) discard;
  // Glowing ones are bright enough to bloom; the rest catch a little light.
  vec3 col = vColor * mix(0.95, 2.4 + 1.5 * uNight, vGlow);
  gl_FragColor = vec4(col, vAlpha * shape);
}
`;

export class AirLayer {
  readonly points: THREE.Points;
  private slots = Array.from({ length: SLOTS }, () => new THREE.Vector4());
  private kinds = Array.from({ length: SLOTS }, () => new THREE.Vector4());
  private colours = Array.from({ length: SLOTS }, () => new THREE.Color());
  private material: THREE.ShaderMaterial;
  /** The grade over the whole picture: lean towards `tint` by `amount`, darken or brighten by `light`. */
  readonly grade = { tint: new THREE.Color(1, 1, 1), amount: 0, light: 0 };

  constructor(shared: SharedUniforms, night: { value: number }) {
    const count = SLOTS * PER_SLOT;
    const seeds = new Float32Array(count * 4);
    const slot = new Float32Array(count);
    let s = 4219;
    const random = () => {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      seeds.set([random(), random(), random(), random()], i * 4);
      slot[i] = Math.floor(i / PER_SLOT);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geometry.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uSlot: { value: this.slots },
        uSlotKind: { value: this.kinds },
        uSlotColor: { value: this.colours },
        uSlots: { value: 0 },
        uViewHeight: { value: 600 },
        uNight: night,
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
  }

  /** Work out this frame's particles and grade from the cards alone. */
  update(frame: WorldFrame, cards: LiveCard[], viewHeight: number): void {
    let n = 0;
    let weight = 0;
    let light = 0;
    const tint = new THREE.Color(0, 0, 0);
    const c = new THREE.Color();
    // Cards in a fixed order, so which ones get a slot when there are too many never depends on list order.
    const withAir = cards.filter((card) => card.def.atmosphere && card.strength > 0)
      .sort((a, b) => (a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : a.x - b.x || a.y - b.y));
    for (const card of withAir) {
      const air = card.def.atmosphere!;
      const w = air.strength * card.strength;
      if (w > 0) {
        c.set(air.tint);
        tint.r += c.r * w;
        tint.g += c.g * w;
        tint.b += c.b * w;
        weight += w;
      }
      light += air.light * card.strength;
      const p = air.particles;
      if (p && n < SLOTS) {
        const ground = Math.max(
          sampleField(frame.height, frame.w, frame.h, card.x, card.y), sampleField(frame.waterSurface, frame.w, frame.h, card.x, card.y),
        ) * HSCALE;
        this.slots[n].set((card.x - 0.5) * world.w, ground, (card.y - 0.5) * world.d, card.strength);
        this.kinds[n].set(MOTION[p.motion] ?? 2, p.size, p.density, p.glow ? 1 : 0);
        this.colours[n].set(p.color);
        n++;
      }
    }
    this.material.uniforms.uSlots.value = n;
    this.material.uniforms.uViewHeight.value = viewHeight;
    this.points.visible = n > 0;
    if (weight > 0) this.grade.tint.setRGB(tint.r / weight, tint.g / weight, tint.b / weight);
    else this.grade.tint.setRGB(1, 1, 1);
    // Several tinted cards together lean further, but never past the cap.
    this.grade.amount = MOST_TINT * Math.tanh(weight / MOST_TINT);
    this.grade.light = Math.min(BRIGHTEST, Math.max(DARKEST, light));
  }
}

/** A colour grade over the finished picture (before bloom, so glowing things still bloom at night). */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uAmount: { value: 0 },
    uLight: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform float uAmount;
    uniform float uLight;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb;
      float l = luma(c);
      // Lean the light towards the tint, keeping how bright each thing is: colours shift, shapes stay.
      vec3 tint = uTint / max(luma(uTint), 0.08);
      tint = min(tint, vec3(2.6));
      vec3 tinted = c * mix(vec3(1.0), tint, 0.75) + uTint * 0.025;
      c = mix(c, tinted, uAmount);
      // Night: darker and bluer, but never black, and bright lights (lanterns, glow) keep their brightness.
      float night = max(0.0, -uLight);
      vec3 dark = c * vec3(0.42, 0.5, 0.78) + vec3(0.004, 0.006, 0.014);
      float keep = smoothstep(0.9, 2.2, l);
      c = mix(c, mix(dark, c, keep), night);
      // Bright: lifted and a little warm.
      float day = max(0.0, uLight);
      c = mix(c, c * vec3(1.3, 1.26, 1.15) + vec3(0.01, 0.01, 0.006), day);
      gl_FragColor = vec4(c, texel.a);
    }
  `,
};
