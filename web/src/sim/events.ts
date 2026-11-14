// Action cards: nukes, tsunamis and tornadoes. Each one happens once, when its
// card lands on the table, plays out over some seconds and leaves marks that
// heal with time (except a nuke's crater, which the land keeps).
//
// Events only run in real time (WorldSim.step), never in settleNow, so a settled
// world still depends on the standing cards alone.
import type { LiveCard } from '../cards/store';
import { modifierTargets, radiusMultiplier } from '../cards/modifiers';

export type EventKind = 'nuke' | 'tsunami' | 'tornado';

/** What the renderer needs to draw an event. Positions are table coordinates (0..1). */
export interface WorldEvent {
  kind: EventKind;
  key: string;
  x: number;
  y: number;
  age: number;
  duration: number;
  /** BIG makes it bigger. */
  scale: number;
  /** 0..1, how strong it is right now (tornadoes weaken; others fade at the end). */
  strength: number;
  /** Nuke: it boiled off water, so its cloud is white steam. Tornado: it is over water (a waterspout). */
  wet: boolean;
  /** Tsunami: where the wave started and how far its front has run (widths of the world). */
  ox: number;
  oy: number;
  front: number;
  /** Tornado: heading in radians. */
  heading: number;
}

export const EVENT_RULES = {
  heal: 90, // seconds for wrecked land to be rebuilt and regrown
  scorchHeal: 160,
  steamHeal: 14,
  nuke: { duration: 45, blast: 0.12, crater: 0.035, craterDepth: 0.035, winterHold: 20, winterFade: 25 },
  tsunami: { speed: 0.07, height: 0.03, fadeOver: 0.25, reach: 0.85, frozenDamping: 0.45, seaSearch: 0.4 },
  tornado: { duration: 28, speed: 0.035, radius: 0.022, hot: 0.25, cold: -0.2, highland: 0.18 },
};

/** What the events can see and change. All arrays are w x h. */
export interface EventWorld {
  w: number;
  h: number;
  aspect: number;
  inside: Uint8Array;
  height: Float32Array;
  temperature: Float32Array;
  waterSurface: Float32Array;
  seaLevel: number;
  /** Lasting ground shape (a crater is cut into it). */
  base: Float32Array;
  /** Out: 0..1 wrecked (houses, fields, trees, boats). Heals. */
  damage: Float32Array;
  /** Out: 0..1 burnt ground. Heals slowly. */
  scorch: Float32Array;
  /** Out: water level of a passing wave (0 = none). */
  surge: Float32Array;
  /** Out: 0..1 water boiled away. */
  steam: Float32Array;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

export class Events {
  readonly active: WorldEvent[] = [];
  /** 0..1 nuclear winter: the whole world turns cold for a while. */
  winter = 0;
  private seen = new Set<string>();

  /** Start events for newly placed cards, then advance everything. Returns true if the ground changed shape. */
  step(cards: LiveCard[], dt: number, world: EventWorld): boolean {
    const scales = new Map<LiveCard, number>();
    for (const [target, modifiers] of modifierTargets(cards)) scales.set(target, radiusMultiplier(modifiers));
    const present = new Set<string>();
    for (const card of cards) {
      if (card.def.kind !== 'event') continue;
      present.add(card.key);
      if (this.seen.has(card.key) || card.strength < 0.5) continue;
      this.seen.add(card.key);
      this.start(card.def.id as EventKind, card, scales.get(card) ?? 1, world);
    }
    // A card picked up and put down again is a new card (new key), so it fires again.
    for (const key of this.seen) if (!present.has(key)) this.seen.delete(key);

    const { damage, scorch, surge, steam } = world;
    const n = world.w * world.h;
    // Wrecked land is rebuilt, burnt land greens again, boiled water returns.
    const heal = dt / EVENT_RULES.heal;
    const scorchHeal = dt / EVENT_RULES.scorchHeal;
    const steamHeal = dt / EVENT_RULES.steamHeal;
    for (let i = 0; i < n; i++) {
      if (damage[i] > 0) damage[i] = Math.max(0, damage[i] - heal);
      if (scorch[i] > 0) scorch[i] = Math.max(0, scorch[i] - scorchHeal);
      if (steam[i] > 0) steam[i] = Math.max(0, steam[i] - steamHeal);
    }
    surge.fill(0);

    let reshaped = false;
    let winter = 0;
    for (const e of this.active) {
      e.age += dt;
      if (e.kind === 'nuke') {
        reshaped = this.nuke(e, world) || reshaped;
        const N = EVENT_RULES.nuke;
        winter = Math.max(winter, smoothstep(2, 6, e.age) * (1 - smoothstep(N.winterHold, N.winterHold + N.winterFade, e.age)) * Math.min(1, e.scale));
      } else if (e.kind === 'tsunami') this.tsunami(e, world);
      else this.tornado(e, dt, world);
    }
    this.winter = winter;
    for (let i = this.active.length - 1; i >= 0; i--) if (this.active[i].age >= this.active[i].duration) this.active.splice(i, 1);
    return reshaped;
  }

  get busy(): boolean {
    return this.active.length > 0;
  }

  private start(kind: EventKind, card: LiveCard, scale: number, world: EventWorld): void {
    const e: WorldEvent = {
      kind, key: card.key, x: card.x, y: card.y, age: 0, duration: 10, scale, strength: 1, wet: false,
      ox: card.x, oy: card.y, front: 0, heading: hash(card.key) * Math.PI * 2,
    };
    if (kind === 'nuke') {
      e.duration = EVENT_RULES.nuke.duration;
    } else if (kind === 'tornado') {
      e.duration = EVENT_RULES.tornado.duration;
    } else {
      // The wave comes in from the nearest sea. With no sea nearby, a wall of water rises on the spot.
      const T = EVENT_RULES.tsunami;
      const sea = this.nearestSea(world, card.x, card.y, T.seaSearch);
      e.strength = sea ? 1 : 0.55;
      if (sea) [e.ox, e.oy] = sea;
      // An ice-bound sea damps the wave.
      const t = this.sample(world, world.temperature, e.ox, e.oy);
      if (t < -0.3) e.strength *= T.frozenDamping;
      e.duration = T.reach / T.speed;
    }
    this.active.push(e);
  }

  /** Distance between two table points, in widths of the world. */
  private dist(world: EventWorld, ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(ax - bx, (ay - by) / world.aspect);
  }

  private sample(world: EventWorld, field: Float32Array, x: number, y: number): number {
    const i = Math.round(Math.min(1, Math.max(0, y)) * (world.h - 1)) * world.w + Math.round(Math.min(1, Math.max(0, x)) * (world.w - 1));
    return field[i];
  }

  private nearestSea(world: EventWorld, x: number, y: number, within: number): [number, number] | null {
    let best: [number, number] | null = null;
    let bestD = within;
    for (let j = 0; j < world.h; j += 2) {
      for (let i = 0; i < world.w; i += 2) {
        const k = j * world.w + i;
        if (!world.inside[k] || world.height[k] >= world.seaLevel) continue;
        const u = i / (world.w - 1);
        const v = j / (world.h - 1);
        const d = this.dist(world, u, v, x, y);
        if (d < bestD) {
          bestD = d;
          best = [u, v];
        }
      }
    }
    return best;
  }

  /** Visit every cell within `radius` (widths) of (x, y). */
  private around(world: EventWorld, x: number, y: number, radius: number, visit: (k: number, d: number) => void): void {
    const { w, h } = world;
    const rx = radius * (w - 1);
    const ry = radius * world.aspect * (h - 1);
    const i0 = Math.max(0, Math.floor(x * (w - 1) - rx));
    const i1 = Math.min(w - 1, Math.ceil(x * (w - 1) + rx));
    const j0 = Math.max(0, Math.floor(y * (h - 1) - ry));
    const j1 = Math.min(h - 1, Math.ceil(y * (h - 1) + ry));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * w + i;
        if (!world.inside[k]) continue;
        const d = this.dist(world, i / (w - 1), j / (h - 1), x, y);
        if (d <= radius) visit(k, d);
      }
    }
  }

  /** Flash, blast, crater, boiled water; the winter is handled by the caller. */
  private nuke(e: WorldEvent, world: EventWorld): boolean {
    const N = EVENT_RULES.nuke;
    e.strength = 1 - smoothstep(e.duration - 8, e.duration, e.age);
    if (e.age < 0.25 || e.front > 0) return false;
    e.front = 1; // the blast happens once
    const R = N.blast * e.scale;
    const cr = N.crater * e.scale;
    let water = 0;
    this.around(world, e.x, e.y, R * 1.6, (k, d) => {
      world.damage[k] = Math.max(world.damage[k], smoothstep(R * 1.6, R * 0.5, d));
      world.scorch[k] = Math.max(world.scorch[k], smoothstep(R * 1.1, R * 0.2, d));
      if (d < R && world.waterSurface[k] - world.height[k] > 0.002) {
        world.steam[k] = Math.max(world.steam[k], smoothstep(R, R * 0.3, d));
        water++;
      }
      // The crater: a bowl with a low rim. The land keeps it.
      const bowl = Math.exp(-((d / cr) ** 2));
      const rim = Math.exp(-(((d - cr * 1.35) / (cr * 0.45)) ** 2));
      world.base[k] += -N.craterDepth * Math.sqrt(e.scale) * bowl + 0.008 * Math.sqrt(e.scale) * rim;
    });
    e.wet = water > 12;
    return true;
  }

  /** A ring of water runs out from the sea, floods what is low enough and drains away behind. */
  private tsunami(e: WorldEvent, world: EventWorld): void {
    const T = EVENT_RULES.tsunami;
    e.front = e.age * T.speed;
    const amp = T.height * e.strength * Math.sqrt(e.scale);
    const sea = world.seaLevel;
    const r = e.front;
    this.around(world, e.ox, e.oy, Math.min(T.reach, r + 0.04), (k, d) => {
      const band = smoothstep(r + 0.04, r, d) * (0.3 + 0.7 * Math.exp(-Math.max(0, r - d) * 6));
      const level = sea + amp * Math.exp(-d / (T.fadeOver * e.scale)) * band;
      const ground = world.height[k];
      const over = level - Math.max(ground, world.waterSurface[k]);
      if (over <= 0) return;
      world.surge[k] = Math.max(world.surge[k], level);
      // Deep enough water wrecks what it reaches: houses, fields, trees, boats.
      world.damage[k] = Math.max(world.damage[k], 0.95 * smoothstep(0.004, 0.025, level - ground) * smoothstep(0.0, 0.006, over));
    });
    e.strength = Math.min(e.strength, 1 - smoothstep(e.duration - 3, e.duration, e.age) * 0.999);
  }

  /** A funnel wanders the land, fed by heat, weakened by cold and broken up by high ground. */
  private tornado(e: WorldEvent, dt: number, world: EventWorld): void {
    const T = EVENT_RULES.tornado;
    const t = this.sample(world, world.temperature, e.x, e.y);
    const ground = this.sample(world, world.height, e.x, e.y);
    const water = this.sample(world, world.waterSurface, e.x, e.y) - ground > 0.002;
    e.wet = water;
    let target = t > T.hot ? 1.35 : t < T.cold ? 0.45 : 1;
    if (ground > T.highland) target *= 0.25;
    const life = smoothstep(0, 2, e.age) * (1 - smoothstep(e.duration - 4, e.duration, e.age));
    // Strength eases toward what the ground under it allows; once spent, it is gone.
    const ease = 1 - Math.exp(-dt / 2.5);
    const base = e.strength + (target - e.strength) * ease;
    e.strength = base;
    if (base < 0.15 && e.age > 3) e.duration = Math.min(e.duration, e.age + 3);

    // Wander: a slow random turn, and turn back at the edge of the world.
    e.heading += (Math.sin(e.age * 0.7 + hash(e.key) * 40) * 0.9 + Math.sin(e.age * 1.9) * 0.4) * dt;
    const step = T.speed * dt * (0.6 + 0.4 * base);
    let nx = e.x + Math.cos(e.heading) * step;
    let ny = e.y + Math.sin(e.heading) * step * world.aspect;
    const k = Math.round(Math.min(1, Math.max(0, ny)) * (world.h - 1)) * world.w + Math.round(Math.min(1, Math.max(0, nx)) * (world.w - 1));
    if (nx < 0.02 || nx > 0.98 || ny < 0.02 || ny > 0.98 || !world.inside[k]) {
      e.heading += Math.PI * 0.8;
      nx = e.x;
      ny = e.y;
    }
    e.x = nx;
    e.y = ny;

    const power = base * life;
    const radius = T.radius * e.scale * (0.7 + 0.5 * base);
    this.around(world, e.x, e.y, radius * 1.5, (k, d) => {
      const onWater = world.waterSurface[k] - world.height[k] > 0.002;
      // A waterspout only troubles boats; on land it tears up everything in its path.
      if (onWater !== water && onWater) return;
      world.damage[k] = Math.max(world.damage[k], power * smoothstep(radius * 1.5, radius * 0.4, d));
    });
  }
}
