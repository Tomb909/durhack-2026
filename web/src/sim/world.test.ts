import { describe, expect, it } from 'vitest';
import { cardDef } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { GH, GW, RULES, WorldSim, sampleField, type WorldFrame } from './world';

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
  return sampleField(field, x, y);
}

const fractionWhere = (frame: WorldFrame, test: (i: number) => boolean) => {
  let count = 0;
  for (let i = 0; i < GW * GH; i++) if (test(i)) count++;
  return count / (GW * GH);
};
const flooded = (f: WorldFrame) => fractionWhere(f, (i) => f.height[i] < f.seaLevel);

describe('empty world', () => {
  const f = settle([]);
  it('is a mild, mostly dry plain with a low sea and no life', () => {
    expect(at(f, f.temperature, 0.3, 0.3)).toBeCloseTo(0, 1);
    expect(at(f, f.wetness, 0.3, 0.3)).toBeLessThan(RULES.rainStart);
    expect(Math.max(...f.vegetation)).toBe(0);
    expect(Math.max(...f.precipitation)).toBe(0);
    expect(flooded(f)).toBeGreaterThan(0.01);
    expect(flooded(f)).toBeLessThan(0.15);
    expect(Math.max(...f.height)).toBeLessThan(0.12);
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
    expect(land(1)).toBeLessThan(0.25);
    expect(land(3)).toBeGreaterThan(0.3);
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
