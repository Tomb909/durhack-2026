import { describe, expect, it } from 'vitest';
import { BUILT_IN_IDS, CARD_DEFS, registerCard } from '../cards/defs';
import { CardStore } from '../cards/store';
import { cleanCard } from '../cards/words';
import { WorldSim } from '../sim/world';
import { nameOf, parseCode, resolveScenarios, tidyCode } from './codes';
import { combinations, countCombinations, defaultFilter } from './filter';
import { liveCards, measure } from './metrics';

// Two cards made from typed words, as the model might describe them: one that pushes on the
// world (both ways), changes the air and stands objects on the shore; one that is only an object.
const MUD = cleanCard({
  word: 'mud', origin: 'llm', icon: '🟤', color: '#6b4f33', reading: 'Wet, dead, sunken ground with reeds.',
  effects: [
    { field: 'wetness', amount: 0.45, radius: 0.16 }, { field: 'life', amount: -0.8, radius: 0.18 },
    { field: 'height', amount: -0.05, radius: 0.12 }, { field: 'temperature', amount: -0.1, radius: 0.2 },
  ],
  atmosphere: { tint: '#6b5a40', strength: 0.3, light: -0.2, particles: { motion: 'drift', color: '#b8a888', size: 0.8, density: 0.5, glow: false } },
  prop: { parts: [{ shape: 'cylinder', at: [0, 0.3, 0], size: [0.05, 0.6, 0.05], rotate: [0, 0, 5], color: '#6f7a3a' }], scale: 'small', count: 'many', habitat: 'shore', motion: 'sway', glow: false },
})!;
const HAUNTED = cleanCard({
  word: 'haunted house', origin: 'llm', icon: '👻', color: '#4c4652', reading: 'A dark house.',
  prop: { parts: [{ shape: 'box', at: [0, 0.25, 0], size: [0.7, 0.5, 0.45], rotate: [0, 0, 0], color: '#4c4652' }], scale: 'medium', count: 'one', habitat: 'land', motion: 'still', glow: false },
})!;
// A place: landforms that end at their radius, lava, and a biome.
const NETHER = cleanCard({
  word: 'the nether', origin: 'llm', icon: '🔥', color: '#6e2a2e', reading: 'Netherrack round a lava lake.',
  effects: [
    { field: 'height', amount: -0.03, radius: 0.22, shape: 'flat' }, { field: 'lava', amount: 1, radius: 0.17, shape: 'flat' },
    { field: 'height', amount: 0.1, radius: 0.3, shape: 'spires' }, { field: 'temperature', amount: 0.8, radius: 0.3, shape: 'flat' },
    { field: 'wetness', amount: -0.9, radius: 0.3, shape: 'flat' }, { field: 'life', amount: -1, radius: 0.3, shape: 'flat' },
  ],
  biome: { ground: '#6e2a2e', strength: 0.95, radius: 0.32, rock: '#4a1c20', liquid: { color: '#ff6a1a', glow: 1 }, trees: false },
})!;
registerCard(MUD);
registerCard(NETHER);
registerCard(HAUNTED);

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
    // A card's word, or another word it answers to, means the card: HOT and COLD are `sun` and `ice`.
    expect(parseCode('hot+cold+water').map((c) => c.id)).toEqual(['sun', 'ice', 'rain']);
    expect(() => parseCode('r')).toThrow(/could be rain or river or ravine/);
    expect(() => parseCode('l')).toThrow(/could be lake or lava/);
    expect(() => parseCode('fog')).toThrow(/no card called/);
  });
  it('reads cards made from words by their full id, and the shorthand still means only built-in cards', () => {
    // MUD exists, yet `m` is still MOUNTAIN, and `h` is not HAUNTED HOUSE.
    expect(parseCode('m+rai').map((c) => c.id)).toEqual(['mountain', 'rain']);
    expect(parseCode('mud+haunted-house*2').map((c) => c.id)).toEqual(['mud', 'haunted-house', 'haunted-house']);
    expect(() => parseCode('haunted')).toThrow(/no card called/);
    expect(tidyCode('Mud_rain x3')).toBe('mud+rain*3');
  });
  it('keeps the ready-made sets to built-in cards; made cards have their own', () => {
    expect(resolveScenarios({ set: 'subsets' }).every((s) => s.cards.every((c) => BUILT_IN_IDS.has(c.id)))).toBe(true);
    expect(resolveScenarios({ set: 'words' }).map((s) => s.code)).toEqual(['mud', 'the-nether', 'haunted-house']);
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
    // Modifiers and compound cards are not mixed in, nor are cards made from words (they have their own set).
    expect(subsets.length).toBe(2 ** CARD_DEFS.filter((d) => !d.modifier && !d.compound && BUILT_IN_IDS.has(d.id)).length);
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
  it('"only with" keeps the combinations that include every marked card', () => {
    const list = combinations({ off: [], copies: {}, only: ['forest'] }, ids);
    expect(list.length).toBe(16);
    expect(list.every((s) => s.cards.some((c) => c.id === 'forest'))).toBe(true);
    expect(combinations({ off: [], copies: {}, only: ['forest', 'sun'] }, ids).length).toBe(8);
    expect(combinations({ off: ['forest'], copies: {}, only: ['forest'] }, ids).length).toBe(16); // a card switched off is not "only"
  });
  it('counts and lists just the first few of a great many', () => {
    const many = Array.from({ length: 30 }, (_, k) => `card${k}`);
    expect(countCombinations(defaultFilter(), many)).toBe(2 ** 30);
    const first = combinations(defaultFilter(), CARD_DEFS.map((d) => d.id), 64);
    expect(first.length).toBe(64);
    expect(first[0].code).toBe('empty');
    expect(first[1].code).toBe('mountain'); // BIG alone is not a combination
    // The same order as before: every count of cards in turn, in the cards' own order.
    const all = combinations(defaultFilter(), ids);
    expect(combinations(defaultFilter(), ids, 10)).toEqual(all.slice(0, 10));
    // Listing every combination doubles with each card, so the count is checked against a list of the first twelve.
    const some = CARD_DEFS.map((d) => d.id).slice(0, 12);
    expect(countCombinations(defaultFilter(), some)).toBe(combinations(defaultFilter(), some).length);
    expect(countCombinations({ off: [], copies: {}, only: ['big'] }, some)).toBe(combinations({ off: [], copies: {}, only: ['big'] }, some).length);
  });
  it('ignores a remembered choice for a card that no longer exists', () => {
    const list = combinations({ off: ['fog'], copies: { fog: 3 } }, ids);
    expect(list.length).toBe(32);
    expect(list.some((s) => s.code.includes('fog'))).toBe(false);
  });
});

describe('the settled world depends on the cards alone', { timeout: 30_000 }, () => {
  it('made cards change the world, stand their objects and keep every field in range', () => {
    const cards = liveCards(parseCode('mud+forest+rain'));
    const frame = new WorldSim().settleNow(cards);
    const m = measure(frame, cards);
    expect(m.objects).toBeGreaterThan(0);
    expect(m.hash).not.toBe(measure(new WorldSim().settleNow(liveCards(parseCode('forest+rain')))).hash);
    for (const v of frame.vegetation) expect(v >= 0 && v <= 1).toBe(true);
    for (const v of frame.wetness) expect(v >= 0 && v <= 1).toBe(true);
    for (const v of frame.temperature) expect(v >= -1 && v <= 1).toBe(true);
    for (const v of frame.height) expect(Number.isFinite(v)).toBe(true);
  });
  it('is where the animated world ends up, at any frame rate', () => {
    for (const code of ['rain', 'rain*3', 'forest+rain', 'mountain+rain', 'rain*3@0.3,0.3+forest@0.8,0.6', 'mountain+rain+sun+ice+forest', 'ravine+rain', 'lava+ravine', 'mountain+lava+rain', 'mud+forest+rain', 'mud*3+mountain']) {
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
        for (const key of ['flooded', 'fresh', 'rain', 'snow', 'forest', 'frozen', 'desert', 'lava'] as const) {
          expect(Math.abs(live[key] - settled[key]), `${code} @${fps}fps ${key}`).toBeLessThan(0.15);
        }
      }
    }
  });
});
