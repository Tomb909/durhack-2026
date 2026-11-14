// The world's rules. No Three.js in here: cards in, fields out.
//
// Cards never change the world directly. They push on five properties
// (height, temperature, wetness, sea level, life) and everything you see is
// derived from those. There are no card-pair special cases anywhere.
import type { FieldName } from '../cards/defs';
import { heightMultiplier, modifierTargets, radiusMultiplier } from '../cards/modifiers';
import type { LiveCard } from '../cards/store';
import { Hydrology, type HydrologyRules } from './hydrology';
import { fbm, ridged } from './noise';

/** Grid width. The height follows the play area's proportions. */
export const GW = 192;
export const A3_ASPECT = 420 / 297;

/** The play area's shape: proportions (long / short side) and outline (points 0..1, x right, y near). */
export interface WorldShape {
  aspect: number;
  outline: number[][];
}

export const RECT_OUTLINE = [[0, 0], [1, 0], [1, 1], [0, 1]];
export const DEFAULT_SHAPE: WorldShape = { aspect: A3_ASPECT, outline: RECT_OUTLINE };

/** Shapes to try without a camera (S key). */
export const SHAPE_PRESETS: Record<'rect' | 'circle' | 'blob', WorldShape> = {
  rect: DEFAULT_SHAPE,
  circle: {
    aspect: 1,
    outline: Array.from({ length: 96 }, (_, k) => {
      const a = (k / 96) * Math.PI * 2;
      return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
    }),
  },
  blob: (() => {
    const raw = Array.from({ length: 120 }, (_, k) => {
      const a = (k / 120) * Math.PI * 2;
      const r = 1 + 0.16 * Math.sin(3 * a + 0.6) + 0.09 * Math.cos(5 * a - 1.1) + 0.05 * Math.sin(7 * a);
      return [r * Math.cos(a) * 1.35, r * Math.sin(a)];
    });
    const xs = raw.map((p) => p[0]);
    const ys = raw.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { aspect: (x1 - x0) / (y1 - y0), outline: raw.map(([x, y]) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)]) };
  })(),
};

/** Distance from (x, y) to the outline (in play-area units, 0..1 each way), and whether it is inside. */
export function outlineDistance(outline: number[][], x: number, y: number): { inside: boolean; distance: number } {
  let inside = false;
  let best = Infinity;
  for (let a = 0, b = outline.length - 1; a < outline.length; b = a++) {
    const [ax, ay] = outline[a];
    const [bx, by] = outline[b];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    const ex = bx - ax;
    const ey = by - ay;
    const len = ex * ex + ey * ey;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * ex, y - ay - t * ey));
  }
  return { inside, distance: best };
}

/** True when two shapes differ enough to rebuild the world: proportions by >3% or the outline moved. */
export function shapesDiffer(a: WorldShape, b: WorldShape, moved = 0.025): boolean {
  if (Math.abs(a.aspect - b.aspect) / b.aspect > 0.03) return true;
  const far = (p: number[][], q: number[][]) => p.some(([x, y]) => outlineDistance(q, x, y).distance > moved);
  return far(a.outline, b.outline) || far(b.outline, a.outline);
}

/** Grid height for a shape's proportions (136 for A3). */
export const gridHeight = (aspect: number) => Math.round((GW - 1) / aspect) + 1;
/** Grid height of the default (A3) world. Shaped worlds use `sim.h` / `frame.h` instead. */
export const GH = gridHeight(A3_ASPECT);

/**
 * Signed distance (in cells, positive inside) from every cell to the outline.
 * Cell (i, j) sits at (i / (w-1), j / (h-1)) on the play area.
 */
export function shapeDistance(outline: number[][], w: number, h: number): Float32Array {
  const px = outline.map((p) => p[0] * (w - 1));
  const py = outline.map((p) => p[1] * (h - 1));
  const m = px.length;
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let best = Infinity;
      let inside = false;
      for (let a = 0, b = m - 1; a < m; b = a++) {
        const ax = px[a], ay = py[a], bx = px[b], by = py[b];
        if ((ay > j) !== (by > j) && i < ((bx - ax) * (j - ay)) / (by - ay) + ax) inside = !inside;
        const ex = bx - ax, ey = by - ay;
        const len = ex * ex + ey * ey;
        const t = len > 0 ? Math.max(0, Math.min(1, ((i - ax) * ex + (j - ay) * ey) / len)) : 0;
        const dx = i - ax - t * ex, dy = j - ay - t * ey;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      const d = Math.sqrt(best);
      out[j * w + i] = inside ? d : -d;
    }
  }
  return out;
}

/** Every tunable number in one place. */
export const RULES = {
  /** Copies of a card add up, then level off around this many copies. */
  copiesCeiling: 3.2,
  seaCopiesCeiling: 4.5,
  seaBase: 0.0,
  /** The empty world: gentle hills, all of it above the sea. */
  landLow: 0.022, // height of the lowest hollow (the sea starts below it)
  landRelief: 0.07, // from the lowest hollow to the highest hilltop
  lowlandBias: 1.3, // above 1 = more low ground than high, so floods spread
  /** Temperature runs from -1 (frozen) through 0 (mild) to +1 (scorching). */
  lapse: 1.15, // how much colder it gets per unit of height
  lapseStartsAt: 0.08,
  wetBase: 0.22,
  evaporation: 0.35, // heat dries the land
  wetNearWater: 0.18, // land beside open water is damper
  rainStart: 0.42, // wetness at which it starts to rain
  rainFull: 0.85,
  freezing: -0.3, // below this, rain is snow and water is ice
  plantWetMin: 0.25,
  plantWetGood: 0.5,
  plantColdLimit: -0.45,
  plantColdGood: -0.2,
  settleSeconds: 0.35, // how fast rivers and lakes ease to their new shape
  /** Land beside water is damper, which can move the water again. Look this many times at most. */
  settlePasses: 12,
  hydrology: {
    riverStart: 90,
    riverFull: 420,
    lakeStart: 130,
    lakeFull: 420,
    lakeMinDepth: 0.0012,
    riverDepth: 0.004,
    dryOffset: 0.004,
  } satisfies HydrologyRules,
};

/** What the renderer receives. All arrays are w x h, row 0 = far edge. */
export interface WorldFrame {
  w: number;
  h: number;
  height: Float32Array;
  temperature: Float32Array;
  wetness: Float32Array;
  /** 0..1: how much plant cover. */
  vegetation: Float32Array;
  /** Height of the water surface. Below `height` where the land is dry. */
  waterSurface: Float32Array;
  /** 0..1 river strength. */
  river: Float32Array;
  /** 0..1 rain or snow falling here. */
  precipitation: Float32Array;
  /** Signed distance to the play area's outline in cells, positive inside. */
  mask: Float32Array;
  /** Long / short side. */
  aspect: number;
  outline: number[][];
  seaLevel: number;
  /** Increases whenever the arrays change. */
  version: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const softCap = (x: number, ceiling: number) => ceiling * Math.tanh(x / ceiling);

type LocalField = Exclude<FieldName, 'seaLevel'>;

export class WorldSim {
  readonly frame: WorldFrame;
  readonly shape: WorldShape;
  readonly w = GW;
  readonly h: number;
  private n: number;
  private aspect: number;
  /** 1 for cells inside the play area. */
  private inside: Uint8Array;
  private base: Float32Array;
  private ridge: Float32Array;
  private rough: Float32Array;
  /** Summed card pushes per property (after the copies ceiling). */
  private push: Record<LocalField, Float32Array>;
  private copies: Float32Array;
  private surfaceTarget: Float32Array;
  private riverTarget: Float32Array;
  private nearWater: Float32Array;
  private scratch: Float32Array;
  private hydrology: Hydrology;
  private lastSurface: Float32Array;
  private lastRiver: Float32Array;
  private settle = 0;
  private passesLeft = 0;
  private started = false;

  constructor(shape: WorldShape = DEFAULT_SHAPE) {
    this.shape = shape;
    const aspect = (this.aspect = shape.aspect);
    const w = this.w;
    const h = (this.h = gridHeight(aspect));
    const n = (this.n = w * h);
    const f = () => new Float32Array(n);
    this.base = f(); this.ridge = f(); this.rough = f();
    this.push = { height: f(), temperature: f(), wetness: f(), life: f() };
    this.copies = f(); this.surfaceTarget = f(); this.riverTarget = f(); this.nearWater = f(); this.scratch = f();
    this.lastSurface = f(); this.lastRiver = f();
    this.hydrology = new Hydrology(w, h);
    const mask = shapeDistance(shape.outline, w, h);
    this.inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.inside[i] = mask[i] >= -0.01 ? 1 : 0;
    this.frame = {
      w, h,
      height: f(), temperature: f(), wetness: f(),
      vegetation: f(), waterSurface: f(), river: f(),
      precipitation: f(), mask, aspect, outline: shape.outline, seaLevel: RULES.seaBase, version: 0,
    };
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const u = i / (w - 1);
        const v = j / (h - 1);
        const X = u * aspect;
        const Y = v;
        const k = j * w + i;
        // Light rolling hills (scaled below so the lowest point sits just above the sea).
        this.base[k] = fbm(X * 1.9, Y * 1.9, 4, 11);
        this.ridge[k] = ridged(X * 3.4, Y * 3.4, 5, 5);
        this.rough[k] = fbm(X * 9, Y * 9, 2, 23) - 0.5;
      }
    }
    let lowest = Infinity;
    let highest = -Infinity;
    for (let k = 0; k < n; k++) {
      lowest = Math.min(lowest, this.base[k]);
      highest = Math.max(highest, this.base[k]);
    }
    for (let k = 0; k < n; k++) {
      const t = (this.base[k] - lowest) / (highest - lowest);
      this.base[k] = RULES.landLow + RULES.landRelief * Math.pow(t, RULES.lowlandBias);
    }
  }

  /** Advance the world. Call every frame with the smoothed card list. */
  step(cards: LiveCard[], cardsMoving: boolean, dt: number): WorldFrame {
    if (cardsMoving || !this.started) {
      this.recompute(cards);
      this.settle = RULES.settleSeconds * 5;
      this.passesLeft = RULES.settlePasses;
      if (!this.started) {
        this.frame.waterSurface.set(this.surfaceTarget);
        this.frame.river.set(this.riverTarget);
        this.started = true;
      }
    }
    if (this.settle > 0) {
      this.settle -= dt;
      const k = 1 - Math.exp(-dt / RULES.settleSeconds);
      const { waterSurface, river } = this.frame;
      const st = this.surfaceTarget;
      const rt = this.riverTarget;
      for (let i = 0; i < this.n; i++) {
        waterSurface[i] += (st[i] - waterSurface[i]) * k;
        river[i] += (rt[i] - river[i]) * k;
      }
      // The water has arrived. Land beside it is damper now, which may move the
      // water again, so look once more and keep going until nothing changes.
      // Without this the world would stop wherever the animation happened to be.
      if (this.settle <= 0 && this.passesLeft-- > 0 && this.refine(cards)) this.settle = RULES.settleSeconds * 5;
      this.frame.version++;
    }
    return this.frame;
  }

  /**
   * Jump straight to the settled state: what the cards alone give, starting
   * from a dry world. Depends on nothing that came before, so the same cards
   * always give the same world. The live loop (`step`) ends up here too.
   */
  settleNow(cards: LiveCard[]): WorldFrame {
    this.started = false; // forget the old water
    this.recompute(cards);
    this.started = true;
    for (let i = 0; i < RULES.settlePasses; i++) if (!this.refine(cards)) break;
    this.frame.waterSurface.set(this.surfaceTarget);
    this.frame.river.set(this.riverTarget);
    this.settle = 0;
    this.passesLeft = 0;
    this.frame.version++;
    return this.frame;
  }

  /** Let the water reach its target and work the world out again. True if that moved the water. */
  private refine(cards: LiveCard[]): boolean {
    const { n, frame, surfaceTarget, riverTarget, lastSurface, lastRiver } = this;
    lastSurface.set(surfaceTarget);
    lastRiver.set(riverTarget);
    frame.waterSurface.set(surfaceTarget);
    frame.river.set(riverTarget);
    this.recompute(cards);
    for (let i = 0; i < n; i++) {
      if (Math.abs(surfaceTarget[i] - lastSurface[i]) > 1e-6 || Math.abs(riverTarget[i] - lastRiver[i]) > 1e-6) return true;
    }
    return false;
  }

  private recompute(cards: LiveCard[]): void {
    const { n, frame, push } = this;
    for (const key of Object.keys(push) as LocalField[]) push[key].fill(0);

    const modifiersByTarget = modifierTargets(cards);
    const radiusMultipliers = new Map<LiveCard, number>();
    for (const [target, modifiers] of modifiersByTarget) {
      radiusMultipliers.set(target, radiusMultiplier(modifiers));
    }

    // --- 1. gather card pushes. Copies of the same card add up, then level off.
    let sea = RULES.seaBase;
    const groups = new Map<string, LiveCard[]>();
    for (const card of cards) {
      if (card.strength <= 0) continue;
      const list = groups.get(card.def.id);
      if (list) list.push(card);
      else groups.set(card.def.id, [card]);
    }
    for (const group of groups.values()) {
      const def = group[0].def;
      for (const effect of def.effects) {
        if (effect.global || effect.field === 'seaLevel') {
          let total = 0;
          for (const card of group) total += card.strength;
          if (effect.field === 'seaLevel') sea += effect.amount * softCap(total, RULES.seaCopiesCeiling);
          continue;
        }
        const target = push[effect.field as LocalField];
        if (!target) continue;
        const byRadius = new Map<number, Map<number, LiveCard[]>>();
        for (const card of group) {
          const radius = (effect.radius ?? 0.2) * (radiusMultipliers.get(card) ?? 1);
          const amountMultiplier = effect.field === 'height'
            ? heightMultiplier(modifiersByTarget.get(card) ?? [])
            : 1;
          let byAmount = byRadius.get(radius);
          if (!byAmount) byRadius.set(radius, (byAmount = new Map()));
          const sameEffect = byAmount.get(amountMultiplier);
          if (sameEffect) sameEffect.push(card);
          else byAmount.set(amountMultiplier, [card]);
        }
        for (const [radius, byAmount] of byRadius) {
          for (const [amountMultiplier, radiusGroup] of byAmount) {
            this.addCopies(radiusGroup, radius);
            const copies = this.copies;
            const ceiling = RULES.copiesCeiling;
            for (let i = 0; i < n; i++) {
              if (copies[i] > 0) {
                target[i] += effect.amount * amountMultiplier * ceiling * Math.tanh(copies[i] / ceiling);
              }
            }
          }
        }
      }
    }
    frame.seaLevel = sea;

    // --- 2. where is there open water right now? (from the last result)
    this.updateNearWater();

    // --- 3. derive everything from the five properties
    const { height, temperature, wetness, vegetation, precipitation } = frame;
    for (let i = 0; i < n; i++) {
      const lift = push.height[i];
      // Ridged noise carves the lift into peaks and valleys; the middle of a range rises steepest.
      const peak = 0.72 + 0.5 * smoothstep(0.0, 0.5, lift);
      const h = this.base[i] + lift * peak * (0.38 + 0.62 * this.ridge[i]) + lift * 0.14 * this.rough[i];
      height[i] = h;

      const altitude = Math.max(0, h - RULES.lapseStartsAt);
      const t = Math.max(-1, Math.min(1, push.temperature[i] - RULES.lapse * altitude));
      temperature[i] = t;

      const wet = Math.max(0, Math.min(1,
        RULES.wetBase + push.wetness[i] - RULES.evaporation * Math.max(0, t) + RULES.wetNearWater * this.nearWater[i]));
      wetness[i] = wet;

      precipitation[i] = this.inside[i] ? smoothstep(RULES.rainStart, RULES.rainFull, wet) : 0;
    }

    // --- 4. water on land
    this.hydrology.compute(height, sea, precipitation, this.surfaceTarget, this.riverTarget, RULES.hydrology, this.inside);

    // --- 5. plants: only where Life reaches AND the climate suits AND it is not under water
    for (let i = 0; i < n; i++) {
      const life = Math.min(1, push.life[i]);
      const suits =
        smoothstep(RULES.plantWetMin, RULES.plantWetGood, wetness[i]) *
        smoothstep(RULES.plantColdLimit, RULES.plantColdGood, temperature[i]);
      const submerged = smoothstep(0.0, 0.004, this.surfaceTarget[i] - height[i]);
      vegetation[i] = this.inside[i] ? life * suits * (1 - submerged) : 0;
    }
    frame.version++;
  }

  /** Sum of gaussian falloffs for every copy in the group, into `this.copies`. */
  private addCopies(group: LiveCard[], radius: number): void {
    const copies = this.copies;
    copies.fill(0);
    const { w: GW, h: GH } = this;
    const sigmaX = radius * (GW - 1); // radius is a fraction of the world's width
    const sigmaY = radius * this.aspect * (GH - 1);
    const reach = 3.3;
    for (const card of group) {
      const cx = card.x * (GW - 1);
      const cy = card.y * (GH - 1);
      const x0 = Math.max(0, Math.floor(cx - reach * sigmaX));
      const x1 = Math.min(GW - 1, Math.ceil(cx + reach * sigmaX));
      const y0 = Math.max(0, Math.floor(cy - reach * sigmaY));
      const y1 = Math.min(GH - 1, Math.ceil(cy + reach * sigmaY));
      for (let j = y0; j <= y1; j++) {
        const dy = (j - cy) / sigmaY;
        const row = j * GW;
        for (let i = x0; i <= x1; i++) {
          const dx = (i - cx) / sigmaX;
          copies[row + i] += card.strength * Math.exp(-0.5 * (dx * dx + dy * dy));
        }
      }
    }
  }

  /** A blurred map of open water, so nearby land can be damper. */
  private updateNearWater(): void {
    const { n, frame, nearWater, scratch, w: GW, h: GH } = this;
    for (let i = 0; i < n; i++) nearWater[i] = frame.waterSurface[i] - frame.height[i] > 0.0005 && this.started ? 1 : 0;
    const radius = 4;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < GH; j++) {
        const row = j * GW;
        let sum = 0;
        for (let i = -radius; i <= radius; i++) sum += nearWater[row + Math.min(GW - 1, Math.max(0, i))];
        for (let i = 0; i < GW; i++) {
          scratch[row + i] = sum / (2 * radius + 1);
          sum += nearWater[row + Math.min(GW - 1, i + radius + 1)] - nearWater[row + Math.max(0, i - radius)];
        }
      }
      for (let i = 0; i < GW; i++) {
        let sum = 0;
        for (let j = -radius; j <= radius; j++) sum += scratch[Math.min(GH - 1, Math.max(0, j)) * GW + i];
        for (let j = 0; j < GH; j++) {
          nearWater[j * GW + i] = sum / (2 * radius + 1);
          sum += scratch[Math.min(GH - 1, j + radius + 1) * GW + i] - scratch[Math.max(0, j - radius) * GW + i];
        }
      }
    }
  }
}

/** Read a field at a play-area position (0..1, 0..1), bilinear. */
export function sampleField(field: Float32Array, GW: number, GH: number, x: number, y: number): number {
  const fx = Math.min(GW - 1.001, Math.max(0, x * (GW - 1)));
  const fy = Math.min(GH - 1.001, Math.max(0, y * (GH - 1)));
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const i = iy * GW + ix;
  return (
    field[i] * (1 - tx) * (1 - ty) + field[i + 1] * tx * (1 - ty) + field[i + GW] * (1 - tx) * ty + field[i + GW + 1] * tx * ty
  );
}
