import { describe, expect, it } from 'vitest';
import { CARD_DEFS } from '../cards/defs';
import { CardStore } from '../cards/store';
import { WorldSim } from '../sim/world';
import { nameOf, parseCode, resolveScenarios, tidyCode } from './codes';
import { combinations, defaultFilter } from './filter';
import { liveCards, measure } from './metrics';

describe('combination codes', () => {
  it('reads cards, copies and positions', () => {
    expect(parseCode('empty')).toEqual([]);
    expect(parseCode('rain').map((c) => c.id)).toEqual(['rain']);
    expect(parseCode('rain*3').length).toBe(3);
    expect(parseCode('rain_x3').length).toBe(3);
    expect(parseCode('forest rain sun').map((c) => c.id)).toEqual(['forest', 'rain', 'sun']);
    expect(parseCode('forest@0.8,0.6')).toEqual([{ id: 'forest', x: 0.8, y: 0.6 }]);
    expect(parseCode('wind~90@0.5,0.5')).toEqual([{ id: 'wind', x: 0.5, y: 0.5, angle: Math.PI / 2 }]);
  });
  it('accepts any unambiguous start of a card id', () => {
    expect(parseCode('m+rai+su+i+f').map((c) => c.id)).toEqual(['mountain', 'rain', 'sun', 'ice', 'forest']);
    expect(() => parseCode('r')).toThrow(/could be rain or river/);
    expect(() => parseCode('lava')).toThrow(/no card called/);
  });
  it('puts copies side by side, never on top of each other', () => {
    const cards = parseCode('rain*3+forest');
    expect(new Set(cards.map((c) => `${c.x},${c.y}`)).size).toBe(4);
    expect(parseCode('rain*3')).toEqual(parseCode('rain*3')); // same code, same places
  });
  it('writes a code one standard way and names it for files', () => {
    expect(tidyCode('Forest_Rain x3')).toBe('forest+rain*3');
    expect(nameOf('rain*3+forest@0.8,0.6')).toBe('rain_x3_forest');
    expect(tidyCode('wind~90@0.5,0.5')).toBe('wind~90@0.5,0.5');
    expect(nameOf('wind~90@0.5,0.5')).toBe('wind_90deg');
  });
  it('lists every combination of cards exactly once', () => {
    const subsets = resolveScenarios({ set: 'subsets' });
    expect(subsets.length).toBe(2 ** CARD_DEFS.filter((d) => !d.modifier).length); // modifiers are not in the ready-made sets
    expect(new Set(subsets.map((s) => s.code)).size).toBe(subsets.length);
    expect(resolveScenarios({}).length).toBeGreaterThan(10); // the showcase
    expect(resolveScenarios({ codes: 'flood=rain*3; forest+sun' }).map((s) => s.name)).toEqual(['flood', 'forest_sun']);
  });
});

describe('the Combinations view filter', () => {
  const ids = ['mountain', 'rain', 'sun', 'ice', 'forest'];
  it('shows every combination when every card is on', () => {
    const all = combinations(defaultFilter(), ids);
    expect(all.length).toBe(32);
    expect(all[0].code).toBe('empty');
    expect(new Set(all.map((s) => s.code)).size).toBe(32);
  });
  it('omits standalone modifiers but keeps them with a card they can modify', () => {
    const all = combinations(defaultFilter(), CARD_DEFS.map((d) => d.id));
    expect(all.some((scenario) => scenario.code === 'big')).toBe(false);
    expect(all.some((scenario) => scenario.code === 'big+rain')).toBe(true);
  });
  it('halves the list for each card switched off', () => {
    const list = combinations({ off: ['ice', 'sun'], copies: {} }, ids);
    expect(list.length).toBe(8);
    expect(list.some((s) => s.cards.some((c) => c.id === 'ice' || c.id === 'sun'))).toBe(false);
    expect(combinations({ off: ids, copies: {} }, ids).map((s) => s.code)).toEqual(['empty']);
  });
  it('gives a card its own number of copies', () => {
    const list = combinations({ off: ['mountain', 'sun', 'ice'], copies: { rain: 3 } }, ids);
    expect(list.map((s) => s.code)).toEqual(['empty', 'rain*3', 'forest', 'rain*3+forest']);
    expect(list[3].cards.filter((c) => c.id === 'rain').length).toBe(3);
  });
  it('ignores a remembered choice for a card that no longer exists', () => {
    const list = combinations({ off: ['lava'], copies: { lava: 3 } }, ids);
    expect(list.length).toBe(32);
    expect(list.some((s) => s.code.includes('lava'))).toBe(false);
  });
});

describe('the settled world depends on the cards alone', { timeout: 30_000 }, () => {
  it('is where the animated world ends up, at any frame rate', () => {
    for (const code of ['rain', 'rain*3', 'forest+rain', 'mountain+rain', 'rain*3@0.3,0.3+forest@0.8,0.6', 'mountain+rain+sun+ice+forest']) {
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
