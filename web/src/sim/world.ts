// The world's rules. No Three.js in here: cards in, fields out.
//
// Cards never change the world directly. They push on five properties
// (height, temperature, wetness, sea level, life) and everything you see is
// derived from those. There are no card-pair special cases anywhere.
import type { FieldName } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { Hydrology, type HydrologyRules } from './hydrology';
import { fbm, ridged } from './noise';

/** Grid size. The world has the play area's proportions (A3 landscape). */
export const GW = 192;
export const GH = 136;
export const ASPECT = 420 / 297;

/** Every tunable number in one place. */
export const RULES = {
  /** Copies of a card add up, then level off around this many copies. */
  copiesCeiling: 3.2,
  seaCopiesCeiling: 4.5,
  seaBase: 0.0,
  plainHeight: 0.046,
  plainTilt: 0.03, // the land slopes gently down toward the bay
  plainRoughness: 0.022,
  bayDepth: 0.11,
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

/** What the renderer receives. All arrays are GW x GH, row 0 = far edge. */
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
  private n = GW * GH;
  private base = new Float32Array(this.n);
  private ridge = new Float32Array(this.n);
  private rough = new Float32Array(this.n);
  /** Summed card pushes per property (after the copies ceiling). */
  private push: Record<LocalField, Float32Array> = {
    height: new Float32Array(this.n),
    temperature: new Float32Array(this.n),
    wetness: new Float32Array(this.n),
    life: new Float32Array(this.n),
  };
  private copies = new Float32Array(this.n);
  private surfaceTarget = new Float32Array(this.n);
  private riverTarget = new Float32Array(this.n);
  private nearWater = new Float32Array(this.n);
  private scratch = new Float32Array(this.n);
  private hydrology = new Hydrology(GW, GH);
  private lastSurface = new Float32Array(this.n);
  private lastRiver = new Float32Array(this.n);
  private settle = 0;
  private passesLeft = 0;
  private started = false;

  constructor() {
    const n = this.n;
    this.frame = {
      w: GW, h: GH,
      height: new Float32Array(n), temperature: new Float32Array(n), wetness: new Float32Array(n),
      vegetation: new Float32Array(n), waterSurface: new Float32Array(n), river: new Float32Array(n),
      precipitation: new Float32Array(n), seaLevel: RULES.seaBase, version: 0,
    };
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const u = i / (GW - 1);
        const v = j / (GH - 1);
        const X = u * ASPECT;
        const Y = v;
        const k = j * GW + i;
        // A gently rolling plain that slopes down to a bay in the near-right corner.
        const tilt = -RULES.plainTilt * (u - 0.5 + (v - 0.5));
        const rough = RULES.plainRoughness * 2 * (fbm(X * 2.4, Y * 2.4, 3, 11) - 0.5);
        const corner = Math.hypot((1 - u) * ASPECT, 1 - v);
        const bay = RULES.bayDepth * smoothstep(0.46, 0.0, corner);
        this.base[k] = RULES.plainHeight + tilt + rough - bay;
        this.ridge[k] = ridged(X * 3.4, Y * 3.4, 5, 5);
        this.rough[k] = fbm(X * 9, Y * 9, 2, 23) - 0.5;
      }
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
        this.addCopies(group, effect.radius ?? 0.2);
        const copies = this.copies;
        const ceiling = RULES.copiesCeiling;
        for (let i = 0; i < n; i++) {
          if (copies[i] > 0) target[i] += effect.amount * ceiling * Math.tanh(copies[i] / ceiling);
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

      precipitation[i] = smoothstep(RULES.rainStart, RULES.rainFull, wet);
    }

    // --- 4. water on land
    this.hydrology.compute(height, sea, precipitation, this.surfaceTarget, this.riverTarget, RULES.hydrology);

    // --- 5. plants: only where Life reaches AND the climate suits AND it is not under water
    for (let i = 0; i < n; i++) {
      const life = Math.min(1, push.life[i]);
      const suits =
        smoothstep(RULES.plantWetMin, RULES.plantWetGood, wetness[i]) *
        smoothstep(RULES.plantColdLimit, RULES.plantColdGood, temperature[i]);
      const submerged = smoothstep(0.0, 0.004, this.surfaceTarget[i] - height[i]);
      vegetation[i] = life * suits * (1 - submerged);
    }
    frame.version++;
  }

  /** Sum of gaussian falloffs for every copy in the group, into `this.copies`. */
  private addCopies(group: LiveCard[], radius: number): void {
    const copies = this.copies;
    copies.fill(0);
    const sigmaX = radius * (GW - 1); // radius is a fraction of the world's width
    const sigmaY = radius * ASPECT * (GH - 1);
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
    const { n, frame, nearWater, scratch } = this;
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
export function sampleField(field: Float32Array, x: number, y: number): number {
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
