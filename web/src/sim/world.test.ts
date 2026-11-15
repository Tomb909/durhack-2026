import { describe, expect, it } from 'vitest';
import { cardDef, type CardDef } from '../cards/defs';
import { MADE, NEXT_TO, combine, settlementsOf } from '../cards/recipes';
import { cleanCard } from '../cards/words';
import type { LiveCard } from '../cards/store';
import { RULES, WorldSim, gridHeight, sampleField, type WorldFrame, type WorldShape } from './world';

let n = 0;
/** A card on the table, or (volcano, village, town, city) one of the things cards make together, put down directly. */
function card(id: string, x: number, y: number, strength = 1, angle = 0): LiveCard {
  const def = cardDef(id) ?? (MADE as Record<string, CardDef>)[id];
  return { key: `t${n++}`, def, source: 'sim', x, y, angle, targetAngle: angle, tx: x, ty: y, vx: 0, vy: 0, strength, fade: strength, present: true, visible: true, age: 9 };
}

function settle(cards: LiveCard[]): WorldFrame {
  return new WorldSim().settleNow(cards);
}

/** Copy the numbers we compare, since each sim owns its arrays. */
function at(frame: WorldFrame, field: Float32Array, x: number, y: number): number {
  return sampleField(field, frame.w, frame.h, x, y);
}

const fractionWhere = (frame: WorldFrame, test: (i: number) => boolean) => {
  let count = 0;
  const n = frame.w * frame.h;
  for (let i = 0; i < n; i++) if (test(i)) count++;
  return count / n;
};
const flooded = (f: WorldFrame) => fractionWhere(f, (i) => f.height[i] < f.seaLevel);

describe('empty world', () => {
  const f = settle([]);
  it('is mild, dry, lifeless, gently hilly, and nowhere under water', () => {
    expect(at(f, f.temperature, 0.3, 0.3)).toBeCloseTo(0, 1);
    expect(at(f, f.wetness, 0.3, 0.3)).toBeLessThan(RULES.rainStart);
    expect(Math.max(...f.vegetation)).toBe(0);
    expect(Math.max(...f.precipitation)).toBe(0);
    expect(flooded(f)).toBe(0);
    expect(fractionWhere(f, (i) => f.waterSurface[i] > f.height[i])).toBe(0);
    expect(Math.max(...f.height)).toBeLessThan(0.12);
    expect(Math.max(...f.height) - Math.min(...f.height)).toBeGreaterThan(0.04);
  });
});

describe('mountain', () => {
  it('raises the land where it is placed, and nowhere far away', () => {
    const f = settle([card('mountain', 0.2, 0.25)]);
    const empty = settle([]);
    expect(at(f, f.height, 0.2, 0.25)).toBeGreaterThan(at(empty, empty.height, 0.2, 0.25) + 0.12);
    expect(at(f, f.height, 0.85, 0.8)).toBeCloseTo(at(empty, empty.height, 0.85, 0.8), 3);
  });
  it('gets taller with a second copy beside it, and levels off', () => {
    const peak = (count: number) => {
      const cards = Array.from({ length: count }, (_, i) => card('mountain', 0.3 + 0.03 * i, 0.3));
      return Math.max(...settle(cards).height);
    };
    const [one, two, three, six, seven] = [peak(1), peak(2), peak(3), peak(6), peak(7)];
    expect(two).toBeGreaterThan(one * 1.4);
    expect(three).toBeGreaterThan(two * 1.1);
    expect(seven - six).toBeLessThan((two - one) * 0.25);
  });
  it('makes two separate ranges when copies are far apart', () => {
    const f = settle([card('mountain', 0.15, 0.3), card('mountain', 0.75, 0.3)]);
    expect(at(f, f.height, 0.45, 0.3)).toBeLessThan(at(f, f.height, 0.15, 0.3) * 0.6);
  });
});

describe('BIG modifier', () => {
  it('makes a modified mountain taller as well as wider', () => {
    const empty = settle([]);
    const mountain = settle([card('mountain', 0.5, 0.5)]);
    const bigMountain = settle([card('big', 0.65, 0.5), card('mountain', 0.5, 0.5)]);
    const lift = (frame: WorldFrame) => at(frame, frame.height, 0.5, 0.5) - at(empty, empty.height, 0.5, 0.5);
    expect(lift(bigMountain)).toBeGreaterThan(lift(mountain) * 1.35);
  });

  it('widens the local influence radius of the nearest card to either side', () => {
    const empty = settle([]);
    const mountain = settle([card('mountain', 0.5, 0.5)]);
    const bigMountain = settle([card('big', 0.65, 0.5), card('mountain', 0.5, 0.5)]);
    const distantLift = (frame: WorldFrame) => at(frame, frame.height, 0.74, 0.5) - at(empty, empty.height, 0.74, 0.5);
    expect(distantLift(bigMountain)).toBeGreaterThan(distantLift(mountain) * 1.5);
  });

  it('attaches by 2D proximity and ignores cards outside the larger range', () => {
    const mountain = settle([card('mountain', 0.5, 0.5)]);
    const bigBelow = settle([card('mountain', 0.5, 0.5), card('big', 0.5, 0.85)]);
    const bigTooFar = settle([card('big', 0.81, 0.5), card('mountain', 0.5, 0.5)]);
    const nearbyLift = (frame: WorldFrame) => at(frame, frame.height, 0.5, 0.7);
    expect(nearbyLift(bigBelow)).toBeGreaterThan(nearbyLift(mountain));
    expect(bigTooFar.height).toEqual(mountain.height);
  });

  it('stacks nearby BIG modifiers and leaves global effects alone', () => {
    const empty = settle([]);
    const oneBig = settle([card('big', 0.4, 0.5), card('mountain', 0.5, 0.5)]);
    const twoBig = settle([card('big', 0.36, 0.5), card('big', 0.44, 0.5), card('mountain', 0.5, 0.5)]);
    const water = settle([card('rain', 0.5, 0.5)]);
    const bigWater = settle([card('big', 0.4, 0.5), card('rain', 0.5, 0.5)]);
    const distantLift = (frame: WorldFrame) => at(frame, frame.height, 0.74, 0.5) - at(empty, empty.height, 0.74, 0.5);
    expect(distantLift(twoBig)).toBeGreaterThan(distantLift(oneBig));
    expect(at(bigWater, bigWater.wetness, 0.75, 0.5)).toBeGreaterThan(at(water, water.wetness, 0.75, 0.5) + 0.08);
    expect(bigWater.seaLevel).toBe(water.seaLevel);
  });
});

describe('rain', () => {
  it('rains near the card and forms rivers or lakes', () => {
    const f = settle([card('rain', 0.35, 0.35)]);
    expect(at(f, f.precipitation, 0.35, 0.35)).toBeGreaterThan(0.4);
    expect(at(f, f.precipitation, 0.95, 0.9)).toBe(0);
    const wetLand = fractionWhere(f, (i) => f.height[i] >= f.seaLevel && f.waterSurface[i] > f.height[i]);
    expect(wetLand).toBeGreaterThan(0.002);
  });
  it('rains harder with each copy', () => {
    const rain = (count: number) => {
      const f = settle(Array.from({ length: count }, (_, i) => card('rain', 0.3 + 0.04 * i, 0.3)));
      return f.precipitation.reduce((a, b) => a + b, 0);
    };
    expect(rain(2)).toBeGreaterThan(rain(1) * 1.25);
    expect(rain(3)).toBeGreaterThan(rain(2) * 1.1);
  });
  it('never raises the sea, however many copies', () => {
    const f = settle(Array.from({ length: 5 }, (_, i) => card('rain', 0.2 + 0.05 * i, 0.2)));
    expect(f.seaLevel).toBe(RULES.seaBase);
    expect(flooded(f)).toBe(0);
  });
});

const open = (f: WorldFrame, x: number, y: number) => at(f, f.waterSurface, x, y) - at(f, f.height, x, y);
const openWater = (f: WorldFrame) => fractionWhere(f, (i) => f.waterSurface[i] - f.height[i] > 0.002);

describe('lake', () => {
  it('digs a basin at the card and fills it, with no rain', () => {
    const empty = settle([]);
    const f = settle([card('lake', 0.45, 0.5)]);
    expect(at(f, f.height, 0.45, 0.5)).toBeLessThan(at(empty, empty.height, 0.45, 0.5) - 0.01);
    expect(open(f, 0.45, 0.5)).toBeGreaterThan(0.01);
    expect(Math.max(...f.precipitation)).toBe(0);
    expect(open(f, 0.85, 0.2)).toBeLessThan(0);
    expect(openWater(f)).toBeGreaterThan(0.005);
    expect(openWater(f)).toBeLessThan(0.06);
  });
  // Lakes all over the table, on the flat and on a mountainside.
  const places: [number, number][] = [[0.4, 0.42], [0.7, 0.6], [0.25, 0.3], [0.5, 0.5], [0.6, 0.25], [0.3, 0.7], [0.8, 0.4], [0.15, 0.55]];
  const RADIUS = 0.075;
  /** Each cell within `share` of a lake's radius, with its distance from the card as a share of the radius. */
  const around = (f: WorldFrame, x: number, y: number, share: number, each: (k: number, d: number) => void) => {
    for (let j = 0; j < f.h; j++) {
      for (let i = 0; i < f.w; i++) {
        const d = Math.hypot(i / (f.w - 1) - x, (j / (f.h - 1) - y) / f.aspect) / RADIUS;
        if (d < share) each(j * f.w + i, d);
      }
    }
  };
  it('fills its basin, wherever it is put (it used to fill a half, or a sixth)', () => {
    for (const cards of [...places.map(([x, y]) => [card('lake', x, y)]), [card('mountain', 0.3, 0.4), card('lake', 0.45, 0.45)]]) {
      const f = settle(cards);
      const lake = cards[cards.length - 1];
      let cells = 0, wet = 0;
      // Well inside the shoreline (which wanders in and out of the plain oval).
      around(f, lake.x, lake.y, 0.8, (k) => {
        cells++;
        if (f.waterSurface[k] - f.height[k] > 0.0005) wet++;
      });
      expect(wet / cells, `lake at ${lake.x},${lake.y}`).toBeGreaterThan(0.97);
    }
  });
  it('has banks, not a cliff, where the land round it is higher', () => {
    for (const [x, y] of places) {
      const f = settle([card('lake', x, y)]);
      let step = 0;
      around(f, x, y, 2.2, (k, d) => {
        if (d < 0.7) return;
        step = Math.max(step, Math.abs(f.height[k] - f.height[k + 1]), Math.abs(f.height[k] - f.height[k + f.w]));
      });
      // The whole lake is 0.03 deep: no one step at its edge is a third of that. (They were 0.03 to 0.05.)
      expect(step, `lake at ${x},${y}`).toBeLessThan(0.01);
    }
  });
  it('holds water on a mountainside too', () => {
    const f = settle([card('mountain', 0.4, 0.5), card('lake', 0.52, 0.5)]);
    expect(open(f, 0.52, 0.5)).toBeGreaterThan(0.008);
  });
  it('is wider with BIG beside it', () => {
    const plain = settle([card('lake', 0.45, 0.5)]);
    const big = settle([card('lake', 0.45, 0.5), card('big', 0.6, 0.5)]);
    expect(openWater(big)).toBeGreaterThan(openWater(plain) * 1.5);
  });
  it('is one bigger lake, between them, when two LAKE cards lie next to each other', () => {
    const one = settle([card('lake', 0.45, 0.5)]);
    const two = settle([card('lake', 0.4, 0.5), card('lake', 0.56, 0.5)]);
    expect(open(two, 0.48, 0.5)).toBeGreaterThan(0.01);
    expect(openWater(two)).toBeGreaterThan(openWater(one) * 1.5);
    // At no distance do they cancel each other out (half way between joined and apart, they did).
    for (let gap = 0.2; gap <= 0.34; gap += 0.01) {
      const f = settle([card('lake', 0.5 - gap / 2, 0.5), card('lake', 0.5 + gap / 2, 0.5)]);
      expect(openWater(f), `lakes ${gap.toFixed(2)} apart`).toBeGreaterThan(openWater(one) * 1.5);
    }
    // Far apart they stay two lakes, with dry land between.
    const apart = settle([card('lake', 0.25, 0.5), card('lake', 0.7, 0.5)]);
    expect(open(apart, 0.475, 0.5)).toBeLessThan(0);
    expect(open(apart, 0.25, 0.5)).toBeGreaterThan(0.01);
    expect(open(apart, 0.7, 0.5)).toBeGreaterThan(0.01);
  });
  it('fills in step with the card as it fades', () => {
    const half = settle([card('lake', 0.45, 0.5, 0.5)]);
    const full = settle([card('lake', 0.45, 0.5)]);
    expect(open(half, 0.45, 0.5)).toBeLessThan(open(full, 0.45, 0.5));
    expect(openWater(settle([card('lake', 0.45, 0.5, 0)]))).toBe(0);
  });
});

describe('river', () => {
  const wetAt = (f: WorldFrame, x: number, y: number) => {
    // The strongest river crossing the table near this x, within a wide band about y.
    let best = 0;
    for (let dy = -0.3; dy <= 0.3; dy += 0.005) for (let dx = -0.04; dx <= 0.04; dx += 0.005) best = Math.max(best, at(f, f.river, x + dx, y + dy));
    return best;
  };
  it('runs through the card with no rain at all', () => {
    const f = settle([card('river', 0.5, 0.5)]);
    expect(at(f, f.river, 0.5, 0.5)).toBeGreaterThan(0.5);
    expect(Math.max(...f.precipitation)).toBe(0);
    expect(fractionWhere(f, (i) => f.river[i] > 0.5)).toBeGreaterThan(0.002);
    // It reaches the edge of the world.
    const { w, h } = f;
    expect(fractionWhere(f, (i) => f.river[i] > 0.5 && (i % w < 2 || i % w > w - 3 || i < 2 * w || i >= (h - 2) * w))).toBeGreaterThan(0);
  });
  it('flows from a mountain, through the card, and on away from it', () => {
    const right = settle([card('mountain', 0.25, 0.5), card('river', 0.5, 0.5)]);
    expect(wetAt(right, 0.4, 0.5)).toBeGreaterThan(0.5); // between the mountain and the card
    expect(wetAt(right, 0.8, 0.5)).toBeGreaterThan(0.5); // beyond the card
    expect(at(right, right.height, 0.3, 0.5)).toBeGreaterThan(at(right, right.height, 0.5, 0.5));
    const left = settle([card('mountain', 0.75, 0.5), card('river', 0.5, 0.5)]);
    expect(wetAt(left, 0.2, 0.5)).toBeGreaterThan(0.5);
  });
  it('always runs downhill', () => {
    const sim = new WorldSim();
    const f = sim.settleNow([card('mountain', 0.2, 0.3), card('river', 0.55, 0.6)]);
    // Wherever the river is strong, some neighbour is lower: no stretch is left standing in a pit.
    const { w, h } = f;
    let stuck = 0, strong = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (f.river[i] < 0.9) continue;
      strong++;
      const level = f.height[i];
      const lower = [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1].some((k) => f.height[k] < level);
      if (!lower) stuck++;
    }
    expect(strong).toBeGreaterThan(40);
    expect(stuck / strong).toBeLessThan(0.02);
  });
  /** The cells where the river runs strongly. */
  const course = (f: WorldFrame) => {
    const cells: number[] = [];
    for (let i = 0; i < f.river.length; i++) if (f.river[i] > 0.5) cells.push(i);
    return cells;
  };
  /** The share of river `a` that lies within `reach` cells of river `b`. */
  const kept = (a: WorldFrame, b: WorldFrame, reach = 4) => {
    const { w, h } = a;
    const near = new Uint8Array(w * h);
    for (const i of course(b)) {
      const x = i % w, y = (i - x) / w;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) near[ny * w + nx] = 1;
      }
    }
    const mine = course(a);
    return mine.length ? mine.filter((i) => near[i]).length / mine.length : 1;
  };
  it('keeps its course when the card moves a little (it used to leap across the table)', { timeout: 20_000 }, () => {
    // A river dragged in small steps across open ground, past a mountain, and beside a lake.
    const others = [[], [card('mountain', 0.25, 0.3)], [card('lake', 0.7, 0.65)]];
    let worst = 1, total = 0, count = 0;
    for (const rest of others) {
      for (const [x0, y0, dx, dy] of [[0.2, 0.3, 0.006, 0.004], [0.3, 0.75, 0.007, -0.004], [0.75, 0.25, -0.006, 0.005], [0.5, 0.15, 0.002, 0.008]]) {
        // At four places along the drag: the river before and after one small move (under a hundredth of the table).
        for (let place = 0; place < 4; place++) {
          const x = x0 + dx * place * 18, y = y0 + dy * place * 18;
          const before = settle([...rest, card('river', x, y)]);
          const after = settle([...rest, card('river', x + dx, y + dy)]);
          // (Coming up to a lake is no exception: the river bends towards it little by little. It used to leap to it.)
          const share = Math.min(kept(before, after, 6), kept(after, before, 6));
          worst = Math.min(worst, share);
          total += share;
          count++;
        }
      }
    }
    // Before: 0.91 on average, and at the worst places none of the river stayed where it was.
    expect(total / count).toBeGreaterThan(0.97);
    expect(worst).toBeGreaterThan(0.8);
  });
  it('runs through a lake it is put beside, and on from it', { timeout: 30_000 }, () => {
    /** The strongest river within `reach` of a place. */
    const riverNear = (f: WorldFrame, x: number, y: number, reach: number) => {
      let best = 0;
      for (let oy = -reach; oy <= reach; oy += 0.006) for (let ox = -reach; ox <= reach; ox += 0.006) best = Math.max(best, at(f, f.river, x + ox, y + oy));
      return best;
    };
    for (const [rx, ry] of [[0.62, 0.5], [0.45, 0.38], [0.36, 0.6], [0.5, 0.66]]) {
      const f = settle([card('lake', 0.48, 0.5), card('river', rx, ry)]);
      // The river passes the card and meets the lake (inside it there is only the lake)...
      expect(riverNear(f, rx, ry, 0.012), `river at ${rx},${ry}: at the card`).toBeGreaterThan(0.5);
      expect(riverNear(f, 0.48, 0.5, 0.1), `river at ${rx},${ry}: at the lake's shore`).toBeGreaterThan(0.5);
      // ...the lake still full, and the river carrying on to the edge of the world.
      expect(open(f, 0.48, 0.5)).toBeGreaterThan(0.01);
      const { w, h } = f;
      expect(fractionWhere(f, (i) => f.river[i] > 0.5 && (i % w < 2 || i % w > w - 3 || i < 2 * w || i >= (h - 2) * w))).toBeGreaterThan(0);
    }
    // Sliding the card up to the lake, the river bends to it a little at a time: no leap anywhere on the way.
    for (const [ux, uy] of [[1, 0], [-1, 0], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
      let before: WorldFrame | null = null;
      for (let d = 0.42; d >= 0.06; d -= 0.01) {
        const f = settle([card('lake', 0.48, 0.5), card('river', 0.48 + ux * d, 0.5 + uy * d * 1.3)]);
        if (before) expect(Math.min(kept(before, f, 6), kept(f, before, 6)), `river ${d.toFixed(2)} from the lake, towards ${ux},${uy}`).toBeGreaterThan(0.6);
        before = f;
      }
    }
    // Further off, the river goes its own way.
    const apart = settle([card('lake', 0.2, 0.3), card('river', 0.7, 0.7)]);
    const alone = settle([card('river', 0.7, 0.7)]);
    expect(kept(apart, alone)).toBeGreaterThan(0.9);
  });
  it('fills a ravine it runs into and leaves by the brim (it used to cut a trench as deep as the ravine from there to the edge)', () => {
    const land = [card('mountain', 0.14, 0.27), card('mountain', 0.14, 0.81), card('ravine', 0.66, 0.56)];
    const dry = settle(land);
    const f = settle([...land, card('river', 0.47, 0.52)]);
    // The ravine is full of water...
    expect(at(f, f.waterSurface, 0.66, 0.56) - at(f, f.height, 0.66, 0.56)).toBeGreaterThan(0.05);
    // ...and beyond it the river runs in its own small valley, cutting deep only through a rise in its way.
    expect(fractionWhere(f, (i) => dry.height[i] - f.height[i] > 0.02)).toBeLessThan(0.015);
    // It still reaches the edge of the world.
    const { w, h } = f;
    expect(fractionWhere(f, (i) => f.river[i] > 0.5 && (i % w < 2 || i % w > w - 3 || i < 2 * w || i >= (h - 2) * w))).toBeGreaterThan(0);
  });
  it('fills a lake it runs into without draining it', () => {
    const f = settle([card('mountain', 0.15, 0.5), card('river', 0.4, 0.5), card('lake', 0.62, 0.5)]);
    expect(openWater(f)).toBeGreaterThan(0.004);
  });
});

describe('wind', () => {
  it('blows in the card orientation, including its reverse', () => {
    const east = settle([card('wind', 0.5, 0.5, 1, 0)]);
    const west = settle([card('wind', 0.5, 0.5, 1, Math.PI)]);
    expect(at(east, east.windX, 0.5, 0.5)).toBeGreaterThan(0.95);
    expect(at(east, east.windY, 0.5, 0.5)).toBeCloseTo(0, 3);
    expect(at(west, west.windX, 0.5, 0.5)).toBeLessThan(-0.95);
    expect(at(west, west.windY, 0.5, 0.5)).toBeCloseTo(0, 3);
  });

  it('scatters FOREST downwind into a narrow line of trees', () => {
    const cards = [card('forest', 0.35, 0.5), card('rain', 0.35, 0.5)];
    const still = settle(cards);
    const eastward = settle([...cards, card('wind', 0.35, 0.5)]);
    const westward = settle([...cards, card('wind', 0.35, 0.5, 1, Math.PI)]);
    expect(at(eastward, eastward.vegetation, 0.68, 0.5)).toBeGreaterThan(at(still, still.vegetation, 0.68, 0.5) + 0.15);
    expect(at(eastward, eastward.vegetation, 0.68, 0.5)).toBeGreaterThan(at(westward, westward.vegetation, 0.68, 0.5) + 0.15);
    expect(at(eastward, eastward.vegetation, 0.68, 0.5)).toBeGreaterThan(at(eastward, eastward.vegetation, 0.68, 0.56) + 0.2);
  });

  it('turns nearby ICE and WIND into a cold, downwind snow squall', () => {
    const ice = settle([card('ice', 0.5, 0.5)]);
    const blizzard = settle([card('ice', 0.5, 0.5), card('wind', 0.5, 0.5)]);
    expect(at(blizzard, blizzard.temperature, 0.62, 0.5)).toBeLessThan(RULES.freezing);
    expect(at(blizzard, blizzard.precipitation, 0.62, 0.5)).toBeGreaterThan(at(ice, ice.precipitation, 0.62, 0.5) + 0.25);
  });

  it('scours wet snow from high ground only when wind is present', () => {
    const mountain = settle([card('mountain', 0.5, 0.5), card('rain', 0.5, 0.5)]);
    const storm = settle([card('mountain', 0.5, 0.5), card('rain', 0.5, 0.5), card('wind', 0.5, 0.5)]);
    expect(Math.max(...mountain.snowBlow)).toBe(0);
    expect(Math.max(...storm.snowBlow)).toBeGreaterThan(0.1);
  });
});

describe('climate comes from combinations, not single cards', () => {
  it('sun alone dries the land (desert): hot and no rain', () => {
    const f = settle([card('sun', 0.5, 0.5)]);
    expect(at(f, f.temperature, 0.5, 0.5)).toBeGreaterThan(0.45);
    expect(at(f, f.wetness, 0.5, 0.5)).toBeLessThan(0.1);
  });
  it('ice beside a mountain freezes the peak before the lowland', () => {
    const f = settle([card('mountain', 0.3, 0.3), card('ice', 0.48, 0.3)]);
    const peak = at(f, f.temperature, 0.3, 0.3);
    const lowland = at(f, f.temperature, 0.66, 0.3);
    expect(peak).toBeLessThan(RULES.freezing);
    expect(peak).toBeLessThan(lowland);
  });
  it('forest alone is grass and scrub; forest needs it warm and wet enough', () => {
    const forestOnly = settle([card('forest', 0.4, 0.4)]);
    expect(at(forestOnly, forestOnly.vegetation, 0.4, 0.4)).toBeGreaterThan(0.15);
    expect(fractionWhere(forestOnly, (i) => forestOnly.vegetation[i] > 0.4)).toBe(0);

    const withWater = settle([card('forest', 0.4, 0.4), card('rain', 0.4, 0.4)]);
    const cover = fractionWhere(withWater, (i) => withWater.vegetation[i] > 0.4);
    expect(cover).toBeGreaterThan(0.03);

    const desert = settle([card('forest', 0.4, 0.4), card('sun', 0.4, 0.4)]);
    expect(at(desert, desert.vegetation, 0.4, 0.4)).toBeLessThan(0.15);

    const frozen = settle([card('forest', 0.4, 0.4), card('rain', 0.4, 0.4), card('ice', 0.4, 0.4), card('ice', 0.42, 0.4)]);
    expect(at(frozen, frozen.vegetation, 0.4, 0.4)).toBeLessThan(0.05);
  });
  it('wet and cold snows; wet and warm rains', () => {
    const cold = settle([card('rain', 0.4, 0.4), card('ice', 0.4, 0.4)]);
    expect(at(cold, cold.precipitation, 0.4, 0.4)).toBeGreaterThan(0.3);
    expect(at(cold, cold.temperature, 0.4, 0.4)).toBeLessThan(RULES.freezing);
    const warm = settle([card('rain', 0.4, 0.4)]);
    expect(at(warm, warm.temperature, 0.4, 0.4)).toBeGreaterThan(RULES.freezing);
  });
});

describe('smoothness', () => {
  it('a fading card has a proportionally smaller effect, and none at zero', () => {
    const full = settle([card('mountain', 0.4, 0.4, 1)]);
    const half = settle([card('mountain', 0.4, 0.4, 0.5)]);
    const none = settle([card('mountain', 0.4, 0.4, 0)]);
    const empty = settle([]);
    const lift = (f: WorldFrame) => at(f, f.height, 0.4, 0.4) - at(empty, empty.height, 0.4, 0.4);
    expect(lift(half)).toBeGreaterThan(lift(full) * 0.35);
    expect(lift(half)).toBeLessThan(lift(full) * 0.65);
    expect(lift(none)).toBeCloseTo(0, 5);
  });
  it('a mountain dragged across dry land leaves no water behind it', () => {
    const sim = new WorldSim();
    const mountain = card('mountain', 0.2, 0.5);
    sim.settleNow([mountain]);
    let wettest = 0;
    for (let step = 0; step < 30; step++) {
      mountain.x += 0.02;
      const f = sim.step([mountain], true, 1 / 30);
      wettest = Math.max(wettest, fractionWhere(f, (i) => f.waterSurface[i] - f.height[i] > 0.0002));
    }
    expect(wettest).toBe(0);
  });
});

const CIRCLE: WorldShape = {
  aspect: 1,
  outline: Array.from({ length: 72 }, (_, k) => {
    const a = (k / 72) * Math.PI * 2;
    return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
  }),
};

describe('shape', () => {
  it('defaults to the A3 rectangle with every cell inside', () => {
    const sim = new WorldSim();
    expect([sim.frame.w, sim.frame.h]).toEqual([192, 136]);
    expect(gridHeight(420 / 297)).toBe(136);
    expect(Math.min(...sim.frame.mask)).toBeGreaterThan(-0.01);
  });

  it('a circle world is square, with the corners outside', () => {
    const f = new WorldSim(CIRCLE).frame;
    expect([f.w, f.h]).toEqual([192, 192]);
    expect(at(f, f.mask, 0.5, 0.5)).toBeGreaterThan(90);
    expect(at(f, f.mask, 0.02, 0.02)).toBeLessThan(0);
  });

  it('nothing grows or rains outside the circle', () => {
    const cards = [0.08, 0.5, 0.92].flatMap((x) => [0.08, 0.5, 0.92].map((y) => card('forest', x, y)));
    cards.push(card('rain', 0.08, 0.08), card('rain', 0.5, 0.5));
    const f = new WorldSim(CIRCLE).settleNow(cards);
    const outside = (i: number) => f.mask[i] < -0.5;
    expect(fractionWhere(f, (i) => outside(i) && (f.vegetation[i] > 0 || f.precipitation[i] > 0 || f.river[i] > 0))).toBe(0);
    expect(fractionWhere(f, (i) => !outside(i) && f.vegetation[i] > 0.1)).toBeGreaterThan(0.01);
  });

  it('rivers drain off the edge of the circle', () => {
    const cards = [0.35, 0.45, 0.55].flatMap((x) => [card('rain', x, 0.4), card('mountain', x, 0.3)]);
    const f = new WorldSim(CIRCLE).settleNow(cards);
    expect(fractionWhere(f, (i) => f.river[i] > 0.5)).toBeGreaterThan(0.002);
    // Some river reaches the rim (or the sea) instead of stopping inside.
    const atRim = fractionWhere(f, (i) => f.river[i] > 0.3 && f.mask[i] >= 0 && f.mask[i] < 2);
    const intoSea = fractionWhere(f, (i) => f.river[i] > 0.3 && f.height[i] < f.seaLevel + 0.01);
    expect(atRim + intoSea).toBeGreaterThan(0);
    // Outside the circle the land stays dry.
    expect(fractionWhere(f, (i) => f.mask[i] < -0.5 && f.waterSurface[i] > f.height[i])).toBe(0);
  });
});

describe('people', () => {
  const total = (a: Float32Array, t = 0.3) => a.filter((v) => v > t).length / a.length;

  it('build houses where they are placed, on dry liveable land', () => {
    const f = settle([card('village', 0.4, 0.5)]);
    expect(at(f, f.homes, 0.4, 0.5)).toBeGreaterThan(0.5);
    expect(at(f, f.homes, 0.9, 0.2)).toBe(0);
    expect(total(f.homes)).toBeLessThan(0.12);
  });

  it('farm flat land only when it is wet enough', () => {
    expect(total(settle([card('village', 0.4, 0.5)]).farms)).toBe(0);
    const f = settle([card('village', 0.4, 0.5), card('rain', 0.45, 0.5)]);
    expect(total(f.farms)).toBeGreaterThan(0.05);
  });

  it('fish where there is open water nearby', () => {
    const lake = [card('lake', 0.5, 0.5)];
    expect(total(settle(lake).fishing, 0.2)).toBe(0);
    expect(total(settle([...lake, card('village', 0.4, 0.5)]).fishing, 0.2)).toBeGreaterThan(0.004);
  });

  it('do not live on mountain peaks or in frozen land', () => {
    // A village put on a mountain stands round its foot: nobody lives on the peak or the steep flanks.
    const onPeak = settle([card('village', 0.4, 0.5), card('mountain', 0.4, 0.5)]);
    expect(at(onPeak, onPeak.homes, 0.4, 0.5)).toBeLessThan(0.05);
    onPeak.homes.forEach((homes, i) => { if (onPeak.height[i] > RULES.people.peaks) expect(homes).toBe(0); });
    expect(Math.max(...settle([card('village', 0.4, 0.5), card('ice', 0.4, 0.5), card('ice', 0.42, 0.5)]).homes)).toBeLessThan(0.3);
  });

  it('clear the forest for their fields', () => {
    const wild = settle([card('forest', 0.4, 0.5), card('rain', 0.45, 0.5)]);
    const farmed = settle([card('forest', 0.4, 0.5), card('rain', 0.45, 0.5), card('village', 0.4, 0.5)]);
    expect(total(farmed.vegetation)).toBeLessThan(total(wild.vegetation) * 0.6);
  });
});

describe('village, town and city', () => {
  const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
  it('are three sizes of the same thing', () => {
    // One, two and three CIVILIZATION cards together (a city is its middle and a district at each card).
    const [village, town, city] = [1, 2, 3].map((count) => settle(Array.from({ length: count }, (_, k) => card('civilization', 0.5 + (k - (count - 1) / 2) * 0.04, 0.5))));
    expect(sum(town.homes)).toBeGreaterThan(sum(village.homes) * 1.2);
    expect(sum(city.homes)).toBeGreaterThan(sum(town.homes) * 1.2);
  });
  it('only towns and cities have tall buildings and a square', () => {
    const [village, town, city] = ['village', 'town', 'city'].map((id) => settle([card(id, 0.5, 0.5)]));
    expect(Math.max(...village.town, ...village.city, ...village.plaza)).toBe(0);
    expect(at(town, town.town, 0.5, 0.5)).toBeGreaterThan(0.9);
    expect(Math.max(...town.city)).toBe(0);
    expect(at(city, city.city, 0.5, 0.5)).toBeGreaterThan(0.9);
    // The square itself is clear of houses, with houses all round it.
    expect(at(city, city.plaza, 0.5, 0.5)).toBeGreaterThan(0.9);
    expect(at(city, city.homes, 0.5, 0.5)).toBeLessThan(0.1);
    expect(Math.max(at(city, city.homes, 0.6, 0.5), at(city, city.homes, 0.4, 0.5))).toBeGreaterThan(0.6);
  });
});

describe('woodcutters', () => {
  const forest = () => [card('forest', 0.4, 0.5), card('rain', 0.45, 0.5), card('village', 0.55, 0.5)];
  const felled = (f: WorldFrame) => f.cleared.reduce((s, v) => s + v, 0);

  it('fell the forest near people over time, never in an instant settle', () => {
    const sim = new WorldSim();
    sim.settleNow(forest());
    expect(felled(sim.frame)).toBe(0);
    for (let i = 0; i < 60 * 40; i++) sim.step(forest(), false, 1 / 60);
    expect(felled(sim.frame)).toBeGreaterThan(5);
    expect(fractionWhere(sim.frame, (i) => sim.frame.cleared[i] > 0 && sim.frame.logging[i] === 0)).toBe(0);
  });

  it('leave the land cleared after the people have gone', () => {
    const sim = new WorldSim();
    for (let i = 0; i < 60 * 20; i++) sim.step(forest(), i === 0, 1 / 60);
    const before = felled(sim.frame);
    const wild = forest().slice(0, 2);
    sim.step(wild, true, 1 / 60);
    for (let i = 0; i < 60 * 5; i++) sim.step(wild, false, 1 / 60);
    expect(felled(sim.frame)).toBeCloseTo(before, 3);
  });
});

describe('ravine', () => {
  const alone = settle([card('ravine', 0.4, 0.4)]);
  const empty = settle([]);
  const depthAt = (f: WorldFrame) => at(empty, empty.height, 0.4, 0.4) - at(f, f.height, 0.4, 0.4);
  it('cuts the land where it is placed, below the sea, and nowhere far away', () => {
    expect(depthAt(alone)).toBeGreaterThan(0.12);
    expect(at(alone, alone.height, 0.4, 0.4)).toBeLessThan(alone.seaLevel);
    expect(at(alone, alone.height, 0.9, 0.9)).toBeCloseTo(at(empty, empty.height, 0.9, 0.9), 5);
  });
  it('is a crack, not a bowl: most of the ground around the card is left alone', () => {
    const cut = fractionWhere(alone, (i) => empty.height[i] - alone.height[i] > 0.02);
    expect(cut).toBeGreaterThan(0.002);
    expect(cut).toBeLessThan(0.12); // a round dip of the same reach would take far more
  });
  it('stays dry until water reaches it', () => {
    expect(fractionWhere(alone, (i) => alone.waterSurface[i] > alone.height[i])).toBe(0);
    const rained = settle([card('ravine', 0.4, 0.4), card('rain', 0.45, 0.4)]);
    expect(at(rained, rained.waterSurface, 0.4, 0.4)).toBeGreaterThan(at(rained, rained.height, 0.4, 0.4));
  });
  it('gets deeper with more copies, and cuts through a mountain', () => {
    expect(depthAt(settle([card('ravine', 0.4, 0.4), card('ravine', 0.4, 0.4)]))).toBeGreaterThan(depthAt(alone) * 1.4);
    const mountain = settle([card('mountain', 0.4, 0.4)]);
    const notched = settle([card('mountain', 0.4, 0.4), card('ravine', 0.4, 0.4)]);
    expect(at(notched, notched.height, 0.4, 0.4)).toBeLessThan(at(mountain, mountain.height, 0.4, 0.4) - 0.1);
  });
});

describe('lava', () => {
  const lavaShare = (f: WorldFrame) => fractionWhere(f, (i) => f.lava[i] > 0.25);
  it('wells up at the card, molten, and runs a little way but not across the world', () => {
    const f = settle([card('lava', 0.4, 0.4)]);
    expect(at(f, f.lava, 0.4, 0.4)).toBeGreaterThan(0.9);
    expect(at(f, f.lavaHeat, 0.4, 0.4)).toBeGreaterThan(0.9);
    expect(at(f, f.lavaSurface, 0.4, 0.4)).toBeGreaterThan(at(f, f.height, 0.4, 0.4));
    expect(lavaShare(f)).toBeGreaterThan(0.01);
    expect(lavaShare(f)).toBeLessThan(0.08);
    expect(Math.max(...settle([]).lava)).toBe(0);
  });
  it('runs downhill: the lava beyond the vent lies lower than the vent', () => {
    const f = settle([card('mountain', 0.4, 0.4), card('lava', 0.4, 0.4)]);
    const vent = at(f, f.height, 0.4, 0.4);
    let lowest = Infinity;
    for (let i = 0; i < f.lava.length; i++) if (f.lava[i] > 0.5) lowest = Math.min(lowest, f.height[i]);
    expect(lowest).toBeLessThan(vent - 0.15);
  });
  it('pools in a ravine', () => {
    const f = settle([card('ravine', 0.4, 0.4), card('lava', 0.4, 0.4)]);
    expect(at(f, f.lavaSurface, 0.4, 0.4) - at(f, f.height, 0.4, 0.4)).toBeGreaterThan(0.03);
  });
  it('sets to rock under water and in the cold, and nothing grows or is built on it', () => {
    const flooded = settle([card('lava', 0.4, 0.4), ...[0.3, 0.4, 0.5, 0.6].map((x) => card('rain', x, 0.55))]);
    for (let i = 0; i < flooded.lava.length; i++) {
      if (flooded.waterSurface[i] - flooded.height[i] > 0.004) expect(flooded.lavaHeat[i]).toBe(0);
    }
    const frozen = settle([card('lava', 0.4, 0.4), card('ice', 0.4, 0.5), card('ice', 0.45, 0.5), card('ice', 0.35, 0.5)]);
    const molten = (f: WorldFrame) => fractionWhere(f, (i) => f.lava[i] > 0.25 && f.lavaHeat[i] > 0.5);
    expect(molten(frozen)).toBeLessThan(molten(settle([card('lava', 0.4, 0.4)])) * 0.6);
    const lived = settle([card('lava', 0.4, 0.4), card('forest', 0.4, 0.4), card('rain', 0.4, 0.45), card('village', 0.4, 0.4)]);
    for (let i = 0; i < lived.lava.length; i++) {
      if (lived.lava[i] > 0.5) {
        expect(lived.vegetation[i]).toBe(0);
        expect(lived.homes[i]).toBe(0);
        expect(lived.farms[i]).toBe(0);
      }
    }
  });
});

describe('lava meeting water and cold', () => {
  const beside = (f: WorldFrame, i: number, reach: number, test: (k: number) => boolean) => {
    const x = i % f.w, y = (i - x) / f.w;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.w && ny < f.h && test(ny * f.w + nx)) return true;
      }
    }
    return false;
  };
  it('stops at a river: it does not run on down the valley beside the water', () => {
    for (const cards of [
      [card('river', 0.48, 0.5), card('lava', 0.52, 0.5)],
      [card('river', 0.5, 0.35), card('lava', 0.5, 0.6)],
      [card('river', 0.35, 0.5), card('lava', 0.6, 0.45)],
    ]) {
      const f = settle(cards);
      const lava = cards[1];
      let along = 0;
      for (let i = 0; i < f.lava.length; i++) {
        if (f.lava[i] < 0.25) continue;
        const x = (i % f.w) / (f.w - 1), y = Math.floor(i / f.w) / (f.h - 1);
        // Lava far from its card is only what ran there: it lies by the river where it met it, and no further.
        if (Math.hypot(x - lava.x, y - lava.y) > 0.12 && beside(f, i, 3, (k) => f.river[k] > 0.5)) along++;
      }
      expect(along).toBeLessThan(40);
    }
    const close = settle([card('river', 0.48, 0.5), card('lava', 0.52, 0.5)]);
    expect(fractionWhere(close, (i) => close.lava[i] > 0.25 && close.waterSurface[i] - close.height[i] > 0.003 && close.lavaHeat[i] === 0)).toBeGreaterThan(0);
  });
  it('does not pool under a lake', () => {
    const f = settle([card('lake', 0.47, 0.5), card('lava', 0.53, 0.5)]);
    expect(at(f, f.lava, 0.44, 0.5)).toBeLessThan(0.05); // the far side of the lake's bed
    expect(open(f, 0.44, 0.5)).toBeGreaterThan(0.002);
  });
  it('stops on frozen ground: no line of set rock runs on across the snow', () => {
    const f = settle([card('lava', 0.5, 0.5), card('ice', 0.53, 0.5)]);
    // Lava far from its card is only what ran there. On frozen ground that is the spot where it set, and no more.
    let onIce = 0;
    for (let i = 0; i < f.lava.length; i++) {
      const x = (i % f.w) / (f.w - 1), y = Math.floor(i / f.w) / (f.h - 1);
      if (Math.hypot(x - 0.5, y - 0.5) > 0.12 && f.temperature[i] < RULES.lava.coolBelow && f.lava[i] > 0.25) onIce++;
    }
    expect(onIce).toBeLessThan(12);
  });
});

describe('volcano', () => {
  const X = 0.5, Y = 0.5;
  const f = settle([card('volcano', X, Y)]);
  const spec = MADE.volcano.effects.find((e) => e.cone)!;
  const R = spec.radius! * (f.w - 1); // base radius in cells
  const rc = spec.cone!.crater * R; // crater radius in cells
  const cx = X * (f.w - 1), cy = Y * (f.h - 1);
  const hAt = (fr: WorldFrame, field: Float32Array, x: number, y: number) => sampleField(field, fr.w, fr.h, x / (fr.w - 1), y / (fr.h - 1));
  /** Mean height on a ring this many cells from the centre. */
  const ring = (fr: WorldFrame, r: number) => {
    let sum = 0;
    for (let k = 0; k < 180; k++) sum += hAt(fr, fr.height, cx + r * Math.cos(k / 28.6479), cy + r * Math.sin(k / 28.6479));
    return sum / 180;
  };
  /** The crest: for each bearing, the highest ground between the crater and the upper flank. */
  const crest = (fr: WorldFrame) => Array.from({ length: 72 }, (_, k) => {
    const a = (k / 72) * Math.PI * 2;
    let top = -Infinity;
    for (let r = 0.5 * rc; r <= 1.6 * rc; r += 0.25) top = Math.max(top, hAt(fr, fr.height, cx + r * Math.cos(a), cy + r * Math.sin(a)));
    return top;
  });

  it('has concave flanks: steepest under the rim, flattening into an apron', () => {
    const slope = (r0: number, r1: number) => (ring(f, r0 * R) - ring(f, r1 * R)) / ((r1 - r0) * R);
    const under = slope(0.32, 0.42);
    const mid = slope(0.55, 0.65);
    const foot = slope(0.8, 0.9);
    expect(under).toBeGreaterThan(mid * 1.3);
    expect(mid).toBeGreaterThan(foot * 1.3);
    expect(foot).toBeGreaterThan(0);
  });

  it('has a crater sunk well below a sharp rim that is not level', () => {
    const tops = crest(f);
    const low = Math.min(...tops);
    const high = Math.max(...tops);
    const floor = at(f, f.height, X, Y);
    expect(high).toBeGreaterThan(0.2);
    expect(floor).toBeLessThan(low - 0.03); // even the lowest notch holds a crater
    expect(high - floor).toBeGreaterThan(0.04);
    expect(high - low).toBeGreaterThan(0.02); // notches: the rim is not level
    // A crest, not a shoulder: the ground falls away on both sides of the rim.
    const rim = ring(f, rc);
    expect(rim - ring(f, rc - 3)).toBeGreaterThan(0.01);
    expect(rim - ring(f, rc + 3)).toBeGreaterThan(0.03);
  });

  it('holds a molten lake below the rim, and sends lava down several flanks', () => {
    const surface = at(f, f.lavaSurface, X, Y);
    expect(surface).toBeGreaterThan(at(f, f.height, X, Y));
    expect(surface).toBeLessThan(Math.min(...crest(f)));
    expect(at(f, f.lavaHeat, X, Y)).toBeGreaterThan(0.9);
    // Lava on the flanks, by bearing: count separate streams.
    const sectors = new Array(24).fill(0);
    for (let j = 0; j < f.h; j++) {
      for (let i = 0; i < f.w; i++) {
        const r = Math.hypot(i - cx, j - cy);
        if (r < rc + 4 || r > 0.8 * R || f.lava[j * f.w + i] < 0.25) continue;
        sectors[Math.floor((((Math.atan2(j - cy, i - cx) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * 24)]++;
      }
    }
    let streams = 0;
    for (let k = 0; k < 24; k++) if (sectors[k] > 0 && sectors[(k + 23) % 24] === 0) streams++;
    expect(streams).toBeGreaterThanOrEqual(3);
    // ...that stop: no flood of lava over the world.
    expect(fractionWhere(f, (i) => f.lava[i] > 0.25)).toBeLessThan(0.04);
  });

  it('grows and moves smoothly with its card', () => {
    const sim = new WorldSim();
    const a = sim.settleNow([card('volcano', X, Y, 0.5)]).height.slice();
    const b = sim.settleNow([card('volcano', X, Y, 0.52)]).height.slice();
    const c = sim.settleNow([card('volcano', X + 0.002, Y, 0.52)]).height;
    let grow = 0, move = 0;
    for (let i = 0; i < a.length; i++) {
      grow = Math.max(grow, Math.abs(b[i] - a[i]));
      move = Math.max(move, Math.abs(c[i] - b[i]));
    }
    expect(grow).toBeLessThan(0.012);
    expect(move).toBeLessThan(0.012);
    expect(Math.max(...settle([card('volcano', X, Y, 0.01)]).height)).toBeLessThan(Math.max(...settle([]).height) + 0.01);
    // Appearing on rough ground too: a faint volcano barely touches a mountain.
    const mountain = settle([card('mountain', X, Y)]).height.slice();
    const faint = settle([card('mountain', X, Y), card('volcano', X, Y, 0.01)]).height;
    let most = 0;
    for (let i = 0; i < faint.length; i++) most = Math.max(most, Math.abs(faint[i] - mountain[i]));
    expect(most).toBeLessThan(0.01);
  });

  it('is bigger with BIG, not broken', () => {
    const big = settle([card('big', X - 0.03, Y), card('volcano', X, Y)]);
    expect(Math.max(...big.height)).toBeGreaterThan(Math.max(...f.height) + 0.08);
    expect(at(big, big.height, X, Y)).toBeLessThan(Math.max(...big.height) - 0.08);
    expect(at(big, big.lavaSurface, X, Y)).toBeGreaterThan(at(big, big.height, X, Y));
    const wide = (fr: WorldFrame) => fractionWhere(fr, (i) => fr.height[i] > 0.15);
    expect(wide(big)).toBeGreaterThan(wide(f) * 1.6);
  });

  it('makes copies on one spot into one taller cone, and copies apart into two', () => {
    const twin = settle([card('volcano', X, Y), card('volcano', X + 0.04, Y)]);
    const mid = X + 0.02;
    expect(Math.max(...twin.height)).toBeGreaterThan(Math.max(...f.height) + 0.03);
    expect(at(twin, twin.height, mid, Y)).toBeLessThan(Math.max(...twin.height) - 0.08); // one crater, between them
    const pair = settle([card('volcano', 0.25, 0.45), card('volcano', 0.75, 0.55)]);
    for (const [x, y] of [[0.25, 0.45], [0.75, 0.55]]) {
      let top = 0;
      for (let r = 0; r < 0.08; r += 0.004) top = Math.max(top, at(pair, pair.height, x + r, y), at(pair, pair.height, x - r, y));
      expect(at(pair, pair.height, x, y)).toBeLessThan(top - 0.04);
      expect(at(pair, pair.lavaHeat, x, y)).toBeGreaterThan(0.9);
    }
  });

  it('keeps its crater on a mountain, and rain or a risen sea does not drown the crater', () => {
    const peak = settle([card('mountain', X, Y), card('volcano', X, Y)]);
    let top = 0;
    for (let r = 0; r < 0.06; r += 0.003) top = Math.max(top, at(peak, peak.height, X + r, Y), at(peak, peak.height, X - r, Y));
    expect(at(peak, peak.height, X, Y)).toBeLessThan(top - 0.05);
    expect(at(peak, peak.lavaHeat, X, Y)).toBeGreaterThan(0.5);
    const wet = settle([card('volcano', X, Y), card('rain', X + 0.05, Y), card('rain', X + 0.1, Y), card('rain', X + 0.15, Y)]);
    expect(at(wet, wet.waterSurface, X, Y)).toBeLessThan(at(wet, wet.height, X, Y));
    expect(at(wet, wet.lavaHeat, X, Y)).toBeGreaterThan(0.9);
  });
});

describe('cards that make something together', () => {
  const X = 0.5, Y = 0.5;
  const near = NEXT_TO.full * 0.5;
  const far = NEXT_TO.none + 0.05;
  const same = (a: WorldFrame, b: WorldFrame, field: 'height' | 'lava' | 'homes' | 'town' | 'city' | 'plaza') => {
    let most = 0;
    for (let i = 0; i < a[field].length; i++) most = Math.max(most, Math.abs(a[field][i] - b[field][i]));
    return most;
  };

  it('MOUNTAIN next to LAVA is a volcano: the same mountain, with a crater at its top', () => {
    const pair = settle([card('mountain', X - near / 2, Y), card('lava', X + near / 2, Y)]);
    const volcano = settle([card('mountain', X - near / 2, Y), card('volcano', X - near / 2, Y)]);
    expect(same(pair, volcano, 'height')).toBeLessThan(1e-6);
    expect(same(pair, volcano, 'lava')).toBeLessThan(1e-6);
    expect(volcano.rules).toBeGreaterThan(0);
  });

  it('apart they are a mountain and a pool of lava, and nothing else', () => {
    const cards = [card('mountain', 0.2, 0.4), card('lava', 0.2 + far, 0.4)];
    expect(combine(cards)).toEqual(cards);
    expect(combine([card('mountain', 0.2, 0.4)]).map((c) => c.def.id)).toEqual(['mountain']);
  });

  it('the volcano grows as the lava is slid towards the mountain: no jump', () => {
    const sim = new WorldSim();
    const span = NEXT_TO.none - NEXT_TO.full;
    let before = sim.settleNow([card('mountain', 0.3, Y), card('lava', 0.3 + NEXT_TO.none, Y)]).height.slice();
    for (let k = 1; k <= 40; k++) {
      const now = sim.settleNow([card('mountain', 0.3, Y), card('lava', 0.3 + NEXT_TO.none - (span * k) / 40, Y)]).height;
      let most = 0;
      for (let i = 0; i < now.length; i++) most = Math.max(most, Math.abs(now[i] - before[i]));
      expect(most, `step ${k}`).toBeLessThan(0.06);
      before = now.slice();
    }
  });

  it('one lava makes one volcano: a second mountain beside it stays a mountain', () => {
    // The mountain under the volcano is still there too.
    const made = combine([card('mountain', 0.4, Y), card('mountain', 0.6, Y), card('lava', 0.45, Y)]);
    const strong = made.filter((c) => c.strength > 0.5).map((c) => c.def.id).sort();
    expect(strong).toEqual(['mountain', 'mountain', 'volcano']);
    expect(made.find((c) => c.def.id === 'volcano')!.x).toBe(0.4);
  });

  it('BIG beside the pair makes a bigger volcano', () => {
    const plain = settle([card('mountain', X - near / 2, Y), card('lava', X + near / 2, Y)]);
    const big = settle([card('big', X, Y + 0.1), card('mountain', X - near / 2, Y), card('lava', X + near / 2, Y)]);
    expect(Math.max(...big.height)).toBeGreaterThan(Math.max(...plain.height) + 0.08);
  });

  it('one CIVILIZATION is a village, two next to each other a town, three a city', () => {
    const civ = (count: number, step = near) => Array.from({ length: count }, (_, k) => card('civilization', X + (k - (count - 1) / 2) * step, Y));
    for (const [count, kind] of [[1, 'village'], [2, 'town'], [3, 'city'], [4, 'city']] as const) {
      const made = combine(civ(count)).filter((c) => c.def.id !== 'district');
      expect(made.map((c) => c.def.id), `${count}`).toEqual([kind]);
      expect(made[0].strength).toBeCloseTo(1, 6);
      expect(made[0].x).toBeCloseTo(X, 6);
      if (count > 2) continue; // a city is more than its middle: see the next test
      const together = settle(civ(count));
      const direct = settle([card(kind, X, Y)]);
      for (const field of ['homes', 'town', 'city', 'plaza'] as const) expect(same(together, direct, field), `${count} ${field}`).toBeLessThan(1e-6);
    }
    // Three in a row count, though the two at the ends are not next to each other.
    const row = combine(civ(3, NEXT_TO.full));
    expect(row.map((c) => c.def.id)).toEqual(['district', 'district', 'district', 'city']);
    // Apart, they are villages.
    expect(combine(civ(3, far)).map((c) => c.def.id)).toEqual(['village', 'village', 'village']);
  });

  it('a city grows with every card, and a line of cards is a long city', () => {
    const line = (count: number) => Array.from({ length: count }, (_, k) => card('civilization', 0.15 + k * 0.14, Y));
    const built = (f: WorldFrame) => fractionWhere(f, (i) => f.homes[i] > 0.25);
    const [three, four, six] = [3, 4, 6].map((count) => settle(line(count)));
    expect(built(four)).toBeGreaterThan(built(three) * 1.15);
    expect(built(six)).toBeGreaterThan(built(four) * 1.25);
    // City streets at both ends of the line, and still one city: one square, in the middle.
    expect(at(six, six.city, 0.15, Y)).toBeGreaterThan(0.8);
    expect(at(six, six.city, 0.85, Y)).toBeGreaterThan(0.8);
    expect(at(six, six.homes, 0.2, Y + 0.05)).toBeGreaterThan(0.5);
    expect(at(six, six.plaza, 0.5, Y)).toBeGreaterThan(0.9);
    expect(at(six, six.plaza, 0.15, Y)).toBe(0);
    expect(settlementsOf(combine(line(6))).map((c) => c.def.word)).toEqual(['CITY']);
    // Huddled close, three cards are a little more than the city in their middle, not three cities' worth.
    const huddle = built(settle(Array.from({ length: 3 }, (_, k) => card('civilization', X + (k - 1) * 0.04, Y))));
    expect(huddle).toBeLessThan(built(three));
    expect(huddle).toBeLessThan(0.36);
  });

  it('a town covers more ground than a village, and a city more than a town', () => {
    const covered = (count: number) => {
      const f = settle(Array.from({ length: count }, (_, k) => card('civilization', X + (k - (count - 1) / 2) * 0.04, Y)));
      return fractionWhere(f, (i) => f.homes[i] > 0.25 || f.plaza[i] > 0.25);
    };
    const [village, town, city] = [1, 2, 3].map(covered);
    expect(town).toBeGreaterThan(village * 1.6);
    expect(city).toBeGreaterThan(town * 1.25);
    expect(city).toBeLessThan(0.36); // and still leaves most of the table
  });

  it('is named for what it has become: one settlement to a place', () => {
    const civ = (count: number, x: number) => Array.from({ length: count }, (_, k) => card('civilization', x + k * 0.03, Y));
    const named = settlementsOf(combine([...civ(1, 0.1), ...civ(2, 0.5), ...civ(3, 0.85)]));
    expect(named.map((c) => c.def.word)).toEqual(['VILLAGE', 'TOWN', 'CITY']);
    // Two cards half way between "next to" and "apart": two villages fading into one town between
    // them, never two towns side by side.
    const gap = (NEXT_TO.full + NEXT_TO.none) / 2;
    const half = settlementsOf(combine([card('civilization', 0.3, Y), card('civilization', 0.3 + gap, Y)]));
    expect(half.map((c) => c.def.word).sort()).toEqual(['TOWN', 'VILLAGE', 'VILLAGE']);
    expect(half.find((c) => c.def.word === 'TOWN')!.x).toBeCloseTo(0.3 + gap / 2, 6);
    expect(half.reduce((sum, c) => sum + c.strength, 0)).toBeCloseTo(1.5, 6);
    // The labels do not show that fade: decided, it is one or the other, changing half way.
    const decided = (apart: number) => settlementsOf(combine([card('civilization', 0.3, Y), card('civilization', 0.3 + apart, Y)], true));
    expect(decided(gap - 0.005).map((c) => [c.def.word, c.strength])).toEqual([['TOWN', 1]]);
    expect(decided(gap + 0.005).map((c) => [c.def.word, c.strength])).toEqual([['VILLAGE', 1], ['VILLAGE', 1]]);
    // And a third card half way in: the town fading into a city, the newcomer still a village.
    const growing = settlementsOf(combine([card('civilization', 0.3, Y), card('civilization', 0.33, Y), card('civilization', 0.33 + gap, Y)]));
    expect(growing.map((c) => c.def.word).sort()).toEqual(['CITY', 'TOWN', 'VILLAGE']);
  });

  it('a town becomes a city smoothly as a third card is slid in', () => {
    const third = (x: number) => combine([card('civilization', 0.3, Y), card('civilization', 0.3 + near, Y), card('civilization', x, Y)]);
    const total = (cards: LiveCard[], id: string) => cards.filter((c) => c.def.id === id).reduce((s, c) => s + c.strength, 0);
    let before = third(0.3 + near + NEXT_TO.none + 0.01);
    expect(total(before, 'town')).toBeCloseTo(1, 6);
    expect(total(before, 'village')).toBeCloseTo(1, 6);
    for (let k = 1; k <= 50; k++) {
      const now = third(0.3 + near + NEXT_TO.none + 0.01 - (k / 50) * (NEXT_TO.none - NEXT_TO.full + 0.02));
      for (const id of ['village', 'town', 'city']) expect(Math.abs(total(now, id) - total(before, id)), `${id} step ${k}`).toBeLessThan(0.12);
      before = now;
    }
    expect(total(before, 'city')).toBeCloseTo(1, 6);
    expect(total(before, 'town') + total(before, 'village')).toBeCloseTo(0, 6);
  });
});

// A place as the model is asked to describe one: landforms that end at their radius, a climate
// kept inside it, lava, and a biome (materials only: the sim never reads it).
const NETHER = cleanCard({
  word: 'the nether', origin: 'llm', icon: '🔥', color: '#6e2a2e', reading: 'Netherrack round a lava lake.',
  effects: [
    { field: 'height', amount: -0.03, radius: 0.22, shape: 'flat' }, { field: 'lava', amount: 1, radius: 0.17, shape: 'flat' },
    { field: 'height', amount: 0.1, radius: 0.3, shape: 'spires' }, { field: 'temperature', amount: 0.8, radius: 0.3, shape: 'flat' },
    { field: 'wetness', amount: -0.9, radius: 0.3, shape: 'flat' }, { field: 'life', amount: -1, radius: 0.3, shape: 'flat' },
  ],
  biome: { ground: '#6e2a2e', strength: 0.95, radius: 0.32, rock: '#4a1c20', liquid: { color: '#ff6a1a', glow: 1 }, trees: false },
})!;
const made = (def: CardDef, x: number, y: number, strength = 1): LiveCard =>
  ({ key: `${def.id}-${x}-${y}`, def, source: 'sim', x, y, tx: x, ty: y, vx: 0, vy: 0, angle: 0, targetAngle: 0, strength, age: 10 }) as LiveCard;
const shaped = (shape: string, amount: number, radius = 0.15, field = 'height'): CardDef =>
  cleanCard({ word: `${shape} ${field} ${amount > 0 ? 'up' : 'down'}`, origin: 'llm', effects: [{ field, amount, radius, shape }] })!;
/** Every cell further than `radius` (a share of the width) from x, y. */
const beyond = (f: WorldFrame, x: number, y: number, radius: number, each: (i: number) => void) => {
  for (let j = 0; j < f.h; j++) {
    for (let i = 0; i < f.w; i++) {
      if (Math.hypot(i - x * (f.w - 1), j - y * (f.h - 1)) > radius * (f.w - 1)) each(j * f.w + i);
    }
  }
};

describe('landforms (effects with a shape)', () => {
  const empty = settle([]);
  it('end at their radius: the ground beyond is exactly the empty world', () => {
    for (const shape of ['mound', 'flat', 'ridges', 'spires', 'dunes', 'terraces', 'rim']) {
      for (const amount of [0.2, -0.05]) {
        const f = settle([made(shaped(shape, amount), 0.5, 0.5)]);
        let moved = 0;
        // The outline wanders by up to about a third of the radius.
        beyond(f, 0.5, 0.5, 0.15 * 1.35, (i) => { if (f.height[i] !== empty.height[i]) moved++; });
        expect(moved, `${shape} ${amount}`).toBe(0);
        expect(Math.abs(at(f, f.height, 0.5, 0.5) - at(empty, empty.height, 0.5, 0.5)) > 0.01 || shape === 'rim' || shape === 'spires' || shape === 'dunes' || shape === 'ridges', shape).toBe(true);
      }
    }
  });
  it('flat is level on top, with the hills under it evened out', () => {
    const f = settle([made(shaped('flat', 0.12, 0.2), 0.5, 0.5)]);
    const spread = (frame: WorldFrame) => {
      let lo = Infinity, hi = -Infinity;
      for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
        const v = at(frame, frame.height, 0.5 + i / 100, 0.5 + j / 100);
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      return hi - lo;
    };
    expect(at(f, f.height, 0.5, 0.5)).toBeGreaterThan(at(empty, empty.height, 0.5, 0.5) + 0.09);
    expect(spread(f)).toBeLessThan(spread(empty) * 0.5 + 0.004);
  });
  it('rim is a whole crater, whichever way its amount points', () => {
    const up = settle([made(shaped('rim', 0.1, 0.2), 0.5, 0.5)]);
    const down = settle([made(shaped('rim', -0.1, 0.2), 0.5, 0.5)]);
    const ground = at(empty, empty.height, 0.5, 0.5);
    for (const f of [up, down]) {
      // The floor is below the land around; the crest (at 0.6 of the radius) stands well above it.
      expect(at(f, f.height, 0.5, 0.5)).toBeLessThan(ground - 0.02);
      const crest = Math.max(...[0.1, 0.11, 0.12, 0.13, 0.14].map((r) => at(f, f.height, 0.5 + r, 0.5)));
      expect(crest).toBeGreaterThan(at(empty, empty.height, 0.62, 0.5) + 0.04);
    }
    // A negative amount is the same crater, not a ring-shaped ditch.
    expect(Array.from(down.height)).toEqual(Array.from(up.height));
  });
  it('each shape is its own landform', () => {
    const top = (shape: string) => at(settle([made(shaped(shape, 0.2), 0.5, 0.5)]), settle([made(shaped(shape, 0.2), 0.5, 0.5)]).height, 0.5, 0.5);
    // A rim is hollow in the middle; a mound and a table are highest there.
    expect(top('rim')).toBeLessThan(top('mound') - 0.1);
    expect(top('flat')).toBeGreaterThan(at(empty, empty.height, 0.5, 0.5) + 0.15);
    // Spires are separate needles: most of their ground is left low.
    const spires = settle([made(shaped('spires', 0.2), 0.5, 0.5)]);
    let raised = 0, cells = 0;
    for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) {
      cells++;
      if (at(spires, spires.height, 0.5 + i / 100, 0.5 + j / 100) > at(empty, empty.height, 0.5 + i / 100, 0.5 + j / 100) + 0.05) raised++;
    }
    expect(raised).toBeGreaterThan(0);
    expect(raised / cells).toBeLessThan(0.6);
  });
  it('keep a climate inside the place: a patch of the same radius reaches far further', () => {
    const hot = settle([made(shaped('flat', 0.8, 0.2, 'temperature'), 0.3, 0.5)]);
    const patch = settle([made(cleanCard({ word: 'hot patch', origin: 'llm', effects: [{ field: 'temperature', amount: 0.8, radius: 0.2 }] })!, 0.3, 0.5)]);
    expect(at(hot, hot.temperature, 0.3, 0.5)).toBeGreaterThan(0.7);
    expect(at(hot, hot.temperature, 0.7, 0.5)).toBeCloseTo(at(empty, empty.temperature, 0.7, 0.5), 6);
    expect(at(patch, patch.temperature, 0.7, 0.5)).toBeGreaterThan(at(empty, empty.temperature, 0.7, 0.5) + 0.05);
  });
});

describe('a place made from a word (THE NETHER)', () => {
  const seaShare = (f: WorldFrame) => fractionWhere(f, (i) => f.height[i] < f.seaLevel && f.waterSurface[i] > f.height[i]);
  const lavaShare = (f: WorldFrame) => fractionWhere(f, (i) => f.lava[i] > 0.2 && f.lavaHeat[i] > 0.5);
  const waters = () => [card('rain', 0.5, 0.1), card('rain', 0.85, 0.3)];
  it('has a molten lava lake of its own', () => {
    const f = settle([made(NETHER, 0.4, 0.55)]);
    expect(lavaShare(f)).toBeGreaterThan(0.03);
    expect(at(f, f.lava, 0.4, 0.55)).toBeGreaterThan(0.5);
  });
  it('does not turn the world into a sea when RAIN cards are down too', () => {
    const without = seaShare(settle(waters()));
    const withNether = seaShare(settle([made(NETHER, 0.4, 0.55), ...waters()]));
    expect(withNether).toBeLessThan(without + 0.12);
  });
  it('leaves a forest across the table alone', () => {
    const forest = [card('forest', 0.85, 0.5), card('rain', 0.85, 0.6)];
    const alone = settle(forest);
    const beside = settle([made(NETHER, 0.25, 0.5), ...forest]);
    expect(at(beside, beside.vegetation, 0.85, 0.5)).toBeCloseTo(at(alone, alone.vegetation, 0.85, 0.5), 2);
    expect(at(alone, alone.vegetation, 0.85, 0.5)).toBeGreaterThan(0.3);
  });
});
