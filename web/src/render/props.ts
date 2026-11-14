// Objects of word cards: a castle, a boat, a lantern, built from a recipe of
// primitives (see Prop in cards/defs.ts). Drawn the way the trees and houses are:
// merged primitives, flat colour per part, faceted light from screen-space
// derivatives, snow on top when it is cold. Where they stand comes from
// sim/props.ts; this only draws them.
//
// Geometry is built once per card definition. Each definition gets one instanced
// mesh, and every frame says how many of it stand where. Nothing is eased between
// frames here, so a tile drawn from the same cards is always the same picture.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CardDef, PropPart } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { placeProps, type PlacedObject } from '../sim/props';
import type { WorldFrame } from '../sim/world';
import { GLSL_COMMON, HSCALE, world, type SharedUniforms } from './common';

const MOST = 48; // objects of one kind at once
const MOTIONS = { still: 0, bob: 1, sway: 2, spin: 3, drift: 4 } as const;

/** A triangular prism: ridge along x, the triangle across y and z (a roof). Unit size, centred. */
function prism(): THREE.BufferGeometry {
  const a = [-0.5, -0.5], b = [0.5, -0.5], c = [0, 0.5]; // (z, y)
  const v: number[] = [];
  const tri = (p: number[], q: number[], r: number[]) => v.push(...p, ...q, ...r);
  const at = (x: number, zy: number[]) => [x, zy[1], zy[0]];
  tri(at(0.5, a), at(0.5, b), at(0.5, c)); // ends
  tri(at(-0.5, a), at(-0.5, c), at(-0.5, b));
  for (const [p, q] of [[a, b], [b, c], [c, a]]) {
    tri(at(-0.5, p), at(-0.5, q), at(0.5, q));
    tri(at(-0.5, p), at(0.5, q), at(0.5, p));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

function primitive(shape: PropPart['shape']): THREE.BufferGeometry {
  switch (shape) {
    case 'box': return new THREE.BoxGeometry(1, 1, 1);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 9);
    case 'cone': return new THREE.ConeGeometry(0.5, 1, 9);
    // Four sides, turned so the square base lines up with x and z and fills the unit square.
    case 'pyramid': return new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4);
    case 'prism': return prism();
    case 'sphere': return new THREE.IcosahedronGeometry(0.5, 1);
  }
}

const DEG = Math.PI / 180;

/** One merged geometry for a card's object, standing on y = 0 inside the unit cube. */
export function buildPropGeometry(def: CardDef): THREE.BufferGeometry | null {
  const parts = def.prop?.parts ?? [];
  const pieces: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const part of parts) {
    let g = primitive(part.shape);
    g = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    e.set(part.rotate[0] * DEG, part.rotate[1] * DEG, part.rotate[2] * DEG, 'XYZ');
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(...part.at), q, new THREE.Vector3(...part.size));
    g.applyMatrix4(m);
    // #rrggbb (checked by cleanCard), taken as the plain 0..1 values the trees and houses use,
    // so a colour reads the same on an object as it would on a roof.
    const rgb = [1, 3, 5].map((k) => parseInt(part.color.slice(k, k + 2), 16) / 255);
    const n = g.getAttribute('position').count;
    const colours = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colours.set(rgb, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    pieces.push(g);
  }
  if (!pieces.length) return null;
  const merged = mergeGeometries(pieces);
  for (const p of pieces) p.dispose();
  if (!merged) return null;
  // Whatever the recipe said, the object stands on the ground, centred, inside the unit cube.
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, box.max.y - box.min.y, 1e-3);
  const fit = span > 1 ? 1 / span : 1;
  merged.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  merged.scale(fit, fit, fit);
  return merged;
}

const vertex = /* glsl */ `
${GLSL_COMMON}
attribute vec3 color;
attribute float aPhase;
uniform float uMotion;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
void main() {
  vec3 q = position;
  float t = uTime + aPhase * 37.0;
  if (uMotion > 0.5 && uMotion < 1.5) {
    // Bob: rise and fall on the swell, with a little roll.
    float roll = 0.07 * sin(t * 1.3);
    q = vec3(q.x, q.y * cos(roll) - q.z * sin(roll), q.y * sin(roll) + q.z * cos(roll));
    q.y += 0.035 * sin(t * 1.7);
  } else if (uMotion > 1.5 && uMotion < 2.5) {
    // Sway: the top moves, the base stays.
    q.x += 0.06 * sin(t * 1.2) * q.y;
    q.z += 0.03 * sin(t * 0.9 + 1.0) * q.y;
  } else if (uMotion > 2.5 && uMotion < 3.5) {
    // Spin slowly about the vertical.
    float a = t * 0.5;
    q = vec3(q.x * cos(a) - q.z * sin(a), q.y, q.x * sin(a) + q.z * cos(a));
  } else if (uMotion > 3.5) {
    // Drift round a small loop.
    q.xz += vec2(cos(t * 0.21), sin(t * 0.17)) * 0.6;
  }
  vec4 world = modelMatrix * instanceMatrix * vec4(q, 1.0);
  vec2 site = tableUv(world.xz);
  vec4 a = fieldA(site);
  vec4 b = fieldB(site);
  vColor = color;
  vWorld = world.xyz;
  vTemperature = a.g;
  vRain = b.b;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragment = /* glsl */ `
${GLSL_COMMON}
uniform float uGlow;
uniform float uNight;
varying vec3 vColor;
varying vec3 vWorld;
varying float vTemperature;
varying float vRain;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (!gl_FrontFacing) n = -n;
  vec3 col = vColor;
  // Snow settles on upward faces when it is cold, as on the roofs and trees.
  float snow = smoothstep(uFreezing + 0.12, uFreezing - 0.05, vTemperature) * smoothstep(0.35, 0.8, n.y);
  col = mix(col, vec3(0.72, 0.76, 0.84), snow * 0.85);
  float overcast = 1.0 - 0.38 * vRain;
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 lit = col * (vec3(1.0, 0.94, 0.84) * 1.45 * ndl * overcast + vec3(0.50, 0.62, 0.85) * (0.42 + 0.2 * abs(n.y)));
  // Lit from within: bright enough to bloom, and brighter still at night so it carries.
  lit = mix(lit, col * (1.9 + 1.6 * uNight), uGlow * 0.85);
  gl_FragColor = vec4(lit, 1.0);
}
`;

interface Kind {
  def: CardDef;
  mesh: THREE.InstancedMesh;
  phase: THREE.InstancedBufferAttribute;
}

export class PropLayer {
  readonly group = new THREE.Group();
  private kinds = new Map<CardDef, Kind>();
  private placed: PlacedObject[] = [];
  private key = '';
  private placedAt = -Infinity;
  private matrix = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  /** Shared by every object: how dark the night is (0..1), so glowing things can carry through it. */
  readonly night = { value: 0 };

  constructor(private shared: SharedUniforms) {}

  /** Objects standing now (for the map and the numbers). */
  get objects(): readonly PlacedObject[] {
    return this.placed;
  }

  private kindFor(def: CardDef): Kind | null {
    let kind = this.kinds.get(def);
    if (kind) return kind;
    const geometry = buildPropGeometry(def);
    if (!geometry) return null;
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(MOST), 1);
    geometry.setAttribute('aPhase', phase);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        uMotion: { value: MOTIONS[def.prop!.motion] ?? 0 },
        uGlow: { value: def.prop!.glow ? 1 : 0 },
        uNight: this.night,
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, MOST);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    kind = { def, mesh, phase };
    this.kinds.set(def, kind);
    return kind;
  }

  /** Place and pose every object for this frame and these cards. */
  /**
   * @param live  true in the running app. Placing is not cheap and, while the world settles, it would
   *              be asked for on every frame: live, ten times a second is soon enough, and the last
   *              change is always placed. A still picture (a tile, a frozen moment) is placed at
   *              once, so the same cards always give the same picture.
   */
  update(frame: WorldFrame, cards: LiveCard[], live = false): void {
    // Placement depends on the world and where the cards are, not on how far they have faded in.
    const key = `${frame.version}|${frame.w}x${frame.h}|${cards.filter((c) => c.def.prop && c.strength > 0).map((c) => `${c.def.id}@${c.x.toFixed(4)},${c.y.toFixed(4)}`).join(';')}`;
    const now = performance.now();
    if (key !== this.key && (!live || now - this.placedAt >= 100)) {
      this.key = key;
      this.placedAt = now;
      this.placed = placeProps(frame, cards);
    } else {
      // Same places: only the growing in and out follows the cards.
      const byDef = new Map<CardDef, number>();
      for (const c of cards) if (c.def.prop) byDef.set(c.def, Math.max(byDef.get(c.def) ?? 0, c.strength));
      for (const o of this.placed) o.grow = byDef.get(o.def) ?? 0;
    }
    const counts = new Map<Kind, number>();
    for (const o of this.placed) {
      const kind = this.kindFor(o.def);
      if (!kind) continue;
      const n = counts.get(kind) ?? 0;
      if (n >= MOST) continue;
      const s = o.size * world.w * o.grow;
      // Afloat: the hull sits a little in the water. On land: a touch into the ground, like the houses.
      const sink = o.afloat ? 0.14 * s : 0.01;
      const y = o.ground * HSCALE + o.hover * world.w - sink;
      this.q.setFromAxisAngle(this.up, o.turn);
      this.matrix.compose(new THREE.Vector3((o.x - 0.5) * world.w, y, (o.y - 0.5) * world.d), this.q, new THREE.Vector3(s, s, s));
      kind.mesh.setMatrixAt(n, this.matrix);
      kind.phase.setX(n, o.phase);
      counts.set(kind, n + 1);
    }
    for (const kind of this.kinds.values()) {
      const n = counts.get(kind) ?? 0;
      kind.mesh.count = n;
      kind.mesh.visible = n > 0;
      if (n) {
        kind.mesh.instanceMatrix.needsUpdate = true;
        kind.phase.needsUpdate = true;
      }
    }
    // Forget kinds no longer in use (a card removed or read again), so memory stays level.
    if (this.kinds.size > 24) {
      for (const [def, kind] of this.kinds) {
        if (counts.has(kind)) continue;
        this.group.remove(kind.mesh);
        kind.mesh.geometry.dispose();
        (kind.mesh.material as THREE.Material).dispose();
        this.kinds.delete(def);
      }
    }
  }
}
