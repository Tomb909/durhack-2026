// The world's rules. No Three.js in here: cards in, fields out.
//
// Cards push on world properties and everything visible is derived from those
// fields. WIND also supplies a directional vector for weather and seed spread.
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

/** The play area is always a rectangle: the shape presets (T key) are switched off. Matches RECTANGLE_ONLY in playarea.py. */
export const RECTANGLE_ONLY: boolean = true;

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
  /**
   * Forest with no help: grass and a few scattered trees on ordinary dry ground, and
   * thin scrub in a desert. Kept below forest (0.4) and below what woodcutters work (0.25).
   */
  hardyCover: 0.24,
  hardyInDesert: 0.5, // share of that cover left where the ground is bone dry
  /** People: where they will settle, farm and fish. */
  people: {
    homeStart: 0.45, // how strongly People must reach before houses appear
    homeFull: 1.0,
    farmStart: 0.12, // fields spread a bit further out than the houses
    farmFull: 0.5,
    fishStart: 0.1,
    fishFull: 0.45,
    /** Woodcutters work forest within this reach of people, felling a cell in about this many seconds. */
    logStart: 0.1,
    logFull: 0.4,
    fellSeconds: 480,
    steep: 0.012, // height change per cell above which nobody builds
    tooSteep: 0.026,
    highland: 0.2, // and nobody lives up on the peaks
    peaks: 0.3,
    flat: 0.004, // farmland wants it flatter still
    hilly: 0.011,
  },
  /** A LAKE card presses a bowl into the ground and keeps it full. */
  lake: {
    depth: 0.03, // from the shore down to the middle of the bed
    shoreWobble: 0.3, // how far the shoreline strays from a plain oval
  },
  /**
   * A RIVER card: a river that runs through the card. It rises on the highest ground
   * within reach (a mountain, if there is one) and carries on past the card, away from
   * its source, to the edge of the world, cutting itself a small valley on the way.
   */
  river: {
    sourceReach: 0.25, // height a far-off peak loses, per world width, against a near one
    sourceShort: 0.2, // the top fifth of the way up to the peak stays dry
    pull: 0.6, // how hard the river is drawn on past the card (height per world width)
    wander: 0.05, // how much the ground's roughness bends its course
    bedDepth: 0.0035,
    bankReach: 4, // cells either side shaped into the valley
    bankRise: 0.0022, // valley side: height gained per cell squared
  },
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
  /** Directional wind in world-space x/z components, each clamped to -1..1. */
  windX: Float32Array;
  windY: Float32Array;
  /** Snow ready to be scoured from windy, snow-covered high ground. */
  snowBlow: Float32Array;
  /** 0..1 how many houses. */
  homes: Float32Array;
  /** 0..1 how much of a town it is here (tall townhouses), and of a city (taller still, stone). */
  town: Float32Array;
  city: Float32Array;
  /** 0..1 the open square in the middle of a town or city, where its landmark stands. */
  plaza: Float32Array;
  /** 0..1 farmland (flat, fertile land near people). */
  farms: Float32Array;
  /** 0..1 fishing boats (open water near people). */
  fishing: Float32Array;
  /** 0..1 woodcutters at work (forest near people). */
  logging: Float32Array;
  /**
   * 0..1 forest felled so far. Grows while woodcutters work and never shrinks, so
   * the land remembers. Kept apart from `vegetation` (which follows the cards alone).
   */
  cleared: Float32Array;
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

/** Properties that cards push on as a soft-edged area. (LAKE is dug card by card instead.) */
type LocalField = Exclude<FieldName, 'seaLevel' | 'lake'>;

const WATER_IDS = new Set(['rain', 'lake', 'river']);
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

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
  private crags: Float32Array;
  private foothills: Float32Array;
  /** Water welling up (LAKE, RIVER) and the beds RIVER cards lay down: inputs to the hydrology. */
  private spring: Float32Array;
  private course: Float32Array;
  /** A second flood, used to find each RIVER card's way to the edge. */
  private router: Hydrology;
  private routeSurface: Float32Array;
  /** 1 inside a LAKE card's basin: rivers run into and out of these without cutting them open. */
  private basin: Uint8Array;
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
    this.base = f(); this.ridge = f(); this.rough = f(); this.crags = f(); this.foothills = f();
    this.spring = f(); this.course = f(); this.routeSurface = f();
    this.router = new Hydrology(w, h);
    this.basin = new Uint8Array(n);
    this.push = { height: f(), temperature: f(), wetness: f(), forest: f(), settlement: f(), town: f(), city: f(), plaza: f() };
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
      precipitation: f(), windX: f(), windY: f(), snowBlow: f(), homes: f(), town: f(), city: f(), plaza: f(), farms: f(), fishing: f(), logging: f(), cleared: f(), mask, aspect, outline: shape.outline, seaLevel: RULES.seaBase, version: 0,
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
        // Finer relief that only shows on lifted ground: crags and gullies on a mountain's
        // flanks, and rolling foothills round its feet.
        this.crags[k] = ridged(X * 8.5, Y * 8.5, 3, 41) - 0.45;
        this.foothills[k] = fbm(X * 5.5, Y * 5.5, 3, 67) - 0.5;
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
      // The ground moves at once but the water eases, so where the ground has just
      // dropped (behind a mountain being dragged) the old water level would be left
      // hanging in the air as a sheet of water. Remember how deep the water was...
      const { waterSurface, height } = this.frame;
      const depthBefore = this.lastSurface; // free here: only refine() uses it, and it overwrites it first
      for (let i = 0; i < this.n; i++) depthBefore[i] = waterSurface[i] - height[i];
      this.recompute(cards);
      // ...and never let it be deeper than it was or than it is heading for.
      if (this.started) {
        const st = this.surfaceTarget;
        for (let i = 0; i < this.n; i++) {
          const cap = Math.max(height[i] + depthBefore[i], st[i]);
          if (waterSurface[i] > cap) waterSurface[i] = cap;
        }
      }
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
    this.fell(dt);
    return this.frame;
  }

  private fellTimer = 0;
  /** Woodcutters slowly clear the forest they work. Only in running time, never in settleNow. */
  private fell(dt: number): void {
    if (dt <= 0) return;
    const { logging, cleared } = this.frame;
    const rate = dt / RULES.people.fellSeconds;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (logging[i] > 0.01 && cleared[i] < 1) {
        cleared[i] = Math.min(1, cleared[i] + rate * logging[i]);
        any = true;
      }
    }
    // Let the renderer know a few times a second, not every frame.
    this.fellTimer += dt;
    if (any && this.fellTimer > 0.25) {
      this.fellTimer = 0;
      this.frame.version++;
    }
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
    const windCards = cards.filter((card) => card.def.id === 'wind' && card.strength > 0);

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
    this.buildWindField(windCards);
    this.buildBlizzard(cards, windCards);
    this.scatterSeeds(cards, windCards);
    frame.seaLevel = sea;

    // --- 2. where is there open water right now? (from the last result)
    this.updateNearWater();

    // --- 3. derive everything from the five properties
    const { height, temperature, wetness, vegetation, precipitation } = frame;
    for (let i = 0; i < n; i++) {
      const lift = push.height[i];
      // Ridged noise carves the lift into peaks and valleys; the middle of a range rises steepest.
      const peak = 0.72 + 0.5 * smoothstep(0.0, 0.5, lift);
      // Flanks are broken into crags and gullies, and the skirts of a range roll away as foothills.
      const flank = Math.min(lift, 0.6) * 0.16 * this.crags[i] * smoothstep(0.03, 0.2, lift);
      const skirt = 0.05 * this.foothills[i] * smoothstep(0.01, 0.1, lift) * (1 - smoothstep(0.18, 0.4, lift));
      height[i] = this.base[i] + lift * peak * (0.38 + 0.62 * this.ridge[i]) + lift * 0.14 * this.rough[i] + flank + skirt;
    }
    this.spring.fill(0);
    this.course.fill(0);
    this.digLakes(cards, radiusMultipliers, sea);
    this.runRivers(cards, sea);
    for (let i = 0; i < n; i++) {
      const h = height[i];

      const altitude = Math.max(0, h - RULES.lapseStartsAt);
      const t = Math.max(-1, Math.min(1, push.temperature[i] - RULES.lapse * altitude));
      temperature[i] = t;

      const wet = Math.max(0, Math.min(1,
        RULES.wetBase + push.wetness[i] - RULES.evaporation * Math.max(0, t) + RULES.wetNearWater * this.nearWater[i]));
      wetness[i] = wet;

      precipitation[i] = this.inside[i] ? smoothstep(RULES.rainStart, RULES.rainFull, wet) : 0;
    }
    this.updateSnowBlow();

    // --- 4. water on land
    this.hydrology.compute(height, sea, precipitation, this.surfaceTarget, this.riverTarget, RULES.hydrology, this.inside, this.spring, this.course);

    // --- 5. plants: forest only where a FOREST card reaches AND the climate suits AND it is
    // not under water. Where it is too dry for forest, the card still gives scrub and
    // scattered trees, so a FOREST card on its own shows.
    for (let i = 0; i < n; i++) {
      const forest = Math.min(1, push.forest[i]);
      const warmEnough = smoothstep(RULES.plantColdLimit, RULES.plantColdGood, temperature[i]);
      const suits = smoothstep(RULES.plantWetMin, RULES.plantWetGood, wetness[i]) * warmEnough;
      const hardy = RULES.hardyCover * warmEnough *
        (RULES.hardyInDesert + (1 - RULES.hardyInDesert) * smoothstep(0.05, 0.2, wetness[i]));
      const submerged = smoothstep(0.0, 0.004, this.surfaceTarget[i] - height[i]);
      vegetation[i] = this.inside[i] ? forest * Math.max(suits, hardy) * (1 - submerged) : 0;
    }

    // --- 6. people: houses on dry, gentle, liveable land; fields on flat fertile land; boats on open water
    this.settlePeople();
    frame.version++;
  }

  /** LAKE: press a bowl into the ground at each card, level with the lowest ground round its rim, and fill it. */
  private digLakes(cards: LiveCard[], radiusMultipliers: Map<LiveCard, number>, sea: number): void {
    const { w, h, aspect, frame, rough, inside } = this;
    const height = frame.height;
    const L = RULES.lake;
    this.basin.fill(0);
    for (const card of cards) {
      if (card.def.id !== 'lake' || card.strength <= 0) continue;
      const radius = (card.def.effects.find((e) => e.field === 'lake')?.radius ?? 0.075) * (radiusMultipliers.get(card) ?? 1);
      const rx = radius * (w - 1);
      const ry = radius * aspect * (h - 1);
      const cx = Math.min(w - 4, Math.max(3, card.x * (w - 1)));
      const cy = Math.min(h - 4, Math.max(3, card.y * (h - 1)));
      // The shore sits at the lowest ground on the rim, so the bowl holds water all the way round.
      let rim = Infinity;
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const x = Math.min(w - 1, Math.max(0, Math.round(cx + Math.cos(a) * rx)));
        const y = Math.min(h - 1, Math.max(0, Math.round(cy + Math.sin(a) * ry)));
        rim = Math.min(rim, height[y * w + x]);
      }
      const x0 = Math.max(1, Math.floor(cx - rx)), x1 = Math.min(w - 2, Math.ceil(cx + rx));
      const y0 = Math.max(1, Math.floor(cy - ry)), y1 = Math.min(h - 2, Math.ceil(cy + ry));
      for (let j = y0; j <= y1; j++) {
        for (let i = x0; i <= x1; i++) {
          const k = j * w + i;
          if (!inside[k]) continue;
          const d = Math.hypot((i - cx) / rx, (j - cy) / ry) * (1 + L.shoreWobble * rough[k]);
          if (d >= 1) continue;
          this.basin[k] = 1;
          // Leave the very edge of the world alone: it is where water runs off.
          const border = smoothstep(0, 4, Math.min(i, j, w - 1 - i, h - 1 - j));
          const bowl = 1 - d * d;
          const target = Math.max(sea + 0.004, rim - L.depth * bowl * (0.6 + 0.4 * bowl));
          if (height[k] > target) height[k] -= (height[k] - target) * card.strength * border;
        }
      }
      this.spring[Math.round(cy) * w + Math.round(cx)] += RULES.hydrology.lakeFull * 1.2 * card.strength;
    }
  }

  /**
   * RIVER: a river through each card. It rises on the highest ground within reach,
   * comes down through the card and runs on, away from its source, to the edge.
   */
  private runRivers(cards: LiveCard[], sea: number): void {
    const rivers = cards.filter((card) => card.def.id === 'river' && card.strength > 0);
    if (!rivers.length) return;
    const { w, h, n, aspect, frame, rough, inside, hydrology, router, routeSurface, spring, course, basin } = this;
    const height = frame.height;
    const R = RULES.river;
    const H = RULES.hydrology;
    const ux = (i: number) => i / (w - 1);
    const uy = (j: number) => j / (h - 1) / aspect;
    for (const card of rivers) {
      const cardX = Math.min(w - 3, Math.max(2, Math.round(card.x * (w - 1))));
      const cardY = Math.min(h - 3, Math.max(2, Math.round(card.y * (h - 1))));
      const px = ux(cardX), py = uy(cardY);

      // The source: the highest ground around, a far peak counting for less than a near one.
      let source = cardY * w + cardX;
      let best = -Infinity;
      for (let j = 2; j < h - 2; j += 2) {
        for (let i = 2; i < w - 2; i += 2) {
          const k = j * w + i;
          if (!inside[k]) continue;
          const score = height[k] - R.sourceReach * Math.hypot(ux(i) - px, uy(j) - py);
          if (score > best) best = score, source = k;
        }
      }
      const sx = source % w, sy = (source - sx) / w;
      let dirX = px - ux(sx), dirY = py - uy(sy);
      if (Math.hypot(dirX, dirY) < 0.04) {
        // The card is on the summit: head for the lowest ground round about.
        let low = Infinity;
        for (let k = 0; k < 32; k++) {
          const a = (k / 32) * Math.PI * 2;
          const x = Math.min(w - 1, Math.max(0, Math.round(cardX + Math.cos(a) * 0.2 * (w - 1))));
          const y = Math.min(h - 1, Math.max(0, Math.round(cardY + Math.sin(a) * 0.2 * aspect * (h - 1))));
          if (height[y * w + x] < low) low = height[y * w + x], dirX = Math.cos(a), dirY = Math.sin(a);
        }
      }
      const length = Math.hypot(dirX, dirY) || 1;
      dirX /= length; dirY /= length;

      // Up from the card to the source: always nearer, and by the lowest ground on offer (the valley floors).
      const up: number[] = [];
      let x = cardX, y = cardY;
      for (let guard = 0; guard < w + h; guard++) {
        const here = Math.hypot(x - sx, y - sy);
        if (here < 1.5) break;
        let next = -1, lowest = Infinity;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
          const k = ny * w + nx;
          if (!inside[k] || Math.hypot(nx - sx, ny - sy) >= here - 0.3) continue;
          const cost = height[k] + R.wander * rough[k];
          if (cost < lowest) lowest = cost, next = k;
        }
        if (next < 0) break;
        up.push(next);
        x = next % w; y = (next - x) / w;
      }
      up.length = Math.round(up.length * (1 - R.sourceShort));

      // Down from the card: over ground tilted away from the source, the way water would find to the edge.
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const k = j * w + i;
          routeSurface[k] = height[k] + R.wander * rough[k] - R.pull * ((ux(i) - px) * dirX + (uy(j) - py) * dirY);
        }
      }
      router.flood(routeSurface, -Infinity, inside);
      const path = up.reverse();
      for (let k = cardY * w + cardX, guard = 0; k >= 0 && guard < n; k = router.parent[k], guard++) path.push(k);

      // The bed never climbs: it cuts through whatever rise is in its way. Across a LAKE it
      // rides at the lake's own level (what the basin fills to), so it leaves by the brim.
      hydrology.flood(height, sea, inside);
      const filled = hydrology.filled;
      const reach = R.bankReach;
      let level = Infinity;
      const beds = new Float32Array(path.length);
      for (let s = 0; s < path.length; s++) {
        const c = path[s];
        level = Math.min(basin[c] ? filled[c] : height[c], level - 3e-5);
        beds[s] = level - (basin[c] ? 0 : R.bedDepth);
      }
      for (let s = 0; s < path.length; s++) {
        const c = path[s];
        const cx = c % w, cy = (c - cx) / w;
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const k = ny * w + nx;
            if (!inside[k] || basin[k]) continue;
            const target = Math.max(sea + 0.002, beds[s] + R.bankRise * (dx * dx + dy * dy));
            if (height[k] > target) height[k] -= (height[k] - target) * card.strength;
          }
        }
        // A trickle at the source, a full river by the time it has run a little way.
        const grown = card.strength * (0.4 + 0.6 * smoothstep(0, 24, s));
        if (grown > course[c]) course[c] = grown;
        // Wider than one cell once it is a proper river.
        for (let d = 0; d < 4; d++) {
          const k = c + DX8[d] + DY8[d] * w;
          if (cx > 0 && cx < w - 1 && cy > 0 && cy < h - 1 && inside[k] && !basin[k] && 0.6 * grown > course[k]) course[k] = 0.6 * grown;
        }
        spring[c] += H.lakeFull * 0.15 * card.strength;
      }
    }
  }

  private buildWindField(windCards: LiveCard[]): void {
    const { w, h, aspect, frame } = this;
    frame.windX.fill(0);
    frame.windY.fill(0);
    const radius = 0.3;
    const sigmaX = radius * (w - 1);
    const sigmaY = radius * aspect * (h - 1);
    for (const card of windCards) {
      const cx = card.x * (w - 1);
      const cy = card.y * (h - 1);
      const x0 = Math.max(0, Math.floor(cx - 3.3 * sigmaX));
      const x1 = Math.min(w - 1, Math.ceil(cx + 3.3 * sigmaX));
      const y0 = Math.max(0, Math.floor(cy - 3.3 * sigmaY));
      const y1 = Math.min(h - 1, Math.ceil(cy + 3.3 * sigmaY));
      const dx = Math.cos(card.angle) * card.strength;
      const dy = Math.sin(card.angle) * card.strength;
      for (let j = y0; j <= y1; j++) {
        const ny = (j - cy) / sigmaY;
        const row = j * w;
        for (let i = x0; i <= x1; i++) {
          const nx = (i - cx) / sigmaX;
          const influence = Math.exp(-0.5 * (nx * nx + ny * ny));
          frame.windX[row + i] += dx * influence;
          frame.windY[row + i] += dy * influence;
        }
      }
    }
    for (let i = 0; i < frame.windX.length; i++) {
      const magnitude = Math.hypot(frame.windX[i], frame.windY[i]);
      if (magnitude > 1) {
        frame.windX[i] /= magnitude;
        frame.windY[i] /= magnitude;
      }
    }
  }

  /** Wind carrying moisture across nearby ICE creates a directional snow squall. */
  private buildBlizzard(cards: LiveCard[], windCards: LiveCard[]): void {
    if (!windCards.length) return;
    const iceCards = cards.filter((card) => card.def.id === 'ice' && card.strength > 0);
    const { w, h, aspect, push } = this;
    for (const ice of iceCards) {
      let wind: LiveCard | undefined;
      let nearest = 0.36;
      for (const candidate of windCards) {
        const distance = Math.hypot(candidate.x - ice.x, (candidate.y - ice.y) / aspect);
        if (distance < nearest) {
          nearest = distance;
          wind = candidate;
        }
      }
      if (!wind) continue;

      const dirX = Math.cos(wind.angle);
      const dirY = Math.sin(wind.angle);
      const cx = ice.x * (w - 1);
      const cy = ice.y * (h - 1);
      const reachX = 0.58 * (w - 1);
      const reachY = 0.58 * aspect * (h - 1);
      for (let j = Math.max(0, Math.floor(cy - reachY)); j <= Math.min(h - 1, Math.ceil(cy + reachY)); j++) {
        const dy = (j / (h - 1) - ice.y) / aspect;
        const row = j * w;
        for (let i = Math.max(0, Math.floor(cx - reachX)); i <= Math.min(w - 1, Math.ceil(cx + reachX)); i++) {
          const dx = i / (w - 1) - ice.x;
          const along = dx * dirX + dy * dirY;
          if (along < -0.10 || along > 0.56) continue;
          const across = -dx * dirY + dy * dirX;
          const streak = Math.exp(-0.5 * (((along - 0.18) / 0.22) ** 2 + (across / 0.12) ** 2));
          const force = ice.strength * wind.strength * streak;
          push.wetness[row + i] += 0.78 * force;
          push.temperature[row + i] -= 0.12 * force;
        }
      }
    }
  }

  /** Wind carries FOREST seeds downwind; nearby water (RAIN, LAKE or RIVER) makes the trail take root. */
  private scatterSeeds(cards: LiveCard[], windCards: LiveCard[]): void {
    if (!windCards.length) return;
    const forestCards = cards.filter((card) => card.def.id === 'forest' && card.strength > 0);
    const waterCards = cards.filter((card) => WATER_IDS.has(card.def.id) && card.strength > 0);
    const { w, h, aspect, push } = this;
    for (const forest of forestCards) {
      let wind: LiveCard | undefined;
      let nearest = 0.3;
      for (const candidate of windCards) {
        const dx = candidate.x - forest.x;
        const dy = (candidate.y - forest.y) / aspect;
        const distance = Math.hypot(dx, dy);
        if (distance < nearest) {
          nearest = distance;
          wind = candidate;
        }
      }
      if (!wind) continue;

      const hasWater = waterCards.some(
        (water) => Math.hypot(water.x - forest.x, (water.y - forest.y) / aspect) < 0.3,
      );
      const plumeLength = hasWater ? 0.55 : 0.42;
      const acrossSigma = hasWater ? 0.018 : 0.028;
      const dirX = Math.cos(wind.angle);
      const dirY = Math.sin(wind.angle);
      for (let j = 0; j < h; j++) {
        const dy = j / (h - 1) - forest.y;
        const row = j * w;
        for (let i = 0; i < w; i++) {
          const dx = i / (w - 1) - forest.x;
          const along = dx * dirX + (dy / aspect) * dirY;
          if (along < 0 || along > plumeLength) continue;
          const across = -dx * dirY + (dy / aspect) * dirX;
          const lateral = across / acrossSigma;
          const ends = smoothstep(0, 0.035, along) * (1 - smoothstep(plumeLength - 0.05, plumeLength, along));
          const seeds = Math.exp(-0.5 * lateral * lateral) * ends * forest.strength * wind.strength;
          push.forest[row + i] += seeds * (hasWater ? 1.9 : 0.95);
          if (hasWater) push.wetness[row + i] += seeds * 0.48;
        }
      }
    }
  }

  private updateSnowBlow(): void {
    const { w, h, n, frame, inside } = this;
    const { height, temperature, wetness, windX, windY, snowBlow } = frame;
    for (let i = 0; i < n; i++) {
      if (!inside[i]) {
        snowBlow[i] = 0;
        continue;
      }
      const x = i % w;
      const left = x > 0 ? height[i - 1] : height[i];
      const right = x < w - 1 ? height[i + 1] : height[i];
      const up = i >= w ? height[i - w] : height[i];
      const down = i + w < n ? height[i + w] : height[i];
      const slope = 0.5 * Math.hypot(right - left, down - up);
      const snow = smoothstep(RULES.freezing + 0.12, RULES.freezing - 0.08, temperature[i]) *
        smoothstep(0.22, 0.45, wetness[i]);
      const highland = smoothstep(0.13, 0.34, height[i]);
      const wind = Math.min(1, Math.hypot(windX[i], windY[i]));
      snowBlow[i] = snow * highland * (0.25 + 0.75 * smoothstep(0.001, 0.018, slope)) * wind;
    }
  }

  private settlePeople(): void {
    const { n, frame, push, w } = this;
    const { height, temperature, wetness, vegetation, homes, farms, fishing, town, city, plaza } = frame;
    const P = RULES.people;
    for (let i = 0; i < n; i++) {
      const reach = Math.min(1.2, push.settlement[i]);
      if (reach <= 0.01 || !this.inside[i]) {
        homes[i] = farms[i] = fishing[i] = frame.logging[i] = town[i] = city[i] = plaza[i] = 0;
        continue;
      }
      town[i] = Math.min(1, push.town[i]);
      city[i] = Math.min(1, push.city[i]);
      // The square in the middle is kept clear of houses for the church or the castle.
      plaza[i] = smoothstep(0.3, 0.6, push.plaza[i]);
      const x = i % w;
      const left = x > 0 ? height[i - 1] : height[i];
      const right = x < w - 1 ? height[i + 1] : height[i];
      const up = i >= w ? height[i - w] : height[i];
      const down = i + w < n ? height[i + w] : height[i];
      const slope = 0.5 * Math.hypot(right - left, down - up);
      const t = temperature[i];
      const depth = this.surfaceTarget[i] - height[i];
      const dry = 1 - smoothstep(0.0, 0.0012, depth);
      const climate = smoothstep(-0.8, -0.5, t) * (1 - smoothstep(0.65, 0.92, t));
      const gentle = (1 - smoothstep(P.steep, P.tooSteep, slope)) * (1 - smoothstep(P.highland, P.peaks, height[i]));
      const home = smoothstep(P.homeStart, P.homeFull, reach) * climate * gentle * dry * (1 - plaza[i]);
      const fertile =
        smoothstep(0.28, 0.5, wetness[i]) * smoothstep(-0.35, -0.12, t) * (1 - smoothstep(0.45, 0.75, t)) *
        (1 - smoothstep(P.flat, P.hilly, slope));
      const farm = smoothstep(P.farmStart, P.farmFull, reach) * fertile * dry * (1 - 0.7 * home);
      const open = smoothstep(0.002, 0.006, depth) * smoothstep(RULES.freezing - 0.05, RULES.freezing + 0.1, t);
      homes[i] = home;
      farms[i] = farm;
      fishing[i] = smoothstep(P.fishStart, P.fishFull, reach) * open;
      // Fields and villages are cleared of forest; woodcutters work what is left nearby.
      vegetation[i] *= 1 - Math.min(1, 0.9 * home + farm);
      frame.logging[i] = smoothstep(P.logStart, P.logFull, reach) * smoothstep(0.25, 0.5, vegetation[i]) * dry;
    }
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
