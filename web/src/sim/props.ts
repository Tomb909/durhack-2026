// Where the objects of word cards stand. No Three.js in here: a world frame and
// the cards in, a list of placed objects out.
//
// Like the rest of the world there is no pair logic: an object only knows its own
// habitat. A boat finds water because its habitat is water, the way LIFE only grows
// where it is warm and wet. Placement is seeded from the card's id (and which copy of it
// this is), never its position: moving a card carries its objects along as they are,
// instead of re-rolling which way each one faces. The same cards on the same world
// always put the same objects in the same places.
import type { CardDef, Habitat, Prop } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { hashText, seeded } from '../cards/words';
import { sampleField, type WorldFrame } from './world';

/**
 * Edge of an object's unit cube, as a fraction of the world's width (the world is 10 scene units
 * wide; a tree is about 0.04 of it tall, a house about 0.02). Objects are drawn a little larger than
 * life, because they are seen small and from far away and have to read as what they are.
 */
export const PROP_SIZE = { small: 0.028, medium: 0.05, large: 0.085, landmark: 0.14 } as const;
/**
 * The same edge from the real thing's size in metres. Small things are drawn much larger than
 * life and huge ones smaller, or a cat would be a speck and a cathedral would cover the world:
 * a cat (0.5 m) 0.021, a cow (2.5 m) 0.032, a house (8 m) 0.051, a lighthouse (30 m) 0.086,
 * a castle (60 m) 0.113, and nothing past 0.15.
 */
export function propSize(prop: Prop): number {
  if (prop.metres === undefined) return PROP_SIZE[prop.scale];
  return Math.min(0.15, Math.max(LEAST[prop.count], 0.022 * prop.metres ** 0.4));
}
/**
 * The least an object is drawn at, by how many of it there are. One thing alone is all its card
 * has to show, so it is drawn big enough to be made out from across the table whatever its real
 * size (a lone cat, a heart, a house: about the size of a castle); a few of something a little
 * less so; a crowd is seen as a crowd.
 */
const LEAST = { one: 0.11, few: 0.055, many: 0.02 } as const;
/** How many objects a card puts down. */
const COUNT = { one: [1, 1], few: [3, 4], many: [7, 10] } as const;
/** How far an object will move to find its habitat, as a fraction of the world's width. */
const REACH = 0.2;
/** Water deeper than this floats a boat; land wetter than this is not dry ground. */
const AFLOAT = 0.003;
const DRY = 0.0003;

export interface PlacedObject {
  def: CardDef;
  /** Table position, 0..1 each way. */
  x: number;
  y: number;
  /** Height (sim units) of the surface it stands or floats on. */
  ground: number;
  /** Raised this far above that surface (fraction of the world's width): for things in the air. */
  hover: number;
  /** Edge of the unit cube, fraction of the world's width. */
  size: number;
  /** Turned this many radians about the vertical. */
  turn: number;
  /** 0..1, follows the card's strength: objects grow in and shrink away with the card. */
  grow: number;
  /** 0..1, so copies of the same object do not move in step. */
  phase: number;
  afloat: boolean;
}

/**
 * How far below the ground at its middle an object may stand, as a share of its size. On a steep
 * slope the lowest ground under it is far down: standing there would bury it in the hillside.
 */
const MOST_SUNK = 0.6;

/**
 * A number from a card's id and which copy of it this is (0 for the first on the table).
 * Not from its position: then every nudge of the card would turn its objects a new way.
 */
function seedFor(card: LiveCard, copy: number): number {
  const id = parseInt(hashText(card.def.id), 16);
  return (id ^ Math.imul(copy + 1, 73856093)) >>> 0;
}

interface Grid {
  frame: WorldFrame;
  /** Water depth at a cell (negative: dry). */
  depth(i: number, j: number): number;
}

function grid(frame: WorldFrame): Grid {
  const { w, height, waterSurface } = frame;
  return { frame, depth: (i, j) => waterSurface[j * w + i] - height[j * w + i] };
}

/**
 * The nearest cell to (x, y) that suits, within `reach` (fraction of the width).
 * Cells are square in the world, so distance in cells is distance on the ground.
 */
function nearest(g: Grid, x: number, y: number, reach: number, suits: (i: number, j: number) => boolean): { x: number; y: number } | null {
  const { w, h } = g.frame;
  const ci = x * (w - 1);
  const cj = y * (h - 1);
  const r = Math.ceil(reach * (w - 1));
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(h - 1, Math.ceil(cj + r)); j++) {
    for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(w - 1, Math.ceil(ci + r)); i++) {
      const d = (i - ci) ** 2 + (j - cj) ** 2;
      if (d >= bestD || d > r * r || !suits(i, j)) continue;
      bestD = d;
      best = { x: i / (w - 1), y: j / (h - 1) };
    }
  }
  return best;
}

/**
 * 1 where open water lies within three cells (a 7 x 7 square). Worked out once for a whole
 * placement: asking it afresh for every cell looked at made a few shore objects cost tens of
 * milliseconds, on every frame while the world settled.
 */
function nearOpenWater(g: Grid): Uint8Array {
  const { w, h } = g.frame;
  const open = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (g.depth(i, j) > AFLOAT) open[j * w + i] = 1;
  const along = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let any = 0;
      for (let ii = Math.max(0, i - 3); ii <= Math.min(w - 1, i + 3) && !any; ii++) any = open[j * w + ii];
      along[j * w + i] = any;
    }
  }
  const near = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let any = 0;
      for (let jj = Math.max(0, j - 3); jj <= Math.min(h - 1, j + 3) && !any; jj++) any = along[jj * w + i];
      near[j * w + i] = any;
    }
  }
  return near;
}

/** Place every object of every card that has one. */
export function placeProps(frame: WorldFrame, cards: LiveCard[]): PlacedObject[] {
  const out: PlacedObject[] = [];
  const g = grid(frame);
  const { w, h, mask, aspect } = frame;
  const cell = (x: number, y: number) => ({ i: Math.round(x * (w - 1)), j: Math.round(y * (h - 1)) });
  let byWater: Uint8Array | null = null; // only worked out if some object wants a shore
  // Cards in a fixed order (by id, then place), so who gets a contested spot never depends on list order.
  const order = cards
    .filter((c) => c.def.prop && c.strength > 0)
    .sort((a, b) => (a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : a.x - b.x || a.y - b.y));
  const copies = new Map<string, number>();
  for (const card of order) {
    const prop = card.def.prop!;
    const copy = copies.get(card.def.id) ?? 0;
    copies.set(card.def.id, copy + 1);
    const random = seeded(seedFor(card, copy));
    const size = propSize(prop);
    const [lo, hi] = COUNT[prop.count];
    let count = lo + Math.floor(random() * (hi - lo + 1));
    if (prop.scale === 'landmark') count = Math.min(count, 3); // a landmark is rare by nature
    if (prop.scale === 'large') count = Math.min(count, 5);
    const spread = prop.count === 'one' ? 0 : prop.count === 'few' ? 0.03 + 1.6 * size : 0.07 + 2.6 * size;
    // Keep this far inside the play area (in cells), so nothing hangs over the edge.
    const margin = 1.5 + size * (w - 1) * 0.6;
    const spacing = size * 0.9;
    const mine: PlacedObject[] = [];
    const clear = (x: number, y: number) =>
      mine.every((o) => Math.hypot(o.x - x, (o.y - y) / aspect) >= spacing) &&
      out.every((o) => Math.hypot(o.x - x, (o.y - y) / aspect) >= Math.max(spacing, o.size * 0.9) * 0.7);
    const inside = (i: number, j: number) => mask[j * w + i] >= margin;
    const habitat: Habitat = prop.habitat;
    const turnBase = random() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const angle = k * 2.39996 + random() * 0.6; // golden angle: an even scatter
      const r = count === 1 ? 0 : spread * Math.sqrt((k + 0.5) / count);
      const cx = Math.min(1, Math.max(0, card.x + Math.cos(angle) * r));
      const cy = Math.min(1, Math.max(0, card.y + Math.sin(angle) * r * aspect));
      const turn = prop.count === 'one' ? turnBase : random() * Math.PI * 2;
      const phase = random();
      const lift = random();
      let at: { x: number; y: number } | null = null;
      let afloat = false;
      const here = cell(cx, cy);
      const okHere = inside(here.i, here.j) && clear(cx, cy);
      // Depth exactly where it would stand (between cells), not just at the nearest cell.
      const wetHere = sampleField(frame.waterSurface, w, h, cx, cy) - sampleField(frame.height, w, h, cx, cy);
      if (habitat === 'water') {
        // Float on the nearest water within reach; with none, stay beached at the card.
        // Open water, not a thin river: wet a couple of cells round about too.
        const open = (i: number, j: number) =>
          g.depth(i, j) > AFLOAT && [[2, 0], [-2, 0], [0, 2], [0, -2]].every(([di, dj]) => {
            const ii = Math.min(w - 1, Math.max(0, i + di));
            const jj = Math.min(h - 1, Math.max(0, j + dj));
            return g.depth(ii, jj) > AFLOAT;
          });
        const wet = (i: number, j: number) => open(i, j) && inside(i, j) && clear(i / (w - 1), j / (h - 1));
        at = okHere && open(here.i, here.j) && wetHere > AFLOAT ? { x: cx, y: cy } : nearest(g, cx, cy, REACH, wet);
        afloat = !!at;
        if (!at) {
          const dry = (i: number, j: number) => g.depth(i, j) < DRY && inside(i, j) && clear(i / (w - 1), j / (h - 1));
          at = okHere && g.depth(here.i, here.j) < DRY && wetHere < DRY ? { x: cx, y: cy } : nearest(g, cx, cy, REACH * 0.5, dry);
        }
      } else if (habitat === 'shore') {
        // Dry ground with open water a few steps away; with no water anywhere near, any dry ground.
        const near = (byWater ??= nearOpenWater(g));
        // The cheap tests first; `clear` looks at every object placed so far.
        const by = (i: number, j: number) => g.depth(i, j) < DRY && near[j * w + i] === 1 && inside(i, j) && clear(i / (w - 1), j / (h - 1));
        at = nearest(g, cx, cy, REACH, by);
        if (!at) {
          const dry = (i: number, j: number) => g.depth(i, j) < DRY && inside(i, j) && clear(i / (w - 1), j / (h - 1));
          at = okHere && g.depth(here.i, here.j) < DRY && wetHere < DRY ? { x: cx, y: cy } : nearest(g, cx, cy, REACH * 0.5, dry);
        }
      } else if (habitat === 'land') {
        // Never under water: move to the nearest dry ground, or leave this one out.
        const dry = (i: number, j: number) => g.depth(i, j) < DRY && inside(i, j) && clear(i / (w - 1), j / (h - 1));
        at = okHere && g.depth(here.i, here.j) < DRY && wetHere < DRY ? { x: cx, y: cy } : nearest(g, cx, cy, REACH, dry);
      } else {
        // In the air, or anywhere: where it falls, as long as it is inside the play area.
        const ok = (i: number, j: number) => inside(i, j) && clear(i / (w - 1), j / (h - 1));
        at = okHere ? { x: cx, y: cy } : nearest(g, cx, cy, REACH * 0.5, ok);
        if (at) {
          const c = cell(at.x, at.y);
          afloat = habitat === 'anywhere' && g.depth(c.i, c.j) > AFLOAT;
        }
      }
      if (!at) continue;
      // Stand on the lowest ground under the footprint, so nothing hangs in the air on a slope.
      const foot = size * 0.35;
      let ground: number;
      if (afloat) ground = sampleField(frame.waterSurface, w, h, at.x, at.y);
      else {
        ground = Infinity;
        let middle = 0;
        for (const [dx, dy] of [[0, 0], [foot, 0], [-foot, 0], [0, foot], [0, -foot]]) {
          const sx = at.x + dx;
          const sy = at.y + dy * aspect;
          const here = Math.max(sampleField(frame.height, w, h, sx, sy), habitat === 'land' || habitat === 'shore' ? -Infinity : sampleField(frame.waterSurface, w, h, sx, sy));
          if (dx === 0 && dy === 0) middle = here;
          ground = Math.min(ground, here);
        }
        ground = Math.max(ground, middle - MOST_SUNK * size);
      }
      const placed: PlacedObject = {
        def: card.def, x: at.x, y: at.y, ground,
        hover: habitat === 'air' ? 0.035 + 0.03 * lift + size * 0.5 : 0,
        size, turn, grow: card.strength, phase, afloat,
      };
      mine.push(placed);
      out.push(placed);
    }
  }
  return out;
}
