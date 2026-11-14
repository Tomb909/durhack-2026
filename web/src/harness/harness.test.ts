import { describe, expect, it } from 'vitest';
import { CARD_DEFS, isEvent } from '../cards/defs';
import { CardStore } from '../cards/store';
import { WorldSim } from '../sim/world';
import { nameOf, parseCode, resolveScenarios, tidyCode } from './codes';
import { combinations, defaultFilter } from './filter';
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
    expect(subsets.length).toBe(2 ** CARD_DEFS.filter((d) => !d.modifier && !isEvent(d)).length); // modifiers and action cards are not in the ready-made sets
    expect(new Set(subsets.map((s) => s.code)).size).toBe(subsets.length);
    expect(resolveScenarios({}).length).toBeGreaterThan(10); // the showcase
    expect(resolveScenarios({ codes: 'flood=water*3; life+sun' }).map((s) => s.name)).toEqual(['flood', 'life_sun']);
  });
});

describe('the Combinations view filter', () => {
  const ids = ['mountain', 'water', 'sun', 'ice', 'life'];
  it('shows every combination when every card is on', () => {
    const all = combinations(defaultFilter(), ids);
    expect(all.length).toBe(32);
    expect(all[0].code).toBe('empty');
    expect(new Set(all.map((s) => s.code)).size).toBe(32);
  });
  it('omits standalone modifiers but keeps them with a card they can modify', () => {
    const all = combinations(defaultFilter(), CARD_DEFS.map((d) => d.id));
    expect(all.some((scenario) => scenario.code === 'big')).toBe(false);
    expect(all.some((scenario) => scenario.code === 'big+water')).toBe(true);
  });
  it('halves the list for each card switched off', () => {
    const list = combinations({ off: ['ice', 'sun'], copies: {} }, ids);
    expect(list.length).toBe(8);
    expect(list.some((s) => s.cards.some((c) => c.id === 'ice' || c.id === 'sun'))).toBe(false);
    expect(combinations({ off: ids, copies: {} }, ids).map((s) => s.code)).toEqual(['empty']);
  });
  it('gives a card its own number of copies', () => {
    const list = combinations({ off: ['mountain', 'sun', 'ice'], copies: { water: 3 } }, ids);
    expect(list.map((s) => s.code)).toEqual(['empty', 'water*3', 'life', 'water*3+life']);
    expect(list[3].cards.filter((c) => c.id === 'water').length).toBe(3);
  });
  it('ignores a remembered choice for a card that no longer exists', () => {
    const list = combinations({ off: ['lava'], copies: { lava: 3 } }, ids);
    expect(list.length).toBe(32);
    expect(list.some((s) => s.code.includes('lava'))).toBe(false);
  });
});

// These run every combination of cards (2^cards), so they get slower with each new card.
describe('the settled world depends on the cards alone', { timeout: 30_000 }, () => {
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
      // Felled forest is meant to build up as time runs (the land remembers), so it is set aside here:
      // everything that comes from the cards alone must be unchanged.
      sim.frame.cleared.fill(0);
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
