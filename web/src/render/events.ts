// What you see of the action cards: a nuke's flash, shockwave, fireball and
// mushroom cloud, and a tornado's funnel with debris. (A tsunami is drawn by
// the water itself: it raises the water texture and churns it white.)
import * as THREE from 'three';
import { sampleField, type WorldFrame } from '../sim/world';
import type { WorldEvent } from '../sim/events';
import { HSCALE, SUN_DIR, world } from './common';

/** Puffs placed in the vertex shader: each instance has aPuff = (kind, a, b, c) in 0..1. */
function puffs(count: number, kinds: (i: number) => number, segments = 1): THREE.InstancedBufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, segments);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  const data = new Float32Array(count * 4);
  let s = 12345;
  const random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) data.set([kinds(i), random(), random(), random()], i * 4);
  geometry.setAttribute('aPuff', new THREE.InstancedBufferAttribute(data, 4));
  geometry.instanceCount = count;
  return geometry;
}

const PUFF_FRAGMENT = /* glsl */ `
uniform vec3 uSun;
varying vec3 vColor;
varying vec3 vNormal;
varying float vAlpha;
varying float vGlow;
void main() {
  vec3 n = normalize(vNormal);
  float light = 0.55 + 0.6 * max(dot(n, uSun), 0.0);
  gl_FragColor = vec4(vColor * mix(light, 1.0, vGlow), vAlpha);
}
`;

const MUSHROOM_VERTEX = /* glsl */ `
attribute vec4 aPuff;
uniform float uAge;
uniform float uScale;
uniform float uWet;
uniform float uFade;
uniform float uTime;
varying vec3 vColor;
varying vec3 vNormal;
varying float vAlpha;
varying float vGlow;
void main() {
  float kind = aPuff.x;           // 0 stem, 1 ring of the cap, 2 top of the cap
  float a = aPuff.y * 6.2832, b = aPuff.z, c = aPuff.w;
  float rise = 1.0 - pow(1.0 - min(1.0, uAge / 7.0), 2.0);
  float H = 3.0 * rise * uScale;
  float Rc = (0.3 + 0.85 * rise) * uScale;
  float spin = uTime * 0.25;
  vec3 at;
  float size;
  if (kind < 0.5) {
    float h = b;
    float r = 0.16 * uScale * (1.0 + 0.4 * h) * (0.6 + 0.6 * c);
    at = vec3(cos(a + spin) * r, h * H * 0.9, sin(a + spin) * r);
    size = (0.16 + 0.14 * c) * uScale * (0.4 + 0.6 * rise);
  } else if (kind < 1.5) {
    float tube = b * 6.2832;
    float r = Rc + cos(tube) * 0.28 * uScale * rise;
    at = vec3(cos(a + spin) * r, H + sin(tube) * 0.28 * uScale * rise, sin(a + spin) * r);
    size = (0.22 + 0.2 * c) * uScale * (0.3 + 0.7 * rise);
  } else {
    float r = Rc * 0.85 * sqrt(b);
    at = vec3(cos(a) * r, H + 0.3 * uScale * rise * (1.0 - b) + 0.1, sin(a) * r);
    size = (0.25 + 0.2 * c) * uScale * (0.3 + 0.7 * rise);
  }
  // Fire at first, then smoke: brown-grey, or white steam if it boiled off water.
  float burn = 1.0 - smoothstep(1.0, 5.0, uAge + b * 1.5);
  vec3 smoke = mix(vec3(0.42, 0.37, 0.33), vec3(0.93, 0.94, 0.96), uWet) * (0.85 + 0.3 * c);
  vColor = mix(smoke, vec3(2.4, 1.0, 0.3) * (0.7 + 0.5 * c), burn);
  vGlow = burn;
  vAlpha = uFade * (0.9 - 0.2 * c);
  vNormal = position;
  vec3 p = at + position * size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FUNNEL_VERTEX = /* glsl */ `
attribute vec4 aPuff;
uniform float uScale;
uniform float uStrength;
uniform float uWet;
uniform float uFade;
uniform float uTime;
varying vec3 vColor;
varying vec3 vNormal;
varying float vAlpha;
varying float vGlow;
void main() {
  float kind = aPuff.x;           // 0 funnel, 1 debris
  float a = aPuff.y * 6.2832, b = aPuff.z, c = aPuff.w;
  float s = uScale * (0.7 + 0.4 * uStrength);
  vec3 at;
  float size;
  vec3 colour;
  if (kind < 0.5) {
    float h = b;
    float r = mix(0.04, 0.4, pow(h, 1.8)) * s * (0.85 + 0.3 * c);
    float ang = a + uTime * (8.0 - 5.0 * h);
    // The funnel snakes: its top sways while the foot stays on the ground.
    vec2 sway = vec2(sin(uTime * 0.9), cos(uTime * 0.7)) * 0.25 * h * h * s;
    at = vec3(cos(ang) * r + sway.x, h * 2.7 * s, sin(ang) * r + sway.y);
    size = mix(0.06, 0.2, h) * s * (0.7 + 0.6 * c);
    colour = mix(vec3(0.40, 0.37, 0.34), vec3(0.78, 0.86, 0.94), uWet) * (0.7 + 0.4 * h);
  } else {
    float ang = a + uTime * (3.0 + 3.0 * c);
    float r = (0.18 + 0.4 * b) * s;
    at = vec3(cos(ang) * r, (0.05 + 0.6 * fract(b * 3.7 + uTime * 0.3 * (0.5 + c))) * s, sin(ang) * r);
    size = 0.03 * s * (0.6 + 0.8 * c);
    colour = uWet > 0.5 ? vec3(0.85, 0.92, 1.0) : vec3(0.32, 0.24, 0.16);
  }
  vColor = colour;
  vGlow = 0.0;
  vAlpha = uFade * (kind < 0.5 ? 0.7 : 0.95);
  vNormal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(at + position * size, 1.0);
}
`;

function puffMaterial(vertex: string, extra: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: SUN_DIR.clone() }, uTime: { value: 0 }, uFade: { value: 1 }, uScale: { value: 1 }, uWet: { value: 0 }, ...extra },
    vertexShader: vertex,
    fragmentShader: PUFF_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
}

interface Visual {
  group: THREE.Group;
  update(e: WorldEvent, ground: number, time: number): void;
  dispose(): void;
}

function additive(colour: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: colour, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}

function nukeVisual(): Visual {
  const group = new THREE.Group();
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), additive(0xffffff));
  const fireball = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), additive(0xff8a30));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 96).rotateX(-Math.PI / 2), additive(0xffd9a0));
  const cloudMaterial = puffMaterial(MUSHROOM_VERTEX, { uAge: { value: 0 } });
  const cloud = new THREE.Mesh(puffs(150, (i) => (i < 45 ? 0 : i < 115 ? 1 : 2)), cloudMaterial);
  for (const m of [flash, fireball, ring, cloud]) {
    m.frustumCulled = false;
    m.renderOrder = 6;
    group.add(m);
  }
  return {
    group,
    update(e, ground, time) {
      const age = e.age;
      const s = e.scale;
      const fade = e.strength;
      // A blinding flash, a ring racing out across the ground, a fireball that rises and cools.
      flash.visible = age < 1.2;
      flash.scale.setScalar(0.4 * s + 2.2 * s * Math.min(1, age / 0.5));
      (flash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - age / 1.2) ** 2;
      flash.position.y = ground + 0.2;
      ring.visible = age < 2.2;
      ring.scale.setScalar(0.1 + age * 3.2 * s);
      ring.position.y = ground + 0.06;
      (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - age / 2.2);
      fireball.visible = age < 5;
      fireball.scale.setScalar(0.45 * s * (1 - 0.5 * Math.min(1, age / 5)));
      fireball.position.y = ground + 0.3 + Math.min(1, age / 6) * 2.6 * s;
      (fireball.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - age / 5);
      cloud.position.y = ground;
      const u = cloudMaterial.uniforms;
      u.uAge.value = age;
      u.uScale.value = s;
      u.uWet.value = e.wet ? 1 : 0;
      u.uFade.value = fade * Math.min(1, age / 0.6);
      u.uTime.value = time;
    },
    dispose() {
      for (const m of [flash, fireball, ring, cloud]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}

function tornadoVisual(): Visual {
  const group = new THREE.Group();
  const material = puffMaterial(FUNNEL_VERTEX, { uStrength: { value: 1 } });
  const funnel = new THREE.Mesh(puffs(230, (i) => (i < 200 ? 0 : 1)), material);
  funnel.frustumCulled = false;
  funnel.renderOrder = 6;
  group.add(funnel);
  return {
    group,
    update(e, ground, time) {
      const life = Math.min(1, e.age / 2) * Math.min(1, (e.duration - e.age) / 3);
      group.position.y = ground;
      const u = material.uniforms;
      u.uScale.value = e.scale;
      u.uStrength.value = e.strength;
      u.uWet.value = e.wet ? 1 : 0;
      u.uFade.value = Math.max(0, life) * Math.min(1, e.strength / 0.3);
      u.uTime.value = time;
    },
    dispose() {
      funnel.geometry.dispose();
      material.dispose();
    },
  };
}

export class EventVisuals {
  readonly group = new THREE.Group();
  private live = new Map<string, Visual>();

  update(frame: WorldFrame, time: number): void {
    const seen = new Set<string>();
    for (const e of frame.events) {
      if (e.kind === 'tsunami') continue;
      seen.add(e.key);
      let visual = this.live.get(e.key);
      if (!visual) {
        visual = e.kind === 'nuke' ? nukeVisual() : tornadoVisual();
        this.live.set(e.key, visual);
        this.group.add(visual.group);
      }
      const ground = Math.max(sampleField(frame.height, frame.w, frame.h, e.x, e.y), sampleField(frame.waterSurface, frame.w, frame.h, e.x, e.y)) * HSCALE;
      visual.group.position.set((e.x - 0.5) * world.w, 0, (e.y - 0.5) * world.d);
      visual.update(e, ground, time);
    }
    for (const [key, visual] of this.live) {
      if (seen.has(key)) continue;
      this.group.remove(visual.group);
      visual.dispose();
      this.live.delete(key);
    }
  }
}
