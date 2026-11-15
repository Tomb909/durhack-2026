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
import { MAX_PRIMITIVES } from '../cards/words';
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

const smooth = (lo: number, hi: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * A box with its edges cut off, so every edge catches the light as its own thin face. The cut is
 * the same width on every side whatever the box's proportions, so it is worked out at the part's
 * real size and brought back to the unit cube.
 */
function bevelledBox(size: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  const r = Math.min(0.03, 0.16 * Math.min(...size));
  const pos = g.getAttribute('position');
  const p = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    let far = 0;
    for (let k = 0; k < 3; k++) {
      const half = size[k] / 2;
      const inner = half - r;
      // The grid's rows: the face, the start of the cut, the middle.
      const u = pos.getComponent(i, k);
      const v = Math.abs(u) > 0.49 ? Math.sign(u) * half : Math.abs(u) > 0.2 ? Math.sign(u) * inner : 0;
      const c = Math.min(inner, Math.max(-inner, v));
      p[k] = v - c;
      far += p[k] * p[k];
      pos.setComponent(i, k, c);
    }
    const out = far > 0 ? r / Math.sqrt(far) : 0;
    for (let k = 0; k < 3; k++) pos.setComponent(i, k, (pos.getComponent(i, k) + p[k] * out) / size[k]);
  }
  return g;
}

/** One part's shape in a unit cube about the origin; the part's size is applied afterwards. */
function primitive(part: PropPart): THREE.BufferGeometry {
  const [w, h, d] = part.size;
  const taper = part.taper ?? 1;
  switch (part.shape) {
    case 'box': {
      const g = bevelledBox(part.size);
      if (taper !== 1) {
        const pos = g.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          const k = 1 + (taper - 1) * (pos.getY(i) + 0.5);
          pos.setX(i, pos.getX(i) * k);
          pos.setZ(i, pos.getZ(i) * k);
        }
      }
      return g;
    }
    case 'cylinder': return new THREE.CylinderGeometry(0.5 * taper, 0.5, 1, 12, 2);
    case 'cone': return new THREE.ConeGeometry(0.5, 1, 12, 2);
    // Four sides, turned so the square base lines up with x and z and fills the unit square.
    case 'pyramid': return new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 2).rotateY(Math.PI / 4);
    case 'prism': return prism();
    case 'sphere': return new THREE.IcosahedronGeometry(0.5, 2);
    case 'capsule': {
      // Round ends that stay round: worked out at the part's real size.
      const r = (w + d) / 4;
      const straight = Math.max(0, h - 2 * r);
      const g = new THREE.CapsuleGeometry(r, straight, 3, 12);
      return g.scale(1 / (2 * r), 1 / (straight + 2 * r), 1 / (2 * r));
    }
    // The top half of a ball, filling the cube: a helmet, a cap, an igloo.
    case 'dome': return new THREE.SphereGeometry(0.5, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, -0.25, 0).scale(1, 2, 1);
    case 'ring': {
      // Lying flat. The height of the part is how thick the band is.
      const t = Math.min(0.25, Math.max(0.03, h / (w + d)));
      return new THREE.TorusGeometry(0.5 - t, t, 6, 18).rotateX(Math.PI / 2).scale(1, 1 / (2 * t), 1);
    }
  }
}

const DEG = Math.PI / 180;
const FLIP_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const FLIP_Z = new THREE.Matrix4().makeScale(1, 1, -1);

/** Where each copy of a part goes: round the upright axis (repeat), then across the middle (mirror). */
export function partMatrices(part: PropPart): THREE.Matrix4[] {
  const base = new THREE.Matrix4().compose(
    new THREE.Vector3(...part.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(part.rotate[0] * DEG, part.rotate[1] * DEG, part.rotate[2] * DEG, 'XYZ')),
    new THREE.Vector3(...part.size),
  );
  const n = part.repeat ?? 1;
  const out: THREE.Matrix4[] = [];
  for (let k = 0; k < n; k++) out.push(new THREE.Matrix4().makeRotationY((k / n) * Math.PI * 2).multiply(base));
  // Every shape is the same left to right and front to back, so flipping before and after
  // mirrors where a part stands and how it leans without turning its faces inside out.
  const flip = (list: THREE.Matrix4[], f: THREE.Matrix4) => list.map((m) => f.clone().multiply(m).multiply(f));
  if (part.mirror === 'x' || part.mirror === 'xz') out.push(...flip(out, FLIP_X));
  if (part.mirror === 'z' || part.mirror === 'xz') out.push(...flip(out, FLIP_Z));
  return out;
}

/** How near a point (in a part's own unit cube) is to that part: 1 on its surface, less inside. */
function nearness(shape: PropPart['shape'], x: number, y: number, z: number): number {
  const round = 2 * Math.hypot(x, z);
  if (shape === 'box' || shape === 'prism' || shape === 'pyramid') return 2 * Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (shape === 'cylinder' || shape === 'cone' || shape === 'ring') return Math.max(round, 2 * Math.abs(y));
  return 2 * Math.hypot(x, y, z);
}

/**
 * One merged geometry for a card's object, standing on y = 0 and filling the unit cube. Each
 * corner also carries `aShade`: darker towards the ground and in the creases where parts meet,
 * worked out once here so the picture has depth at no cost per frame.
 */
export function buildPropGeometry(def: CardDef): THREE.BufferGeometry | null {
  const parts = def.prop?.parts ?? [];
  const pieces: THREE.BufferGeometry[] = [];
  const placed: { shape: PropPart['shape']; inverse: THREE.Matrix4; centre: THREE.Vector3; reach: number }[] = [];
  for (const part of parts) {
    // #rrggbb (checked by cleanCard), taken as the plain 0..1 values the trees and houses use,
    // so a colour reads the same on an object as it would on a roof.
    const rgb = [1, 3, 5].map((k) => parseInt(part.color.slice(k, k + 2), 16) / 255);
    const shape = primitive(part);
    for (const m of partMatrices(part)) {
      if (pieces.length >= MAX_PRIMITIVES) break;
      let g = shape.clone();
      g = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
      g.applyMatrix4(m);
      const n = g.getAttribute('position').count;
      const colours = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) colours.set(rgb, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      placed.push({
        shape: part.shape, inverse: m.clone().invert(),
        centre: new THREE.Vector3().setFromMatrixPosition(m),
        reach: 0.5 * Math.hypot(...part.size) * Math.max(1, part.taper ?? 1),
      });
      pieces.push(g);
    }
    shape.dispose();
  }
  if (!pieces.length) return null;

  // Creases: a corner close to another part is in that part's shade.
  const v = new THREE.Vector3();
  const local = new THREE.Vector3();
  const shades: Float32Array[] = pieces.map((g, k) => {
    const pos = g.getAttribute('position');
    const shade = new Float32Array(pos.count).fill(1);
    const me = placed[k];
    const others = placed.filter((o, j) => j !== k && o.centre.distanceTo(me.centre) < (o.reach + me.reach) * 1.2);
    for (let i = 0; i < pos.count && others.length; i++) {
      v.fromBufferAttribute(pos, i);
      let open = 1;
      for (const o of others) {
        local.copy(v).applyMatrix4(o.inverse);
        open *= 1 - 0.42 * smooth(1.5, 0.98, nearness(o.shape, local.x, local.y, local.z));
      }
      shade[i] = Math.max(0.42, open);
    }
    return shade;
  });

  const merged = mergeGeometries(pieces);
  for (const p of pieces) p.dispose();
  if (!merged) return null;
  // Whatever the recipe said, the object stands on the ground, centred, and its longest side is
  // exactly one: how big it is drawn is then decided by its scale alone, not by how much of the
  // cube the recipe happened to fill.
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, box.max.y - box.min.y, 1e-3);
  merged.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  merged.scale(1 / span, 1 / span, 1 / span);
  // Darker towards the ground, where less of the sky reaches. Not for things in the air.
  const pos = merged.getAttribute('position');
  const all = new Float32Array(pos.count);
  const grounded = def.prop?.habitat !== 'air';
  let at = 0;
  for (const shade of shades) for (const s of shade) {
    all[at] = s * (grounded ? 0.7 + 0.3 * smooth(0, 0.32, pos.getY(at)) : 1);
    at++;
  }
  merged.setAttribute('aShade', new THREE.BufferAttribute(all, 1));
  merged.computeBoundingBox();
  return merged;
}

const vertex = /* glsl */ `
${GLSL_COMMON}
attribute vec3 color;
attribute float aPhase;
attribute float aShade;
uniform float uMotion;
varying vec3 vColor;
varying float vShade;
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
  vShade = aShade;
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
varying float vShade;
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
  // Depth: creases and the foot of the object get less sky and a little less sun (vShade, baked
  // with the geometry); undersides get less sky than tops; edges turned away from the eye pick
  // up a thin rim of sky, which lifts the object off the ground behind it.
  vec3 sky = vec3(0.50, 0.62, 0.85);
  float rim = pow(1.0 - max(dot(n, normalize(cameraPosition - vWorld)), 0.0), 3.0);
  vec3 lit = col * (vec3(1.0, 0.94, 0.84) * 1.5 * ndl * overcast * (0.45 + 0.55 * vShade)
    + sky * (0.30 + 0.30 * (0.5 + 0.5 * n.y)) * vShade
    + sky * 0.28 * rim * (0.4 + 0.6 * max(n.y, 0.0)));
  // Lit from within: bright enough to bloom, and brighter still at night so it carries.
  lit = mix(lit, col * (1.9 + 1.6 * uNight), uGlow * 0.85);
  gl_FragColor = vec4(lit, 1.0);
}
`;

// The soft dark patch under each object, which is most of what makes it sit on the ground
// instead of floating in front of it. A small flat grid laid over the land's own heights.
const MOST_SHADOWS = 256;
const shadowVertex = /* glsl */ `
${GLSL_COMMON}
attribute vec4 aSpot; // centre x and z (scene units), radius, darkness
attribute float aFloor; // the water it floats on (scene units), or far below for things on land
varying vec2 vAt;
varying float vDark;
void main() {
  vec2 xz = aSpot.xy + position.xz * aSpot.z;
  vec2 uv = tableUv(xz);
  float ground = (fieldA(uv).r - 0.004 * fieldB(uv).g) * HSCALE;
  vAt = position.xz;
  vDark = aSpot.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, max(ground, aFloor) + 0.012, xz.y, 1.0);
}
`;
const shadowFragment = /* glsl */ `
varying vec2 vAt;
varying float vDark;
void main() {
  float fade = 1.0 - smoothstep(0.15, 1.0, length(vAt));
  gl_FragColor = vec4(0.05, 0.07, 0.13, vDark * fade * fade);
}
`;

interface Kind {
  def: CardDef;
  mesh: THREE.InstancedMesh;
  phase: THREE.InstancedBufferAttribute;
  /** Of the unit cube the object fills: how wide it stands and how tall. */
  foot: number;
  tall: number;
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
  private shadows: THREE.Mesh;
  private spot = new THREE.InstancedBufferAttribute(new Float32Array(MOST_SHADOWS * 4), 4);
  private floor = new THREE.InstancedBufferAttribute(new Float32Array(MOST_SHADOWS), 1);

  constructor(private shared: SharedUniforms) {
    const flat = new THREE.PlaneGeometry(2, 2, 6, 6).rotateX(-Math.PI / 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(flat.index);
    geometry.setAttribute('position', flat.getAttribute('position'));
    geometry.setAttribute('aSpot', this.spot);
    geometry.setAttribute('aFloor', this.floor);
    geometry.instanceCount = 0;
    this.shadows = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: { ...shared }, vertexShader: shadowVertex, fragmentShader: shadowFragment,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }));
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 3; // after the water, so a boat's shadow lies on it
    this.group.add(this.shadows);
  }

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
    const box = geometry.boundingBox!;
    kind = { def, mesh, phase, foot: Math.max(box.max.x - box.min.x, box.max.z - box.min.z), tall: box.max.y };
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
    const sun = this.shared.uSunDir.value;
    const away = Math.hypot(sun.x, sun.z) || 1;
    let shadows = 0;
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
      // Its shadow: under it and a little away from the sun, wider for wide things. Nothing for
      // an object that drifts about (the shadow would be left behind).
      if (shadows < MOST_SHADOWS && o.def.prop!.motion !== 'drift' && o.grow > 0) {
        const lean = 0.22 * s * kind.tall / away;
        const high = o.hover > 0;
        this.spot.setXYZW(
          shadows, (o.x - 0.5) * world.w - sun.x * lean, (o.y - 0.5) * world.d - sun.z * lean,
          s * (0.34 + 0.52 * kind.foot) * (high ? 0.8 : 1), Math.min(1, o.grow) * (high ? 0.22 : o.afloat ? 0.3 : 0.5),
        );
        this.floor.setX(shadows, o.afloat ? o.ground * HSCALE : -1e3);
        shadows++;
      }
    }
    (this.shadows.geometry as THREE.InstancedBufferGeometry).instanceCount = shadows;
    this.shadows.visible = shadows > 0;
    this.spot.needsUpdate = true;
    this.floor.needsUpdate = true;
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
