// The world's rules. No Three.js in here: cards in, fields out.
//
// Cards never change the world directly. They push on a few properties
// (height, temperature, wetness, sea level, life, settlement, lava) and everything
// you see is derived from those. WIND is the one card that looks at the others: it gives
// the weather a direction, drives snow off nearby ICE and carries LIFE's seeds downwind
// (buildWindField, buildBlizzard, scatterSeeds).
import type { CardEffect, FieldName, LandShape } from '../cards/defs';
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

/**
 * True for a shape a world can be built from. The camera's shape arrives over the network:
 * proportions of zero or "not a number" would ask for a grid of no size or of endless size.
 */
export function usableShape(shape: WorldShape | null | undefined): shape is WorldShape {
  if (!shape || !Number.isFinite(shape.aspect) || shape.aspect < 0.25 || shape.aspect > 4) return false;
  if (!Array.isArray(shape.outline) || shape.outline.length < 3) return false;
  return shape.outline.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
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
    lip: 0.0015, // the shore stands this far above the water all the way round, but for one outlet
    brim: 0.15, // how far out from the water's edge that lip runs (a share of the lake's radius)
    outlet: 1.6, // half the outlet's width, in cells
    bank: 0.9, // higher ground slopes down to the shore over this share of the radius, instead of standing as a cliff
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
  /** Lava wells up where it is pushed, runs downhill, pools in hollows, and cools to black rock under water or in the cold. */
  lava: {
    ventStart: 0.3, // how strongly Lava must push before molten rock wells up
    ventFull: 0.8,
    thickness: 0.006, // how thick it lies on open ground
    ragged: 1.6, // how much noise breaks up the edge of where it wells up (share of the push, per unit of noise)
    coolBelow: -0.3, // colder than this and it has set to rock
    coolSpan: 0.25, // fully molten this much warmer than that
    flow: {
      riverStart: 10,
      riverFull: 60,
      lakeStart: 12,
      lakeFull: 80,
      lakeMinDepth: 0.0012,
      riverDepth: 0.005,
      dryOffset: 0.004,
      keep: 0.98, // a stream loses this much at every step, so it runs out
      levelLakes: true,
    } satisfies HydrologyRules,
  },
  /** A crack (an effect with `crack`, such as a ravine): how uneven it is along its length. */
  crack: {
    widen: 1.9, // width swells and narrows by this share per unit of slow noise
    wander: 3.5, // the middle wanders off the fault line by this many widths per unit of fine noise
    deepen: 1.3, // depth swells by this share per unit of slow noise
    jagged: 0.7, // and by this share per unit of fine noise
  },
  /** A volcano's cone (an effect with `cone`; the shape itself is on the card). */
  volcano: {
    ceiling: 0.9, // rims level off around this height, however many copies or BIG
    huddle: 0.35, // each copy close by lifts a cone by up to this share
    grow: 0.55, // a cone fading in starts this wide (share of its full size) and grows to full
    lopsided: 0.15, // the crater sits off centre by this share of its radius, so one side of the rim is lower
    outline: [0.07, 0.045, 0.03], // the foot bulges out by these shares at 2, 3 and 5 lobes round the cone
    craterPower: 3, // the crater's inner wall rises as (distance / crater radius)^this: flat floor, steep wall
    crest: 0.15, // rounding where the inner wall meets the flank, as a share of the crater's depth (small: a sharp rim)
    gullyWidth: [1.0, 0.045], // gully half-width in cells: this many, plus this share of the distance from the centre
    notchWidth: 2.2, // notch half-width in cells
    notchReach: 0.12, // a notch fades out down the flank over this share of the base radius
    evenOut: [0.35, 0.65], // the summit evens out the ground under it fully within this share of the base radius, and not at all beyond that
  },
  /** A landform (an effect with `shape`): it ends at its radius, with an uneven outline. */
  form: {
    lobes: 0.3, // the outline bulges in and out by this share of the radius per unit of slow noise
    frayed: 0.18, // and by this share per unit of fine noise
    wall: 0.78, // `flat`: level out to this share of the radius, then the side falls away
    evenOut: 0.85, // `flat` and `terraces`: how far the ground underneath is levelled (0 keeps every hill, 1 is dead level)
    steps: 5, // `terraces`: how many
    crests: 9, // `dunes`: how many would fit across the world's width
    rimAt: 0.72, // `rim`: the wall stands at this share of the radius
    rimWidth: 0.26, // and is this wide either side of that, as a share of the radius
    grit: 0.06, // fine roughness on a landform, as a share of its height
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
  /** 0..1 how much lava covers the ground here, molten or set. */
  lava: Float32Array;
  /** 0..1 how molten that lava is: 1 glowing, 0 cooled to black rock (under water, or in the cold). */
  lavaHeat: Float32Array;
  /** Height of the lava's surface. Below `height` where there is none. */
  lavaSurface: Float32Array;
  /** Signed distance to the play area's outline in cells, positive inside. */
  mask: Float32Array;
  /** Long / short side. */
  aspect: number;
  outline: number[][];
  seaLevel: number;
  /** Increases whenever the arrays change. */
  version: number;
  /**
   * Increases whenever the world was worked out again from the cards. Not while water and lava
   * only ease toward where they are heading, nor while forest is being felled: those change
   * `waterSurface`, `river`, the lava arrays and `cleared`, and nothing else.
   */
  rules: number;
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
/** True where the sea covers this cell. Ground below sea level can still be dry: a hole the sea has not reached. */
export const underSea = (frame: WorldFrame, i: number) => frame.height[i] < frame.seaLevel && frame.waterSurface[i] > frame.height[i];

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
  /** Fault lines: a cut (an effect with `crack`) follows the line of this field that runs through its card. */
  private fault: Float32Array;
  /** How fast `fault` changes per cell, so a crack is the same width everywhere. */
  private faultGrade: Float32Array;
  /** Fine noise (about -0.5..0.5): breaks the edge of welling lava into lobes and makes a crack wander. */
  private jag: Float32Array;
  /** Slow noise (about -0.5..0.5): a crack widens and deepens in some stretches and narrows in others. */
  private swell: Float32Array;
  /** Volcano cones (effects with `cone`): the highest cone at each cell. */
  private coneLift: Float32Array;
  /** Molten rock pouring out of the cones' notches, in lava flow units. */
  private ventFlow: Float32Array;
  /**
   * How much a cone's summit evens out the ground under it (0..1), and the level it evens it to
   * (summed, weighted by that share). A volcano on a mountain keeps its crater whole.
   */
  private coneMask: Float32Array;
  private coneFloor: Float32Array;
  /** Height at full precision while it is worked out. */
  private ground: Float64Array;
  private hadCone = false;
  /** Landforms (height effects with `shape`): what they add to the ground, uncarved by the ridge noise. */
  private formed: Float32Array;
  /** How far a level landform evens out the ground under it (0..1), and the level it evens it to (summed, weighted by that share). */
  private formMask: Float32Array;
  private formFloor: Float32Array;
  private hadForm = false;
  /** Summed card pushes per property (after the copies ceiling). */
  private push: Record<LocalField, Float32Array>;
  private copies: Float32Array;
  /** One row of a card's falloff (see addCopies). */
  private across = new Float64Array(GW);
  private surfaceTarget: Float32Array;
  private riverTarget: Float32Array;
  private nearWater: Float32Array;
  private scratch: Float32Array;
  private hydrology: Hydrology;
  private lavaFlow: Hydrology;
  private lavaSource: Float32Array;
  private lavaTarget: Float32Array;
  private lavaHeatTarget: Float32Array;
  private lavaSurfaceTarget: Float32Array;
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
    this.fault = f(); this.faultGrade = f(); this.jag = f(); this.swell = f(); this.coneLift = f(); this.ventFlow = f(); this.coneMask = f(); this.coneFloor = f(); this.formed = f(); this.formMask = f(); this.formFloor = f(); this.ground = new Float64Array(n);
    this.push = { height: f(), temperature: f(), wetness: f(), forest: f(), settlement: f(), town: f(), city: f(), plaza: f(), lava: f() };
    this.lavaSource = f(); this.lavaTarget = f(); this.lavaHeatTarget = f(); this.lavaSurfaceTarget = f();
    this.lavaFlow = new Hydrology(w, h);
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
      precipitation: f(), windX: f(), windY: f(), snowBlow: f(), homes: f(), town: f(), city: f(), plaza: f(), farms: f(), fishing: f(), logging: f(), cleared: f(),
      lava: f(), lavaHeat: f(), lavaSurface: f(), mask, aspect, outline: shape.outline, seaLevel: RULES.seaBase, version: 0, rules: 0,
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
        this.fault[k] = fbm(X * 2.3, Y * 2.3, 3, 71);
        this.jag[k] = fbm(X * 13, Y * 13, 3, 41) - 0.5;
        this.swell[k] = fbm(X * 5, Y * 5, 2, 59) - 0.5;
      }
    }
    // Never flatter than this, or a crack would spread into a wide pit where the field levels off.
    const gentlest = 0.0035;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const gx = (this.fault[j * w + Math.min(w - 1, i + 1)] - this.fault[j * w + Math.max(0, i - 1)]) / 2;
        const gy = (this.fault[Math.min(h - 1, j + 1) * w + i] - this.fault[Math.max(0, j - 1) * w + i]) / 2;
        this.faultGrade[k] = Math.max(gentlest, Math.hypot(gx, gy));
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
        this.arriveLava();
        this.started = true;
      }
    }
    if (this.settle > 0) {
      this.settle -= dt;
      const k = 1 - Math.exp(-dt / RULES.settleSeconds);
      const { waterSurface, river, lava, lavaHeat, lavaSurface } = this.frame;
      const st = this.surfaceTarget;
      const rt = this.riverTarget;
      const lt = this.lavaTarget;
      const ht = this.lavaHeatTarget;
      const lst = this.lavaSurfaceTarget;
      for (let i = 0; i < this.n; i++) {
        waterSurface[i] += (st[i] - waterSurface[i]) * k;
        river[i] += (rt[i] - river[i]) * k;
        lava[i] += (lt[i] - lava[i]) * k;
        lavaHeat[i] += (ht[i] - lavaHeat[i]) * k;
        lavaSurface[i] += (lst[i] - lavaSurface[i]) * k;
      }
      // The water has arrived. Land beside it is damper now, which may move the
      // water again, so look once more and keep going until nothing changes.
      // Without this the world would stop wherever the animation happened to be.
      if (this.settle <= 0) {
        // `refine` puts the water and the lava exactly on their targets before it looks again.
        if (this.passesLeft-- > 0) {
          if (this.refine(cards)) this.settle = RULES.settleSeconds * 5;
        } else {
          this.arrive(); // out of looks: at least end exactly where the last one pointed
        }
      }
      this.frame.version++;
    }
    this.fell(dt);
    return this.frame;
  }

  private fellTimer = 0;
  /** True while any cell has woodcutters at work (set whenever the world is worked out). */
  private woodcutters = false;
  /** Woodcutters slowly clear the forest they work. Only in running time, never in settleNow. */
  private fell(dt: number): void {
    if (dt <= 0 || !this.woodcutters) return; // nobody is at work: nothing to look through

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
    this.arriveLava();
    this.settle = 0;
    this.passesLeft = 0;
    this.frame.version++;
    return this.frame;
  }

  /** Put the water and the lava exactly where they are heading. */
  private arrive(): void {
    this.frame.waterSurface.set(this.surfaceTarget);
    this.frame.river.set(this.riverTarget);
    this.arriveLava();
  }

  /** Put the lava where it is heading, at once. */
  private arriveLava(): void {
    this.frame.lava.set(this.lavaTarget);
    this.frame.lavaHeat.set(this.lavaHeatTarget);
    this.frame.lavaSurface.set(this.lavaSurfaceTarget);
  }

  /** Let the water reach its target and work the world out again. True if that moved the water. */
  private refine(cards: LiveCard[]): boolean {
    const { n, frame, surfaceTarget, riverTarget, lastSurface, lastRiver } = this;
    lastSurface.set(surfaceTarget);
    lastRiver.set(riverTarget);
    frame.waterSurface.set(surfaceTarget);
    frame.river.set(riverTarget);
    this.arriveLava();
    this.recompute(cards);
    for (let i = 0; i < n; i++) {
      if (Math.abs(surfaceTarget[i] - lastSurface[i]) > 1e-6 || Math.abs(riverTarget[i] - lastRiver[i]) > 1e-6) return true;
    }
    return false;
  }

  private recompute(cards: LiveCard[]): void {
    const { n, frame, push } = this;
    for (const key of Object.keys(push) as LocalField[]) push[key].fill(0);
    if (this.hadCone) {
      this.coneLift.fill(0);
      this.ventFlow.fill(0);
      this.coneMask.fill(0);
      this.coneFloor.fill(0);
      this.hadCone = false;
    }
    if (this.hadForm) {
      this.formed.fill(0);
      this.formMask.fill(0);
      this.formFloor.fill(0);
      this.hadForm = false;
    }
    const windCards = cards.filter((card) => card.def.id === 'wind' && card.strength > 0);

    const modifiersByTarget = modifierTargets(cards);
    const radiusMultipliers = new Map<LiveCard, number>();
    for (const [target, modifiers] of modifiersByTarget) {
      radiusMultipliers.set(target, radiusMultiplier(modifiers));
    }

    // --- 1. gather card pushes. Copies of the same card add up, then level off.
    let sea = RULES.seaBase;
    const cones: [LiveCard[], CardEffect][] = [];
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
        if (effect.cone) {
          if (effect.field === 'height') cones.push([group, effect]); // built on the ground, once that is known
          continue;
        }
        const target = push[effect.field as LocalField];
        if (!target) continue;
        if (effect.shape) {
          this.addShape(group, effect, target, radiusMultipliers, modifiersByTarget);
          continue;
        }
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
            this.addCopies(radiusGroup, radius, (effect.crack ?? 0) * (radius / (effect.radius ?? 0.2)));
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
    const ground = this.ground;
    for (let i = 0; i < n; i++) {
      const lift = push.height[i];
      // Ridged noise carves the lift into peaks and valleys; the middle of a range rises steepest.
      // A cut (lift below zero) keeps more of its depth everywhere, so its floor is not broken into separate pits.
      const peak = 0.72 + 0.5 * smoothstep(0.0, 0.5, lift);
      const shaped = lift >= 0 ? peak * (0.38 + 0.62 * this.ridge[i]) : 0.72 + 0.28 * this.ridge[i];
      // Flanks are broken into crags and gullies, and the skirts of a range roll away as foothills.
      const flank = Math.min(lift, 0.6) * 0.16 * this.crags[i] * smoothstep(0.03, 0.2, lift);
      const skirt = 0.05 * this.foothills[i] * smoothstep(0.01, 0.1, lift) * (1 - smoothstep(0.18, 0.4, lift));
      ground[i] = height[i] = this.base[i] + lift * shaped + lift * 0.14 * this.rough[i] + flank + skirt;
    }
    // Landforms keep their own shape: added whole, after levelling the ground under the flat ones.
    if (this.hadForm) {
      const { formed, formMask, formFloor, rough } = this;
      const F = RULES.form;
      for (let i = 0; i < n; i++) {
        const m = formMask[i];
        const g = ground[i];
        const even = m > 0 ? g + (formFloor[i] / m - g) * Math.min(1, m) * F.evenOut : g;
        ground[i] = height[i] = even + formed[i] * (1 + F.grit * rough[i]);
      }
    }
    // Volcanoes stand on that ground.
    for (const [group, effect] of cones) this.addCones(group, effect, radiusMultipliers, modifiersByTarget);
    if (this.hadCone) {
      const { coneLift, coneMask, coneFloor, rough } = this;
      for (let i = 0; i < n; i++) {
        const m = coneMask[i];
        const g = ground[i];
        ground[i] = (m > 0 ? g + (coneFloor[i] / m - g) * Math.min(1, m) : g) + coneLift[i] * (1 + 0.1 * rough[i]);
      }
    }
    // Lakes and rivers are dug into the finished ground (landforms and volcanoes included).
    for (let i = 0; i < n; i++) height[i] = ground[i];
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
    // Ground below the base sea level only exists where something dug it: the sea has to find its way in.
    this.hydrology.compute(height, sea, precipitation, this.surfaceTarget, this.riverTarget, RULES.hydrology, this.inside, RULES.seaBase, this.spring, this.course);

    // --- 4b. lava: wells up where pushed, runs downhill, pools; water and cold set it to rock
    this.flowLava();

    // --- 5. plants: forest only where a FOREST card reaches AND the climate suits AND it is
    // not under water. Where it is too dry for forest, the card still gives scrub and
    // scattered trees, so a FOREST card on its own shows.
    for (let i = 0; i < n; i++) {
      // Cards may push forest down as well as up (BLIGHT): keep the sum in range.
      const forest = Math.max(0, Math.min(1, push.forest[i]));
      const warmEnough = smoothstep(RULES.plantColdLimit, RULES.plantColdGood, temperature[i]);
      const suits = smoothstep(RULES.plantWetMin, RULES.plantWetGood, wetness[i]) * warmEnough;
      const hardy = RULES.hardyCover * warmEnough *
        (RULES.hardyInDesert + (1 - RULES.hardyInDesert) * smoothstep(0.05, 0.2, wetness[i]));
      const submerged = smoothstep(0.0, 0.004, this.surfaceTarget[i] - height[i]);
      const burnt = smoothstep(0.02, 0.3, this.lavaTarget[i]);
      vegetation[i] = this.inside[i] ? forest * Math.max(suits, hardy) * (1 - submerged) * (1 - burnt) : 0;
    }

    // --- 6. people: houses on dry, gentle, liveable land; fields on flat fertile land; boats on open water
    this.settlePeople();
    frame.version++;
    frame.rules++;
  }

  private hadLava = false;
  private flowLava(): void {
    const { n, frame, lavaSource, lavaTarget, lavaHeatTarget, lavaSurfaceTarget, surfaceTarget } = this;
    const { height, temperature } = frame;
    const L = RULES.lava;
    const pushed = this.push.lava;
    const vents = this.ventFlow;
    let any = false;
    for (let i = 0; i < n; i++) {
      // Lava pushed on wells up (up to 1 per cell); a cone's notches pour out more than that.
      // Noise on the push gives the welling ground a ragged, lobed edge, not a round disc.
      const p = pushed[i] * (1 + L.ragged * this.jag[i]);
      const s = this.inside[i] ? smoothstep(L.ventStart, L.ventFull, p) + vents[i] : 0;
      lavaSource[i] = s;
      if (s > 0) any = true;
    }
    if (!any) {
      if (this.hadLava) {
        lavaTarget.fill(0);
        lavaHeatTarget.fill(0);
      }
      for (let i = 0; i < n; i++) lavaSurfaceTarget[i] = height[i] - L.flow.dryOffset;
      this.hadLava = false;
      return;
    }
    this.hadLava = true;
    // The same downhill rules as water, with no sea to stop at. `scratch` holds the streams.
    const stream = this.scratch;
    this.lavaFlow.compute(height, -Infinity, lavaSource, lavaSurfaceTarget, stream, L.flow, this.inside);
    for (let i = 0; i < n; i++) {
      const pooled = smoothstep(0.0005, 0.004, lavaSurfaceTarget[i] - height[i]);
      const amount = Math.max(stream[i], pooled, Math.min(1, lavaSource[i]));
      lavaTarget[i] = amount;
      // Lying on open ground it has some thickness of its own.
      let top = Math.max(lavaSurfaceTarget[i], height[i] + L.thickness * amount - L.flow.dryOffset * (1 - amount));
      // Water puts it out: it sets as rock on the bed, under the water.
      const water = surfaceTarget[i] - height[i];
      const quenched = smoothstep(0.0, 0.003, water);
      if (quenched > 0) top += (Math.min(top, surfaceTarget[i] - 0.003) - top) * quenched;
      lavaSurfaceTarget[i] = top;
      lavaHeatTarget[i] = (1 - quenched) * smoothstep(L.coolBelow, L.coolBelow + L.coolSpan, temperature[i]);
    }
  }

  /**
   * LAKE: press a bowl into the ground at each card, level with the lowest ground round its rim,
   * slope the higher ground round about down to its shore, and fill it.
   */
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
      // That lowest point is the lake's one outlet.
      let rim = Infinity;
      let outlet = 0;
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const x = Math.min(w - 1, Math.max(0, Math.round(cx + Math.cos(a) * rx)));
        const y = Math.min(h - 1, Math.max(0, Math.round(cy + Math.sin(a) * ry)));
        if (height[y * w + x] < rim) rim = height[y * w + x], outlet = a;
      }
      rim = Math.max(rim, sea + 0.004);
      const gap = L.outlet / Math.min(rx, ry); // half the outlet's width, as an angle
      // Out to where the banks end, with room for the shoreline's wobble.
      const far = (1 + L.bank) * (1 + L.shoreWobble);
      const x0 = Math.max(1, Math.floor(cx - rx * far)), x1 = Math.min(w - 2, Math.ceil(cx + rx * far));
      const y0 = Math.max(1, Math.floor(cy - ry * far)), y1 = Math.min(h - 2, Math.ceil(cy + ry * far));
      for (let j = y0; j <= y1; j++) {
        for (let i = x0; i <= x1; i++) {
          const k = j * w + i;
          if (!inside[k]) continue;
          const d = Math.hypot((i - cx) / rx, (j - cy) / ry) * (1 + L.shoreWobble * rough[k]);
          if (d >= 1 + L.bank) continue;
          // Leave the very edge of the world alone: it is where water runs off.
          const change = card.strength * smoothstep(0, 4, Math.min(i, j, w - 1 - i, h - 1 - j));
          if (d < 1) {
            this.basin[k] = 1;
            const bowl = 1 - d * d;
            const target = Math.max(sea + 0.004, rim - L.depth * bowl * (0.6 + 0.4 * bowl));
            if (height[k] > target) height[k] -= (height[k] - target) * change;
            continue;
          }
          // Round the water: a low lip so that it leaves by the outlet alone (water finding several
          // ways out at one level would each drain only a part of the lake)...
          let turn = Math.abs(Math.atan2((j - cy) / ry, (i - cx) / rx) - outlet) % (2 * Math.PI);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          const brim = rim + L.lip;
          if (turn < gap) {
            if (d < 1 + L.brim) height[k] += (rim - height[k]) * change;
            continue;
          }
          const lipped = 1 - smoothstep(1 + L.brim, 1 + 2 * L.brim, d);
          if (height[k] < brim) height[k] += (brim - height[k]) * lipped * change;
          // ...and where the land stands higher, a bank sloping down to the shore, not a cliff.
          else height[k] -= (height[k] - brim) * (1 - smoothstep(1, 1 + L.bank, d)) * change;
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
    let woodcutters = false;
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
      const clear = 1 - smoothstep(0.02, 0.3, this.lavaTarget[i]); // nobody builds or farms on lava
      const home = smoothstep(P.homeStart, P.homeFull, reach) * climate * gentle * dry * (1 - plaza[i]) * clear;
      const fertile =
        smoothstep(0.28, 0.5, wetness[i]) * smoothstep(-0.35, -0.12, t) * (1 - smoothstep(0.45, 0.75, t)) *
        (1 - smoothstep(P.flat, P.hilly, slope));
      const farm = smoothstep(P.farmStart, P.farmFull, reach) * fertile * dry * clear * (1 - 0.7 * home);
      const open = smoothstep(0.002, 0.006, depth) * smoothstep(RULES.freezing - 0.05, RULES.freezing + 0.1, t);
      homes[i] = home;
      farms[i] = farm;
      fishing[i] = smoothstep(P.fishStart, P.fishFull, reach) * open;
      // Fields and villages are cleared of forest; woodcutters work what is left nearby.
      vegetation[i] *= 1 - Math.min(1, 0.9 * home + farm);
      frame.logging[i] = smoothstep(P.logStart, P.logFull, reach) * smoothstep(0.25, 0.5, vegetation[i]) * dry;
      if (frame.logging[i] > 0.01) woodcutters = true;
    }
    this.woodcutters = woodcutters;
  }

  /**
   * Volcano cones for every copy in the group, into `coneLift` (the highest cone wins where
   * they meet) and the lava pouring from their notches into `ventFlow`.
   *
   * A cone: a concave flank, (1 - d)^power from the rim to the foot; a crater (a flat-floored
   * bowl, set a little off centre) cut out of the top with a sharp crest; gullies down the
   * flanks; and notches in the rim at the heads of the first few gullies. The foot bulges
   * unevenly. Each copy is turned by an angle that follows its position, so two volcanoes
   * differ, and everything moves smoothly as a card glides or fades.
   */
  private addCones(group: LiveCard[], effect: CardEffect, radiusMultipliers: Map<LiveCard, number>, modifiers: Map<LiveCard, LiveCard[]>): void {
    const spec = effect.cone!;
    const V = RULES.volcano;
    const { w, h, coneLift, ventFlow } = this;
    const cells = w - 1;
    const copies = group.map((card) => ({
      card,
      x: card.x * (w - 1),
      y: card.y * (h - 1),
      radius: (effect.radius ?? 0.2) * (radiusMultipliers.get(card) ?? 1) * cells * (V.grow + (1 - V.grow) * card.strength),
      rim: effect.amount * heightMultiplier(modifiers.get(card) ?? []) * card.strength,
    }));
    // Copies standing close together grow into one taller cone: each leans towards the others
    // nearby (all the way when they stand on the same spot), and is lifted by them.
    const merged = copies.map((a) => {
      let near = 0;
      let sx = 0;
      let sy = 0;
      for (const b of copies) {
        if (b === a) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y) / (0.5 * a.radius);
        const g = b.card.strength * Math.exp(-0.5 * d * d);
        near += g;
        sx += g * (b.x - a.x);
        sy += g * (b.y - a.y);
      }
      return {
        x: a.x + sx / (1 + near),
        y: a.y + sy / (1 + near),
        rim: softCap(a.rim * (1 + V.huddle * Math.tanh(near)), V.ceiling),
      };
    });
    const G = Math.max(0, Math.round(spec.gullies));
    const N = Math.min(G, Math.max(0, Math.round(spec.notches)));
    const p = spec.power;
    const q = V.craterPower;
    const [o2, o3, o5] = V.outline;
    const [gw0, gw1] = V.gullyWidth;
    // Fixed character per gully: how far it strays from even spacing, how deep it is.
    const jitter = (j: number) => {
      const v = Math.sin(j * 12.9898 + 4.1) * 43758.5453;
      return v - Math.floor(v);
    };
    const gullyBearing = new Float64Array(G);
    const gullyDeep = new Float64Array(G);
    const notchOf = new Int32Array(G).fill(-1);
    for (let k = 0; k < N; k++) notchOf[Math.round((k * G) / N)] = k;
    for (let j = 0; j < G; j++) {
      gullyBearing[j] = (2 * Math.PI * (j + (notchOf[j] >= 0 ? 0 : 0.6 * (jitter(j) - 0.5)))) / G;
      gullyDeep[j] = notchOf[j] >= 0 ? 1 : 0.55 + 0.45 * jitter(j + 17);
    }
    // A gully wanders a little as it goes down.
    const wander = (j: number, r: number, radius: number) => 0.09 * Math.sin((r / radius) * 6 + j * 1.7);
    const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

    copies.forEach((c, index) => {
      const { x: cx, y: cy, rim: H } = merged[index];
      if (H <= 0) return;
      this.hadCone = true;
      const R = c.radius;
      const rc = spec.crater * R;
      const D = spec.craterDepth * H;
      const turn = (2.0 * cx) / (w - 1) + (1.4 * cy) / (h - 1); // radians: follows the card, so it glides
      // The summit evens out the ground under it to the level at the card, so the crater stays whole on rough ground.
      const level = sampleField(this.frame.height, w, h, cx / (w - 1), cy / (h - 1));
      const evenIn = V.evenOut[0] * R;
      const evenOut = V.evenOut[1] * R;
      // The crater leans towards the last notch, the lowest, so the crater lake spills there:
      // the weakest vent, so the streams come out at different strengths.
      const lean = N > 0 ? turn + gullyBearing[Math.round(((N - 1) * G) / N)] : turn;
      const ox = V.lopsided * rc * Math.cos(lean);
      const oy = V.lopsided * rc * Math.sin(lean);
      const crest = V.crest * D;
      const reach = R * (1 + o2 + o3 + o5) + 1;
      const x0 = Math.max(0, Math.floor(cx - reach));
      const x1 = Math.min(w - 1, Math.ceil(cx + reach));
      const y0 = Math.max(0, Math.floor(cy - reach));
      const y1 = Math.min(h - 1, Math.ceil(cy + reach));
      for (let j = y0; j <= y1; j++) {
        const dy = j - cy;
        for (let i = x0; i <= x1; i++) {
          const dx = i - cx;
          const r = Math.hypot(dx, dy);
          if (r > reach) continue;
          const cell = j * w + i;
          if (r < evenOut) {
            const m = c.card.strength * (1 - smoothstep(evenIn, evenOut, r)); // eases in with the card
            this.coneMask[cell] += m;
            this.coneFloor[cell] += m * level;
          }
          const theta = Math.atan2(dy, dx);
          const a = theta - turn;
          const foot = R * (1 + o2 * Math.cos(2 * a) + o3 * Math.cos(3 * a + 1.3) + o5 * Math.cos(5 * a + 0.4));
          const t = (r - rc) / (foot - rc);
          if (t >= 1) continue;
          const flank = H * Math.pow(1 - t, p); // above the rim inside it: cut away by the crater
          const rr = Math.hypot(dx - ox, dy - oy) / rc;
          const bowl = H - D + D * rr * rr * rr * (q === 3 ? 1 : Math.pow(rr, q - 3));
          // Smooth minimum (polynomial), small rounding: the rim is a crest, not a shoulder.
          const gap = Math.max(crest - Math.abs(flank - bowl), 0) / crest;
          let z = Math.min(flank, bowl) - gap * gap * crest * 0.25;
          if (t > 0 && G > 0) {
            let g = 0;
            const width2 = (gw0 + gw1 * r) ** 2;
            for (let k = 0; k < G; k++) {
              const lateral = r * wrap(a - gullyBearing[k] - wander(k, r, R));
              if (lateral * lateral > 9 * width2) continue;
              const v = gullyDeep[k] * Math.exp(-(lateral * lateral) / width2);
              if (v > g) g = v;
            }
            z -= spec.gullyDepth * flank * smoothstep(0, 0.35, t) * g;
          }
          for (let k = 0; k < N; k++) {
            const gully = Math.round((k * G) / N);
            const lateral = r * wrap(a - gullyBearing[gully] - wander(gully, r, R));
            const down = (r - rc) / (V.notchReach * R);
            const depth = spec.notchDepth * D * (k === N - 1 ? 1 : 0.82);
            z -= depth * Math.exp(-(lateral * lateral) / (V.notchWidth * V.notchWidth) - down * down);
          }
          if (z > coneLift[cell]) coneLift[cell] = z;
        }
      }
      // Lava pours out just below each notch, onto the flank.
      const flow = (spec.lava ?? 0) * c.card.strength;
      if (flow <= 0) return;
      for (let k = 0; k < N; k++) {
        const gully = Math.round((k * G) / N);
        const r = rc + 2;
        const b = turn + gullyBearing[gully] + wander(gully, r, R);
        this.splat(ventFlow, cx + r * Math.cos(b), cy + r * Math.sin(b), flow * Math.pow(0.6, k));
      }
    });
  }

  /**
   * A landform for every copy in the group: an effect that ends at its radius, in one of a few
   * shapes (see LandShape). On height it goes into `formed`, which is added to the ground whole;
   * on any other field it is a patch of that field with a hard, uneven edge.
   */
  private addShape(
    group: LiveCard[], effect: CardEffect, target: Float32Array,
    radiusMultipliers: Map<LiveCard, number>, modifiers: Map<LiveCard, LiveCard[]>,
  ): void {
    const { w, h, aspect, copies, swell, jag, ridge, base } = this;
    const F = RULES.form;
    const isHeight = effect.field === 'height';
    // Off height only the outline matters: a dome, or level with a hard edge.
    const shape: LandShape = isHeight || effect.shape === 'mound' ? effect.shape! : 'flat';
    const levels = isHeight && (shape === 'flat' || shape === 'terraces');
    copies.fill(0);
    for (const card of group) {
      const R = (effect.radius ?? 0.2) * (radiusMultipliers.get(card) ?? 1) * (w - 1);
      if (R <= 0) continue;
      const weight = card.strength * (isHeight ? heightMultiplier(modifiers.get(card) ?? []) : 1);
      const cx = card.x * (w - 1);
      const cy = card.y * (h - 1);
      const level = levels ? sampleField(base, w, h, card.x, card.y) : 0;
      const reach = R * (1 + 0.5 * F.lobes + 0.5 * F.frayed) + 1;
      const x0 = Math.max(0, Math.floor(cx - reach));
      const x1 = Math.min(w - 1, Math.ceil(cx + reach));
      const y0 = Math.max(0, Math.floor(cy - reach));
      const y1 = Math.min(h - 1, Math.ceil(cy + reach));
      for (let j = y0; j <= y1; j++) {
        const dy = j - cy;
        for (let i = x0; i <= x1; i++) {
          const dx = i - cx;
          const k = j * w + i;
          // Distance as a share of the radius, with the outline pushed in and out by noise.
          const d = (Math.hypot(dx, dy) / R) * (1 + F.lobes * swell[k] + F.frayed * jag[k]);
          if (d >= 1) continue;
          const dome = (1 - d * d) * (1 - d * d);
          const table = 1 - smoothstep(F.wall, 1, d);
          let e: number;
          switch (shape) {
            case 'mound': e = dome; break;
            case 'flat': e = table; break;
            case 'ridges': e = (1 - smoothstep(0.5, 1, d)) * (0.1 + 0.9 * Math.pow(Math.max(0, ridge[k]), 1.6)); break;
            case 'spires': {
              const s = smoothstep(0.04, 0.26, jag[k]);
              e = table * s * s;
              break;
            }
            case 'dunes': {
              const along = ((i / (w - 1)) * 0.8 + ((j / (h - 1)) / aspect) * 0.6) * F.crests * 2 * Math.PI + 5 * swell[k];
              e = table * (0.15 + 0.85 * Math.pow(0.5 + 0.5 * Math.sin(along), 1.5));
              break;
            }
            case 'terraces': {
              const q = (1 - d) * F.steps;
              const step = Math.floor(q);
              e = Math.min(1, (step + smoothstep(0.7, 1, q - step)) / (F.steps - 1));
              break;
            }
            case 'rim': {
              const off = (d - F.rimAt) / F.rimWidth;
              e = off > -1 && off < 1 ? (1 - off * off) * (1 - off * off) : 0;
              break;
            }
          }
          copies[k] += weight * e;
          if (levels) {
            const m = card.strength * table;
            this.formMask[k] += m;
            this.formFloor[k] += m * level;
          }
        }
      }
    }
    const into = isHeight ? this.formed : target;
    if (isHeight) this.hadForm = true;
    const ceiling = RULES.copiesCeiling;
    for (let i = 0; i < this.n; i++) {
      if (copies[i] > 0) into[i] += effect.amount * ceiling * Math.tanh(copies[i] / ceiling);
    }
  }

  /** Add `amount` at a point between cells, shared among the four around it. */
  private splat(field: Float32Array, x: number, y: number, amount: number): void {
    const { w, h } = this;
    const fx = Math.min(w - 1.001, Math.max(0, x));
    const fy = Math.min(h - 1.001, Math.max(0, y));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const i = iy * w + ix;
    field[i] += amount * (1 - tx) * (1 - ty);
    field[i + 1] += amount * tx * (1 - ty);
    field[i + w] += amount * (1 - tx) * ty;
    field[i + w + 1] += amount * tx * ty;
  }

  /**
   * Sum of gaussian falloffs for every copy in the group, into `this.copies`.
   * With `crack` (a width, as a fraction of the world's width) each copy keeps to the
   * fault line running through it instead of spreading evenly: a fissure, not a bowl.
   */
  private addCopies(group: LiveCard[], radius: number, crack = 0): void {
    const copies = this.copies;
    const { fault, faultGrade } = this;
    const crackCells = crack * (this.w - 1);
    const { jag, swell } = this;
    const C = RULES.crack;
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
      // The falloff across and the falloff down multiply to give the falloff at a cell, so
      // work out one row of "across" and reuse it: an exp per row and column, not per cell.
      const across = this.across;
      for (let i = x0; i <= x1; i++) {
        const dx = (i - cx) / sigmaX;
        across[i] = Math.exp(-0.5 * dx * dx);
      }
      const line = crack > 0 ? sampleField(fault, GW, GH, card.x, card.y) : 0;
      for (let j = y0; j <= y1; j++) {
        const dy = (j - cy) / sigmaY;
        const down = card.strength * Math.exp(-0.5 * dy * dy);
        const row = j * GW;
        if (crack > 0) {
          // A crack keeps to its fault line, which follows no row or column: that part is per cell.
          for (let i = x0; i <= x1; i++) {
            // Roughly how many crack widths this one is from the card's fault line. The width
            // swells and narrows along the crack, and its middle wanders off the line a little.
            const k = row + i;
            const width = crackCells * (1 + C.widen * swell[k]);
            const off = (fault[k] - line) / (faultGrade[k] * width) + C.wander * jag[k];
            const depth = 1 + C.deepen * swell[k] + C.jagged * jag[k];
            copies[k] += down * across[i] * depth * Math.exp(-0.5 * off * off);
          }
        } else {
          for (let i = x0; i <= x1; i++) copies[row + i] += down * across[i];
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
