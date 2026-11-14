import { describe, expect, it } from 'vitest';
import { CARD_DEFS } from '../cards/defs';
import { CardStore } from '../cards/store';
import { WorldSim } from '../sim/world';
import { nameOf, parseCode, resolveScenarios, tidyCode } from './codes';
import { liveCards, measure } from './metrics';

describe('combination codes', () => {
  it('reads cards, copies and positions', () => {
    expect(parseCode('empty')).toEqual([]);
    expect(parseCode('water').map((c) => c.id)).toEqual(['water']);
    expect(parseCode('water*3').length).toBe(3);
    expect(parseCode('water_x3').length).toBe(3);
    expect(parseCode('life water sun').map((c) => c.id)).toEqual(['life', 'water', 'sun']);
    expect(parseCode('life@0.8,0.6')).toEqual([{ id: 'life', x: 0.8, y: 0.6 }]);
  });
  it('accepts any unambiguous start of a card id', () => {
    expect(parseCode('m+w+s+i+l').map((c) => c.id)).toEqual(['mountain', 'water', 'sun', 'ice', 'life']);
    expect(() => parseCode('lava')).toThrow(/no card called/);
  });
  it('puts copies side by side, never on top of each other', () => {
    const cards = parseCode('water*3+life');
    expect(new Set(cards.map((c) => `${c.x},${c.y}`)).size).toBe(4);
    expect(parseCode('water*3')).toEqual(parseCode('water*3')); // same code, same places
  });
  it('writes a code one standard way and names it for files', () => {
    expect(tidyCode('Life_Water x3')).toBe('life+water*3');
    expect(nameOf('water*3+life@0.8,0.6')).toBe('water_x3_life');
  });
  it('lists every combination of cards exactly once', () => {
    const subsets = resolveScenarios({ set: 'subsets' });
    expect(subsets.length).toBe(2 ** CARD_DEFS.length);
    expect(new Set(subsets.map((s) => s.code)).size).toBe(subsets.length);
    expect(resolveScenarios({}).length).toBeGreaterThan(10); // the showcase
    expect(resolveScenarios({ codes: 'flood=water*3; life+sun' }).map((s) => s.name)).toEqual(['flood', 'life_sun']);
  });
});

describe('the settled world depends on the cards alone', () => {
  const all = resolveScenarios({ set: 'all' });
  it('gives the same world whatever came before it', () => {
    const fresh = all.map((s) => measure(new WorldSim().settleNow(liveCards(s.cards))).hash);
    const reused = new WorldSim();
    const backwards = [...all].reverse().map((s) => measure(reused.settleNow(liveCards(s.cards))).hash).reverse();
    expect(backwards).toEqual(fresh);
  });
  it('is fully settled: settling again changes nothing', () => {
    for (const s of all) {
      const sim = new WorldSim();
      const cards = liveCards(s.cards);
      const once = measure(sim.settleNow(cards)).hash;
      // Working the world out again from where it stands, and letting it run, must not move anything.
      sim.step(cards, true, 1 / 60);
      for (let i = 0; i < 600; i++) sim.step(cards, false, 1 / 60);
      expect(measure(sim.frame).hash, s.name).toBe(once);
    }
  });
  it('is where the animated world ends up, at any frame rate', () => {
    for (const code of ['water', 'water*3', 'life+water', 'mountain+water', 'water*3@0.3,0.3+life@0.8,0.6', 'mountain+water+sun+ice+life']) {
      const placements = parseCode(code);
      const settled = measure(new WorldSim().settleNow(liveCards(placements)));
      for (const fps of [60, 24]) {
        const store = new CardStore();
        const sim = new WorldSim();
        sim.step(store.cards, store.moving, 1 / fps); // the empty world first, as in the app
        for (const p of placements) store.addSim(p.id, p.x, p.y);
        for (let i = 0; i < fps * 30; i++) {
          store.update(1 / fps);
          sim.step(store.cards, store.moving, 1 / fps);
        }
        const live = measure(sim.frame);
        for (const key of ['flooded', 'fresh', 'rain', 'snow', 'forest', 'frozen', 'desert'] as const) {
          expect(Math.abs(live[key] - settled[key]), `${code} @${fps}fps ${key}`).toBeLessThan(0.15);
        }
      }
    }
  });
});
