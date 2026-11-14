import { describe, expect, it } from 'vitest';
import { cardDef } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { RULES, WorldSim, gridHeight, sampleField, type WorldFrame, type WorldShape } from './world';

let n = 0;
function card(id: string, x: number, y: number, strength = 1): LiveCard {
  const def = cardDef(id)!;
  return { key: `t${n++}`, def, source: 'sim', x, y, tx: x, ty: y, vx: 0, vy: 0, strength, fade: strength, present: true, visible: true, age: 9 };
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

describe('water', () => {
  it('rains near the card and forms rivers or lakes', () => {
    const f = settle([card('water', 0.35, 0.35)]);
    expect(at(f, f.precipitation, 0.35, 0.35)).toBeGreaterThan(0.4);
    expect(at(f, f.precipitation, 0.95, 0.9)).toBe(0);
    const wetLand = fractionWhere(f, (i) => f.height[i] >= f.seaLevel && f.waterSurface[i] > f.height[i]);
    expect(wetLand).toBeGreaterThan(0.002);
  });
  it('rains harder with each copy', () => {
    const rain = (count: number) => {
      const f = settle(Array.from({ length: count }, (_, i) => card('water', 0.3 + 0.04 * i, 0.3)));
      return f.precipitation.reduce((a, b) => a + b, 0);
    };
    expect(rain(2)).toBeGreaterThan(rain(1) * 1.25);
    expect(rain(3)).toBeGreaterThan(rain(2) * 1.1);
  });
  it('floods the lowlands by the third copy', () => {
    const land = (count: number) => flooded(settle(Array.from({ length: count }, (_, i) => card('water', 0.2 + 0.05 * i, 0.2))));
    expect(land(1)).toBeLessThan(0.02);
    expect(land(2)).toBeGreaterThan(0.01);
    expect(land(2)).toBeLessThan(0.25);
    expect(land(3)).toBeGreaterThan(0.25);
    expect(land(3)).toBeGreaterThan(land(1) + 0.2);
    expect(land(3)).toBeLessThan(0.75);
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
  it('life grows only where it is warm and wet enough', () => {
    const lifeOnly = settle([card('life', 0.4, 0.4)]);
    expect(at(lifeOnly, lifeOnly.vegetation, 0.4, 0.4)).toBeLessThan(0.05);

    const withWater = settle([card('life', 0.4, 0.4), card('water', 0.4, 0.4)]);
    const cover = fractionWhere(withWater, (i) => withWater.vegetation[i] > 0.4);
    expect(cover).toBeGreaterThan(0.03);

    const desert = settle([card('life', 0.4, 0.4), card('sun', 0.4, 0.4)]);
    expect(at(desert, desert.vegetation, 0.4, 0.4)).toBeLessThan(0.05);

    const frozen = settle([card('life', 0.4, 0.4), card('water', 0.4, 0.4), card('ice', 0.4, 0.4), card('ice', 0.42, 0.4)]);
    expect(at(frozen, frozen.vegetation, 0.4, 0.4)).toBeLessThan(0.05);
  });
  it('wet and cold snows; wet and warm rains', () => {
    const cold = settle([card('water', 0.4, 0.4), card('ice', 0.4, 0.4)]);
    expect(at(cold, cold.precipitation, 0.4, 0.4)).toBeGreaterThan(0.3);
    expect(at(cold, cold.temperature, 0.4, 0.4)).toBeLessThan(RULES.freezing);
    const warm = settle([card('water', 0.4, 0.4)]);
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
    const cards = [0.08, 0.5, 0.92].flatMap((x) => [0.08, 0.5, 0.92].map((y) => card('life', x, y)));
    cards.push(card('water', 0.08, 0.08), card('water', 0.5, 0.5));
    const f = new WorldSim(CIRCLE).settleNow(cards);
    const outside = (i: number) => f.mask[i] < -0.5;
    expect(fractionWhere(f, (i) => outside(i) && (f.vegetation[i] > 0 || f.precipitation[i] > 0 || f.river[i] > 0))).toBe(0);
    expect(fractionWhere(f, (i) => !outside(i) && f.vegetation[i] > 0.1)).toBeGreaterThan(0.01);
  });

  it('rivers drain off the edge of the circle', () => {
    const cards = [0.35, 0.45, 0.55].flatMap((x) => [card('water', x, 0.4), card('mountain', x, 0.3)]);
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
    const f = settle([card('people', 0.4, 0.5)]);
    expect(at(f, f.homes, 0.4, 0.5)).toBeGreaterThan(0.5);
    expect(at(f, f.homes, 0.9, 0.2)).toBe(0);
    expect(total(f.homes)).toBeLessThan(0.12);
  });

  it('farm flat land only when it is wet enough', () => {
    expect(total(settle([card('people', 0.4, 0.5)]).farms)).toBe(0);
    const f = settle([card('people', 0.4, 0.5), card('water', 0.45, 0.5)]);
    expect(total(f.farms)).toBeGreaterThan(0.05);
  });

  it('fish where there is open water nearby', () => {
    const lake = [card('water', 0.3, 0.5), card('water', 0.5, 0.5), card('water', 0.6, 0.6)];
    expect(total(settle(lake).fishing, 0.2)).toBe(0);
    expect(total(settle([...lake, card('people', 0.4, 0.5)]).fishing, 0.2)).toBeGreaterThan(0.01);
  });

  it('do not live on mountain peaks or in frozen land', () => {
    expect(Math.max(...settle([card('people', 0.4, 0.5), card('mountain', 0.4, 0.5)]).homes)).toBeLessThan(0.3);
    expect(Math.max(...settle([card('people', 0.4, 0.5), card('ice', 0.4, 0.5), card('ice', 0.42, 0.5)]).homes)).toBeLessThan(0.3);
  });

  it('clear the forest for their fields', () => {
    const wild = settle([card('life', 0.4, 0.5), card('water', 0.45, 0.5)]);
    const farmed = settle([card('life', 0.4, 0.5), card('water', 0.45, 0.5), card('people', 0.4, 0.5)]);
    expect(total(farmed.vegetation)).toBeLessThan(total(wild.vegetation) * 0.6);
  });
});

describe('woodcutters', () => {
  const forest = () => [card('life', 0.4, 0.5), card('water', 0.45, 0.5), card('people', 0.55, 0.5)];
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
