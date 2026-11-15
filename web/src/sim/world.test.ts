import { describe, expect, it } from 'vitest';
import { cardDef } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { RULES, WorldSim, gridHeight, sampleField, type WorldFrame, type WorldShape } from './world';

let n = 0;
function card(id: string, x: number, y: number, strength = 1, angle = 0): LiveCard {
  const def = cardDef(id)!;
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
  it('holds water on a mountainside too', () => {
    const f = settle([card('mountain', 0.4, 0.5), card('lake', 0.52, 0.5)]);
    expect(open(f, 0.52, 0.5)).toBeGreaterThan(0.008);
  });
  it('is wider with BIG beside it', () => {
    const plain = settle([card('lake', 0.45, 0.5)]);
    const big = settle([card('lake', 0.45, 0.5), card('big', 0.6, 0.5)]);
    expect(openWater(big)).toBeGreaterThan(openWater(plain) * 1.5);
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
    const right = settle([card('mountain', 0.15, 0.5), card('river', 0.5, 0.5)]);
    expect(wetAt(right, 0.33, 0.5)).toBeGreaterThan(0.5); // between the mountain and the card
    expect(wetAt(right, 0.8, 0.5)).toBeGreaterThan(0.5); // beyond the card
    expect(at(right, right.height, 0.3, 0.5)).toBeGreaterThan(at(right, right.height, 0.5, 0.5));
    const left = settle([card('mountain', 0.85, 0.5), card('river', 0.5, 0.5)]);
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
    expect(Math.max(...settle([card('village', 0.4, 0.5), card('mountain', 0.4, 0.5)]).homes)).toBeLessThan(0.35);
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
    const [village, town, city] = ['village', 'town', 'city'].map((id) => settle([card(id, 0.5, 0.5)]));
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
